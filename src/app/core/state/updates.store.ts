import { Injectable, signal } from '@angular/core';

import { IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import type { ChangelogRelease, UpdateInfo } from '../ipc/tauri.types';

/**
 * Update availability + install progress + changelog cache.
 *
 * `checkSilently()` is the startup probe — failures (offline, first-release
 * 404) are swallowed. `check()` surfaces errors for the manual button.
 */
@Injectable({ providedIn: 'root' })
export class UpdatesStore {
  constructor(
    private readonly commands: IpcCommands,
    private readonly events: IpcEvents,
  ) {}

  private readonly _info = signal<UpdateInfo | null>(null);
  /** Download progress 0..1 while installing, or null when idle. */
  private readonly _progress = signal<number | null>(null);
  private readonly _installing = signal(false);
  private changelogCache: ChangelogRelease[] | null = null;

  readonly info = this._info.asReadonly();
  readonly progress = this._progress.asReadonly();
  readonly installing = this._installing.asReadonly();

  available(): boolean {
    return this._info()?.available ?? false;
  }

  /** Manual check — propagates errors to the caller. */
  async check(): Promise<void> {
    this._info.set(await this.commands.updates.check());
  }

  /** Startup check — swallows errors (offline / no release yet). */
  async checkSilently(): Promise<void> {
    try {
      await this.check();
    } catch {
      this._info.set(null);
    }
  }

  /** Subscribe to download progress; call once during app init. */
  async listenProgress(): Promise<void> {
    await this.events.onUpdateProgress((e) => {
      this._progress.set(
        e.contentLength && e.contentLength > 0
          ? e.downloaded / e.contentLength
          : null,
      );
    });
  }

  /** Download + install + restart. Throws on failure. */
  async install(): Promise<void> {
    if (this._installing()) {
      return;
    }
    this._installing.set(true);
    this._progress.set(0);
    try {
      await this.commands.updates.install();
      // On success the app restarts; this line is effectively unreachable.
    } finally {
      this._installing.set(false);
      this._progress.set(null);
    }
  }

  /** Parsed changelog history, cached after the first load. */
  async loadChangelog(): Promise<ChangelogRelease[]> {
    if (this.changelogCache === null) {
      this.changelogCache = await this.commands.updates.changelog();
    }
    return this.changelogCache;
  }
}
