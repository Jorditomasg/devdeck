/**
 * Typed event subscriptions — mirrors `src-tauri/src/events.rs` constants
 * one-to-one (ipc-contract.md §3). Only Rust emits these; the frontend only
 * listens. Each wrapper resolves to the `UnlistenFn` handle so consumers can
 * tear subscriptions down (stores keep them for the app's lifetime).
 */
import { Injectable } from '@angular/core';

import { TauriBridge, type UnlistenFn } from './tauri-bridge';
import type {
  DockerStatusEvent,
  GitBadgeEvent,
  ScanProgressEvent,
  ServiceLogEvent,
  ServiceStatusEvent,
  SingleInstanceEvent,
} from './tauri.types';

/**
 * Event name registry — values MUST stay byte-identical to the constants in
 * `src-tauri/src/events.rs` (the single Rust source of truth).
 */
export const EVT = {
  /** events.rs `SERVICE_STATUS_CHANGED` */
  serviceStatusChanged: 'service://status-changed',
  /** events.rs `SERVICE_LOG_LINE` (batched, ANSI-stripped) */
  serviceLogLine: 'service://log-line',
  /** events.rs `REPO_SCAN_PROGRESS` */
  repoScanProgress: 'repo://scan-progress',
  /** events.rs `GIT_BADGE` (30 s poll loop, inventory-gui.md §28) */
  gitBadge: 'git://badge',
  /** events.rs `DOCKER_STATUS` (15 s poll loop) */
  dockerStatus: 'docker://status',
  /** events.rs `APP_SINGLE_INSTANCE` */
  appSingleInstance: 'app://single-instance',
  /**
   * events.rs `APP_CLOSE_REQUESTED` — emitted instead of closing while
   * services run; the frontend answers with `app_exit { force }` (§2.1
   * lifecycle extensions).
   */
  appCloseRequested: 'app://close-requested',
} as const;

/** Union of all wire event names. */
export type EventName = (typeof EVT)[keyof typeof EVT];

@Injectable({ providedIn: 'root' })
export class IpcEvents {
  constructor(private readonly bridge: TauriBridge) {}

  /** Service lifecycle transitions (6-state model, ipc-contract.md §1.4). */
  onServiceStatusChanged(
    handler: (event: ServiceStatusEvent) => void,
  ): Promise<UnlistenFn> {
    return this.bridge.listen(EVT.serviceStatusChanged, handler);
  }

  /** Batched log lines (~75 ms / 64 lines per flush). */
  onServiceLogLine(
    handler: (event: ServiceLogEvent) => void,
  ): Promise<UnlistenFn> {
    return this.bridge.listen(EVT.serviceLogLine, handler);
  }

  /** Workspace scan progress; terminal phase is `"done"`. */
  onRepoScanProgress(
    handler: (event: ScanProgressEvent) => void,
  ): Promise<UnlistenFn> {
    return this.bridge.listen(EVT.repoScanProgress, handler);
  }

  /** Per-repo git badge refresh results (poll loop lives in Rust). */
  onGitBadge(handler: (event: GitBadgeEvent) => void): Promise<UnlistenFn> {
    return this.bridge.listen(EVT.gitBadge, handler);
  }

  /** Per-repo docker compose status (poll loop lives in Rust). */
  onDockerStatus(
    handler: (event: DockerStatusEvent) => void,
  ): Promise<UnlistenFn> {
    return this.bridge.listen(EVT.dockerStatus, handler);
  }

  /** A second app instance launched; payload carries its argv/cwd. */
  onAppSingleInstance(
    handler: (event: SingleInstanceEvent) => void,
  ): Promise<UnlistenFn> {
    return this.bridge.listen(EVT.appSingleInstance, handler);
  }

  /**
   * Close intercepted while services run (no payload). The listener is
   * expected to confirm with the user and answer via `IpcCommands.appExit`.
   */
  onAppCloseRequested(handler: () => void): Promise<UnlistenFn> {
    return this.bridge.listen(EVT.appCloseRequested, handler);
  }

  /**
   * THIS window's close request (terminal windows): the close waits for the
   * async `handler` so the PTY can be killed (`close_terminal`) before the
   * window goes away. Not a Rust-emitted bus event — it wraps the window's
   * own close lifecycle.
   */
  onWindowCloseRequested(
    handler: () => Promise<void> | void,
  ): Promise<UnlistenFn> {
    return this.bridge.onCurrentWindowCloseRequested(handler);
  }
}
