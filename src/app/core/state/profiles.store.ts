/**
 * Workspace profiles — list per group, active profile, and the snapshot used
 * for dirty detection.
 *
 * Responsibility split (deliberate): this store owns the LAST
 * LOADED/SAVED snapshot and the comparison primitives
 * ({@link profileReposEqual}); building the "current" `ProfileDocument` from
 * live card state and deciding WHEN to compare (the 300 ms debounce of
 * inventory-gui.md §28) belongs to the workspace feature task.
 *
 * v1 semantics preserved: profiles live per group with the Default group at
 * the store root (inventory-backend.md §15.1); the java sentinel
 * `"Sistema (Por Defecto)"` compares equal to "system default"
 * (architecture-v2.md §6).
 */
import { Injectable, computed, signal } from '@angular/core';

import { IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import type {
  MissingRepo,
  ProfileApplyReport,
  ProfileDocument,
  RepoProfile,
} from '../ipc/tauri.types';

/** v1 Spanish sentinel for "system-default Java" — accepted forever. */
export const JAVA_SYSTEM_DEFAULT_SENTINEL = 'Sistema (Por Defecto)';

/** Fold the v1 java sentinel and empty string into `undefined`. */
export function normalizeJavaVersion(value: string | undefined): string | undefined {
  if (!value || value === JAVA_SYSTEM_DEFAULT_SENTINEL) {
    return undefined;
  }
  return value;
}

/**
 * Semantic equality of two per-repo profile entries: java sentinel
 * normalized, array order significant for tracked files (v1 captured them in
 * a stable order), object key order NOT significant.
 */
export function repoProfileEquals(a: RepoProfile, b: RepoProfile): boolean {
  return (
    a.git_url === b.git_url &&
    (a.branch ?? null) === (b.branch ?? null) &&
    a.type === b.type &&
    (a.profile ?? null) === (b.profile ?? null) &&
    sameArray(a.profile_tracked, b.profile_tracked) &&
    (a.command_profile ?? null) === (b.command_profile ?? null) &&
    normalizeJavaVersion(a.java_version) === normalizeJavaVersion(b.java_version) &&
    a.selected === b.selected &&
    sameArray(a.docker_compose_active ?? [], b.docker_compose_active ?? []) &&
    sameStringListRecord(
      a.docker_profile_services ?? {},
      b.docker_profile_services ?? {},
    )
  );
}

/**
 * Current-vs-snapshot comparison primitive for dirty detection. Compares the
 * `repos` maps only — `name`/`created` metadata and config-file snapshots are
 * ignored (v1 dirty check compared live card state, not file contents).
 */
export function profileReposEqual(
  a: ProfileDocument | null,
  b: ProfileDocument | null,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  const aNames = Object.keys(a.repos).sort();
  const bNames = Object.keys(b.repos).sort();
  if (!sameArray(aNames, bNames)) {
    return false;
  }
  return aNames.every((name) => {
    const ra = a.repos[name];
    const rb = b.repos[name];
    return ra !== undefined && rb !== undefined && repoProfileEquals(ra, rb);
  });
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameStringListRecord(
  a: Readonly<Record<string, readonly string[]>>,
  b: Readonly<Record<string, readonly string[]>>,
): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (!sameArray(aKeys, bKeys)) {
    return false;
  }
  return aKeys.every((k) => {
    const va = a[k];
    const vb = b[k];
    return va !== undefined && vb !== undefined && sameArray(va, vb);
  });
}

@Injectable({ providedIn: 'root' })
export class ProfilesStore {
  private readonly _profiles = signal<readonly string[]>([]);
  private readonly _group = signal<string | undefined>(undefined);
  private readonly _activeProfileName = signal<string | null>(null);
  private readonly _snapshot = signal<ProfileDocument | null>(null);
  private readonly _busy = signal(false);

  /** Profile names of the currently listed group. */
  readonly profiles = this._profiles.asReadonly();

  /** Group the list belongs to (`undefined` = Default group). */
  readonly group = this._group.asReadonly();

  /** Name of the last loaded/saved profile (`null` = none). */
  readonly activeProfileName = this._activeProfileName.asReadonly();

  /**
   * Snapshot of the last loaded/saved profile — the dirty-detection
   * baseline. Feature code compares its live state against this via
   * {@link isDirtyAgainst}.
   */
  readonly snapshot = this._snapshot.asReadonly();

  /** True while a profile IPC operation is in flight. */
  readonly busy = this._busy.asReadonly();

  /** True when a baseline snapshot exists to compare against. */
  readonly hasSnapshot = computed(() => this._snapshot() !== null);

  constructor(
    private readonly commands: IpcCommands,
    private readonly events: IpcEvents,
  ) {}

  /**
   * Subscribe to cross-window profile changes. Called from the app
   * initializer. The profile manager runs in its own window with its own
   * store instance, so a save/delete there must re-list HERE (the main
   * window's dropdown) — Rust broadcasts `profiles://changed` and we reload
   * the group this store is currently showing.
   */
  async init(): Promise<void> {
    await this.events.onProfilesChanged(() => {
      void this.refresh(this._group()).catch(() => undefined);
    });
  }

  /**
   * Compare a live document against the snapshot. `true` when there IS a
   * snapshot and the repos differ (no snapshot ⇒ nothing to be dirty against).
   */
  isDirtyAgainst(current: ProfileDocument): boolean {
    const snapshot = this._snapshot();
    return snapshot !== null && !profileReposEqual(snapshot, current);
  }

  /** Reload the profile list for a group (`undefined` = Default). */
  async refresh(group?: string): Promise<readonly string[]> {
    const names = await this.commands.profiles.listProfiles(group);
    this._group.set(group);
    this._profiles.set(names);
    return names;
  }

  /** Load a profile and adopt it as the dirty baseline. `null` = not found. */
  async load(name: string, group?: string): Promise<ProfileDocument | null> {
    this._busy.set(true);
    try {
      const doc = await this.commands.profiles.loadProfile(name, group);
      if (doc) {
        this._activeProfileName.set(name);
        this._snapshot.set(doc);
      }
      return doc;
    } finally {
      this._busy.set(false);
    }
  }

  /**
   * Save the document (Rust injects name/created and optionally enriches
   * with config-file snapshots) and adopt it as the new baseline.
   */
  async save(args: {
    name: string;
    group?: string;
    doc: ProfileDocument;
    includeConfigFiles: boolean;
  }): Promise<string> {
    this._busy.set(true);
    try {
      const path = await this.commands.profiles.saveProfile(args);
      this._activeProfileName.set(args.name);
      this._snapshot.set(args.doc);
      await this.refresh(args.group);
      return path;
    } finally {
      this._busy.set(false);
    }
  }

  async delete(name: string, group?: string): Promise<boolean> {
    const deleted = await this.commands.profiles.deleteProfile(name, group);
    if (deleted) {
      if (this._activeProfileName() === name) {
        this._activeProfileName.set(null);
        this._snapshot.set(null);
      }
      await this.refresh(group);
    }
    return deleted;
  }

  /** Import a shared `.json` (rejects without `repos` key, v1 §15.2). */
  importFromFile(srcPath: string): Promise<ProfileDocument> {
    return this.commands.profiles.importProfile(srcPath);
  }

  exportToFile(doc: ProfileDocument, destPath: string): Promise<void> {
    return this.commands.profiles.exportProfile(doc, destPath);
  }

  /** Clone-missing planning (branch defaults to `main`, §15.4). */
  missingRepos(
    workspaceDir: string,
    doc: ProfileDocument,
  ): Promise<MissingRepo[]> {
    return this.commands.profiles.getMissingRepos(workspaceDir, doc);
  }

  /** Apply config_files/saved_environments; returns `repetidoN` renames. */
  applyEnvironments(
    doc: ProfileDocument,
    workspaceDir: string,
  ): Promise<ProfileApplyReport> {
    return this.commands.profiles.applyProfileEnvironments(doc, workspaceDir);
  }
}
