/**
 * Repository list + scanning state + per-repo git badges.
 *
 * Detection and the 30 s badge poll loop live in Rust (architecture-v2.md
 * §2-3): this store only fires `scan_workspace`, renders
 * `repo://scan-progress`, and folds `git://badge` events into a name → badge
 * map. The frontend NEVER polls (inventory-gui.md §28 timing table is a
 * Rust-side contract now).
 */
import { Injectable, computed, signal } from '@angular/core';

import { IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import type {
  GitBadge,
  GitBadgeEvent,
  RepoInfo,
  ScanProgressEvent,
} from '../ipc/tauri.types';

@Injectable({ providedIn: 'root' })
export class ReposStore {
  private readonly _repos = signal<readonly RepoInfo[]>([]);
  private readonly _scanning = signal(false);
  private readonly _scanProgress = signal<ScanProgressEvent | null>(null);
  private readonly _badges = signal<Readonly<Record<string, GitBadge>>>({});

  /** Detected repos, alphabetical (order preserved Rust-side, §6.2 backend). */
  readonly repos = this._repos.asReadonly();

  /** True while a `scan_workspace` is in flight (statusbar "Scanning…"). */
  readonly scanning = this._scanning.asReadonly();

  /** Last scan progress payload (`null` before the first scan). */
  readonly scanProgress = this._scanProgress.asReadonly();

  /** Per-repo git badge map, fed by the Rust 30 s poll loop. */
  readonly badges = this._badges.asReadonly();

  /** Repo names with docker compose support (docker poller targets). */
  readonly dockerRepoNames = computed(() =>
    this._repos()
      .filter((r) => r.dockerComposeFiles.length > 0)
      .map((r) => r.name),
  );

  constructor(
    private readonly commands: IpcCommands,
    private readonly events: IpcEvents,
  ) {}

  /** Subscribe to scan/badge events. Called once from the app initializer. */
  async init(): Promise<void> {
    await Promise.all([
      this.events.onRepoScanProgress((e) => this.applyScanProgress(e)),
      this.events.onGitBadge((e) => this.applyBadge(e)),
    ]);
  }

  /**
   * Scan the given workspace roots (the active group's paths from
   * `SettingsStore`). Replaces the repo list and clears stale badges; Rust
   * re-targets its badge/docker pollers as a side effect (ipc-contract §2.2).
   */
  async scan(paths: readonly string[]): Promise<readonly RepoInfo[]> {
    this._scanning.set(true);
    try {
      const repos = await this.commands.detection.scanWorkspace(paths);
      this._repos.set(repos);
      const names = new Set(repos.map((r) => r.name));
      this._badges.update((badges) =>
        Object.fromEntries(
          Object.entries(badges).filter(([name]) => names.has(name)),
        ),
      );
      return repos;
    } finally {
      this._scanning.set(false);
    }
  }

  /** Force one badge poll for a repo; the result arrives as `git://badge`. */
  async refreshBadge(repoPath: string): Promise<void> {
    await this.commands.git.refreshBadge(repoPath);
  }

  /** Lookup helper: repo by name (`undefined` when not detected). */
  repoByName(name: string): RepoInfo | undefined {
    return this._repos().find((r) => r.name === name);
  }

  private applyScanProgress(event: ScanProgressEvent): void {
    this._scanProgress.set(event);
    if (event.phase === 'done') {
      this._scanning.set(false);
    }
  }

  private applyBadge(event: GitBadgeEvent): void {
    const { name, ...badge } = event;
    this._badges.update((badges) => ({ ...badges, [name]: badge }));
  }
}
