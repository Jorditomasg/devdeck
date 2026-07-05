/**
 * Detached log window content — the v1 detached log CTkToplevel
 * (inventory-gui.md §5/§8) as a real OS window.
 *
 * Rendered INSTEAD of the workspace page when the SPA is loaded with
 * `?log=<serviceId>` (see `app.component.ts`); the window itself is created
 * Rust-side by the `open_log_window` command. The buffer is local to this
 * window: seeded once from the Rust `LogCache` backlog (`get_log_backlog`),
 * then appended from live `service://log-line` events — for the
 * `GLOBAL_LOG_ID` aggregate every service's lines are shown with the same
 * `[name] ` prefix the cache uses.
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TranslationService } from '../../../core/i18n/translation.service';
import { GLOBAL_LOG_ID, IpcCommands } from '../../../core/ipc/commands';
import { IpcEvents } from '../../../core/ipc/events';
import { ButtonComponent, IconComponent, LogViewerComponent } from '../../../ui';

/** Detached windows can afford a deeper buffer than the in-card viewer. */
const DETACHED_LINE_CAP = 5000;

/** Prefix marking a docker live-log id (mirrors Rust `DOCKER_LOG_PREFIX`). */
const DOCKER_LOG_PREFIX = 'docker::';

/** Tail requested by "Load full history" — effectively `--tail all`. */
const FULL_TAIL = 100_000;

@Component({
  selector: 'log-window',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, LogViewerComponent],
  styleUrl: './log-window.component.scss',
  template: `
    <header class="logwin__header">
      <span class="logwin__title">{{ title() }}</span>
      <span class="logwin__spacer"></span>
      @if (isDocker()) {
        <ui-button
          variant="log-action"
          size="sm"
          [loading]="fullLoading()"
          (clicked)="toggleFull()"
        >
          {{ i18n.t(showingFull() ? 'docker.btn_live_logs' : 'docker.btn_full_logs') }}
        </ui-button>
      }
      <ui-button variant="log-action" size="sm" (clicked)="onCopy()">
        <ui-icon name="copy" [size]="13" /> {{ i18n.t('btn.copy_log') }}
      </ui-button>
      <ui-button variant="log-action" size="sm" (clicked)="onClear()">
        <ui-icon name="trash" [size]="13" /> {{ i18n.t('btn.clear_log') }}
      </ui-button>
    </header>
    <ui-log-viewer
      class="logwin__view"
      [lines]="viewLines()"
      [startIndex]="showingFull() ? 0 : dropped()"
      [maxLines]="showingFull() ? viewLines().length : cap"
      [emptyText]="i18n.t('label.log_empty')"
    />
  `,
})
export class LogWindowComponent implements OnInit, OnDestroy {
  protected readonly i18n = inject(TranslationService);
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);

  /** Service id from the `?log=` query param (set by app.component). */
  readonly serviceId = signal('');

  protected readonly cap = DETACHED_LINE_CAP;
  protected readonly lines = signal<readonly string[]>([]);
  /** Lines trimmed from the head — keeps log-viewer track keys stable. */
  protected readonly dropped = signal(0);

  protected readonly title = computed(() =>
    this.serviceId() === GLOBAL_LOG_ID
      ? this.i18n.t('label.global_log_section')
      : this.serviceId(),
  );

  /** True for docker log windows — unlocks the "Load full history" toggle. */
  protected readonly isDocker = computed(() =>
    this.serviceId().startsWith(DOCKER_LOG_PREFIX),
  );

  /** Full `--tail all` snapshot while "Load full history" is active, else null. */
  private readonly full = signal<readonly string[] | null>(null);
  protected readonly fullLoading = signal(false);
  protected readonly showingFull = computed(() => this.full() !== null);
  /** Lines to render: the full-history snapshot, else the live buffer. */
  protected readonly viewLines = computed<readonly string[]>(
    () => this.full() ?? this.lines(),
  );

  private unlisten: (() => void) | null = null;
  /** Non-empty while this window holds a docker `logs -f` follower open. */
  private dockerId = '';

  async ngOnInit(): Promise<void> {
    const id = new URLSearchParams(window.location.search).get('log') ?? '';
    this.serviceId.set(id);
    document.title = `${this.title()} — DevDeck`;

    // Subscribe BEFORE seeding so no line can fall between backlog and live.
    // (A line in both would be a rare dup — v1 accepted the same.)
    this.unlisten = await this.events.onServiceLogLine((e) => {
      const isGlobal = id === GLOBAL_LOG_ID;
      if (!isGlobal && e.name !== id) {
        return;
      }
      const incoming = isGlobal ? e.lines.map((l) => `[${e.name}] ${l}`) : e.lines;
      this.append(incoming);
    });
    // Docker logs are lazy: a detached window is a viewer, so it must keep the
    // `logs -f` follower alive (ref-counted with the dialog panel) while open.
    if (id.startsWith(DOCKER_LOG_PREFIX)) {
      this.dockerId = id;
      await this.commands.docker
        .logStart(id)
        .catch((err: unknown) => console.error('docker log start failed', err));
    }
    try {
      const backlog = await this.commands.getLogBacklog(id);
      this.lines.update((live) => [...backlog, ...live]);
    } catch (err: unknown) {
      console.error('log backlog unavailable', err);
    }
  }

  ngOnDestroy(): void {
    this.unlisten?.();
    if (this.dockerId !== '') {
      void this.commands.docker
        .logStop(this.dockerId)
        .catch((err: unknown) => console.error('docker log stop failed', err));
    }
  }

  protected onCopy(): void {
    void navigator.clipboard.writeText(this.viewLines().join('\n'));
  }

  protected onClear(): void {
    this.lines.set([]);
    this.dropped.set(0);
  }

  /** Toggle between the live tail and the full `--tail all` history snapshot. */
  protected async toggleFull(): Promise<void> {
    if (this.full() !== null) {
      this.full.set(null);
      return;
    }
    const parsed = parseDockerLogId(this.serviceId());
    if (parsed === null || this.fullLoading()) {
      return;
    }
    this.fullLoading.set(true);
    try {
      const text = await this.commands.docker.composeLogs(
        parsed.file,
        parsed.service,
        FULL_TAIL,
      );
      this.full.set(text.split('\n'));
    } catch (err: unknown) {
      this.full.set([describe(err)]);
    } finally {
      this.fullLoading.set(false);
    }
  }

  private append(incoming: readonly string[]): void {
    this.lines.update((current) => {
      const merged = [...current, ...incoming];
      const overflow = merged.length - DETACHED_LINE_CAP;
      if (overflow > 0) {
        this.dropped.update((d) => d + overflow);
        return merged.slice(overflow);
      }
      return merged;
    });
  }
}

/**
 * Split a docker log id into its compose file and service — mirrors the Rust
 * `parse_docker_log_id` (`docker/logs.rs`): `docker::<file>::<service>`, last
 * `::` separates file from service (empty service = whole stack).
 */
function parseDockerLogId(id: string): { file: string; service: string } | null {
  if (!id.startsWith(DOCKER_LOG_PREFIX)) {
    return null;
  }
  const rest = id.slice(DOCKER_LOG_PREFIX.length);
  const sep = rest.lastIndexOf('::');
  if (sep === -1) {
    return null;
  }
  return { file: rest.slice(0, sep), service: rest.slice(sep + 2) };
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
