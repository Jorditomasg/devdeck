/**
 * Per-service runtime state + log ring buffers.
 *
 * Mirrors the Rust process registry (the source of truth — the frontend can
 * be killed and restarted without losing a running service,
 * architecture-v2.md §2): hydrates from `list_services` on init, then tracks
 * `service://status-changed` and `service://log-line` events.
 *
 * Log trim contract (inventory-gui.md §28 — values must survive migration):
 * - 500 lines per service ring buffer (`LOG_MAX_LINES`, v1 log_helpers.py:11)
 * - 1000 lines for the global log (v1 app.py:509)
 * Lines arrive pre-batched from Rust (~75 ms / 64 lines per flush,
 * ipc-contract.md §3), so appends are amortized per batch, not per line.
 */
import { Injectable, computed, signal, type Signal, type WritableSignal } from '@angular/core';

import { IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import type {
  LogStream,
  ServiceId,
  ServiceLogEvent,
  ServiceStatus,
  ServiceStatusEvent,
} from '../ipc/tauri.types';

/** Per-service log cap (inventory-gui.md §28, `LOG_MAX_LINES`). */
export const SERVICE_LOG_MAX_LINES = 500;

/** Global log cap (inventory-gui.md §28, v1 app.py:509). */
export const GLOBAL_LOG_MAX_LINES = 1000;

/** One rendered log line. */
export interface LogLine {
  readonly stream: LogStream;
  readonly line: string;
}

/** A global-log line carries the originating service id too. */
export interface GlobalLogLine extends LogLine {
  readonly name: ServiceId;
}

/** Live runtime view of one service (event-fed). */
export interface ServiceRuntime {
  readonly status: ServiceStatus;
  readonly port?: number;
  readonly pid?: number;
  readonly exitCode?: number;
  readonly error?: string;
}

/** Statuses with a live OS process (mirror of `ServiceStatus::is_active`). */
const ACTIVE_STATUSES: readonly ServiceStatus[] = [
  'starting',
  'running',
  'stopping',
  'installing',
];

/**
 * Ring-buffer append: keeps at most `cap` entries, dropping the OLDEST.
 * Pure — exported for direct unit testing (spec deliverable).
 */
export function appendCapped<T>(
  existing: readonly T[],
  additions: readonly T[],
  cap: number,
): readonly T[] {
  if (additions.length === 0) {
    return existing;
  }
  if (additions.length >= cap) {
    return additions.slice(additions.length - cap);
  }
  const merged = existing.concat(additions);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

@Injectable({ providedIn: 'root' })
export class ServicesStore {
  private readonly _services = signal<Readonly<Record<ServiceId, ServiceRuntime>>>({});
  /**
   * Per-service log signals, created lazily. The Map itself is not reactive
   * (entries are never removed and the signal reference is stable), so
   * components can safely capture `logsFor(id)` once.
   */
  private readonly _logs = new Map<ServiceId, WritableSignal<readonly LogLine[]>>();
  /**
   * Per-service count of lines dropped from the HEAD of the ring buffer
   * (trim past the 500-line cap + explicit clears). Monotonic — it is the
   * absolute line number of the buffer's first entry, so `ui-log-viewer`
   * track keys stay stable across trims (`[startIndex]` wiring).
   */
  private readonly _dropped = new Map<ServiceId, WritableSignal<number>>();
  private readonly _globalLog = signal<readonly GlobalLogLine[]>([]);

  /** All known services and their runtime state. */
  readonly services = this._services.asReadonly();

  /** Global (all-services) log, capped at {@link GLOBAL_LOG_MAX_LINES}. */
  readonly globalLog = this._globalLog.asReadonly();

  /** Count of services with a live process (tray icon color, close guard). */
  readonly activeCount = computed(
    () =>
      Object.values(this._services()).filter((s) =>
        ACTIVE_STATUSES.includes(s.status),
      ).length,
  );

  /** Count of services in `running` (tray tooltip, inventory-gui.md §27). */
  readonly runningCount = computed(
    () =>
      Object.values(this._services()).filter((s) => s.status === 'running')
        .length,
  );

  constructor(
    private readonly commands: IpcCommands,
    private readonly events: IpcEvents,
  ) {}

  /**
   * Subscribe to lifecycle/log events, then hydrate from the Rust registry.
   * Called once from the app initializer (app.config.ts).
   */
  async init(): Promise<void> {
    await Promise.all([
      this.events.onServiceStatusChanged((e) => this.applyStatus(e)),
      this.events.onServiceLogLine((e) => this.applyLogBatch(e)),
    ]);
    await this.hydrate();
  }

  /** Re-read the registry snapshot (e.g. after a frontend reload). */
  async hydrate(): Promise<void> {
    const snapshots = await this.commands.process.listServices();
    this._services.update((current) => {
      const next: Record<ServiceId, ServiceRuntime> = { ...current };
      for (const snap of snapshots) {
        next[snap.id] = {
          ...next[snap.id],
          status: snap.status,
          port: snap.port,
          pid: snap.pid,
        };
      }
      return next;
    });
  }

  /** Runtime state of one service (`stopped` when never seen — v1 default). */
  statusFor(id: ServiceId): ServiceStatus {
    return this._services()[id]?.status ?? 'stopped';
  }

  /** Reactive log buffer of one service (created empty on first access). */
  logsFor(id: ServiceId): Signal<readonly LogLine[]> {
    return this.logSignal(id).asReadonly();
  }

  /**
   * Absolute line number of the first buffered line of one service — the
   * `[startIndex]` for `ui-log-viewer` so its track keys survive ring-buffer
   * head-trims past {@link SERVICE_LOG_MAX_LINES}.
   */
  droppedFor(id: ServiceId): Signal<number> {
    return this.droppedSignal(id).asReadonly();
  }

  /** Clear one service's log panel (v1 `btn.clear_log`). */
  clearLogs(id: ServiceId): void {
    const sig = this.logSignal(id);
    const cleared = sig().length;
    sig.set([]);
    if (cleared > 0) {
      // Cleared lines count as dropped: absolute numbering stays monotonic.
      this.droppedSignal(id).update((d) => d + cleared);
    }
  }

  // -- actions (fire-and-forget; truth arrives via events) -------------------

  /**
   * Start a service. The status flips optimistically so the card reacts on
   * click (v1 set `starting` synchronously); Rust events confirm or correct.
   */
  async start(
    id: ServiceId,
    opts?: { customCommand?: string; startArgs?: string; javaLabel?: string },
  ): Promise<void> {
    this.patchService(id, { status: 'starting' });
    await this.commands.process.startService(id, opts);
  }

  async stop(id: ServiceId): Promise<void> {
    this.patchService(id, { status: 'stopping' });
    await this.commands.process.stopService(id);
  }

  async restart(
    id: ServiceId,
    opts?: { customCommand?: string; startArgs?: string; javaLabel?: string },
  ): Promise<void> {
    this.patchService(id, { status: 'stopping' });
    await this.commands.process.restartService(id, opts);
  }

  async install(
    id: ServiceId,
    reinstall: boolean,
    javaLabel?: string,
  ): Promise<void> {
    this.patchService(id, { status: 'installing' });
    await this.commands.process.installDependencies(id, reinstall, javaLabel);
  }

  async stopAll(): Promise<void> {
    await this.commands.process.stopAllServices();
  }

  // -- event reducers ---------------------------------------------------------

  private applyStatus(event: ServiceStatusEvent): void {
    this.patchService(event.name, {
      status: event.status,
      port: event.port,
      pid: event.pid,
      exitCode: event.exitCode,
      error: event.error,
    });
  }

  /** Batched append API — one signal update per IPC batch, never per line. */
  private applyLogBatch(event: ServiceLogEvent): void {
    const entries: LogLine[] = event.lines.map((line) => ({
      stream: event.stream,
      line,
    }));
    const sig = this.logSignal(event.name);
    const existing = sig();
    const next = appendCapped(existing, entries, SERVICE_LOG_MAX_LINES);
    sig.set(next);
    const dropped = existing.length + entries.length - next.length;
    if (dropped > 0) {
      this.droppedSignal(event.name).update((d) => d + dropped);
    }
    const globalEntries: GlobalLogLine[] = entries.map((e) => ({
      ...e,
      name: event.name,
    }));
    this._globalLog.update((existing) =>
      appendCapped(existing, globalEntries, GLOBAL_LOG_MAX_LINES),
    );
  }

  /**
   * Merge a partial runtime update. `undefined` values are dropped instead of
   * clearing fields — a status event without `port` must not erase the port
   * detected earlier (v1 kept the port label until the next start).
   */
  private patchService(id: ServiceId, patch: Partial<ServiceRuntime>): void {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as Partial<ServiceRuntime>;
    this._services.update((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { status: 'stopped' as const }),
        ...defined,
      },
    }));
  }

  private logSignal(id: ServiceId): WritableSignal<readonly LogLine[]> {
    let sig = this._logs.get(id);
    if (!sig) {
      sig = signal<readonly LogLine[]>([]);
      this._logs.set(id, sig);
    }
    return sig;
  }

  private droppedSignal(id: ServiceId): WritableSignal<number> {
    let sig = this._dropped.get(id);
    if (!sig) {
      sig = signal(0);
      this._dropped.set(id, sig);
    }
    return sig;
  }
}
