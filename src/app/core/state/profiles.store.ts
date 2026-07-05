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
 * Profiles live per group with the Default group at the store root.
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

/** Fold the empty string into `undefined` (= system-default Java). */
export function normalizeJavaVersion(value: string | undefined): string | undefined {
  return value || undefined;
}

/**
 * Semantic equality of two per-repo profile entries: empty java label
 * normalized, array order significant for tracked files, object key order
 * NOT significant.
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
 * Configurable per-repo fields, in display order — the ones a user tunes on a
 * card and that a save overwrites. Repo identity (`git_url`/`type`) is compared
 * for dirty detection but omitted here: it is not a "setting" worth warning
 * about in the save-overwrite preview.
 */
export const OVERWRITE_FIELDS = [
  'branch',
  'profile',
  'profile_tracked',
  'command_profile',
  'java_version',
  'selected',
  'docker_compose_active',
  'docker_profile_services',
] as const;

export type OverwriteField = (typeof OVERWRITE_FIELDS)[number];

/** One overwritten field with its stored→current values (formatted for display). */
export interface OverwriteFieldChange {
  readonly field: OverwriteField;
  /** Stored (before) value, formatted; `null` = empty/unset. */
  readonly from: string | null;
  /** Current (after) value, formatted; `null` = empty/unset. */
  readonly to: string | null;
}

/** One repo of a save-overwrite preview: which fields change (or repo-set delta). */
export interface RepoOverwriteDiff {
  readonly repo: string;
  readonly status: 'changed' | 'added' | 'removed';
  /** Changed fields with before→after values — empty for `added`/`removed`. */
  readonly fields: readonly OverwriteFieldChange[];
}

/**
 * Display value of one overwrite field (`null` = empty/unset). Language-neutral
 * on purpose — this store stays i18n-free; the dialog renders `null` as a dash.
 */
export function overwriteFieldValue(
  field: OverwriteField,
  rp: RepoProfile,
): string | null {
  switch (field) {
    case 'branch':
      return rp.branch || null;
    case 'profile':
      return rp.profile || null;
    case 'command_profile':
      return rp.command_profile || null;
    case 'java_version':
      return normalizeJavaVersion(rp.java_version) ?? null;
    case 'profile_tracked':
      return joinList(rp.profile_tracked);
    case 'docker_compose_active':
      return joinList(rp.docker_compose_active ?? []);
    case 'docker_profile_services':
      return formatServiceMap(rp.docker_profile_services ?? {});
    case 'selected':
      return rp.selected ? '✓' : null;
  }
}

function joinList(list: readonly string[]): string | null {
  return list.length > 0 ? list.join(', ') : null;
}

/** `file: svc-a, svc-b; other: svc-c` — empty maps collapse to `null`. */
function formatServiceMap(
  rec: Readonly<Record<string, readonly string[]>>,
): string | null {
  const parts = Object.entries(rec)
    .filter(([, services]) => services.length > 0)
    .map(([file, services]) => `${file}: ${services.join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Which configurable fields of two repo entries differ, each with its
 * before→after value — same comparison basis as {@link repoProfileEquals},
 * minus repo identity. Empty ⇒ nothing overwritten. `a` is the stored profile
 * (before), `b` the live capture (after the save).
 */
export function repoProfileFieldChanges(
  a: RepoProfile,
  b: RepoProfile,
): readonly OverwriteFieldChange[] {
  const changed: OverwriteFieldChange[] = [];
  const push = (field: OverwriteField): void => {
    changed.push({
      field,
      from: overwriteFieldValue(field, a),
      to: overwriteFieldValue(field, b),
    });
  };
  if ((a.branch ?? null) !== (b.branch ?? null)) push('branch');
  if ((a.profile ?? null) !== (b.profile ?? null)) push('profile');
  if (!sameArray(a.profile_tracked, b.profile_tracked)) push('profile_tracked');
  if ((a.command_profile ?? null) !== (b.command_profile ?? null)) push('command_profile');
  if (normalizeJavaVersion(a.java_version) !== normalizeJavaVersion(b.java_version))
    push('java_version');
  if (a.selected !== b.selected) push('selected');
  if (!sameArray(a.docker_compose_active ?? [], b.docker_compose_active ?? []))
    push('docker_compose_active');
  if (
    !sameStringListRecord(
      a.docker_profile_services ?? {},
      b.docker_profile_services ?? {},
    )
  )
    push('docker_profile_services');
  return changed;
}

/**
 * Per-repo diff of a stored profile vs the live capture — powers the
 * save-overwrite confirm ("these fields will be overwritten per repo"). Repos
 * are sorted; `added`/`removed` capture the repo-set delta, `changed` lists the
 * specific overwritten fields. Repos with no change are omitted.
 */
export function profileOverwriteDiff(
  stored: ProfileDocument,
  current: ProfileDocument,
): readonly RepoOverwriteDiff[] {
  const names = [
    ...new Set([...Object.keys(stored.repos), ...Object.keys(current.repos)]),
  ].sort((x, y) => x.localeCompare(y));
  const out: RepoOverwriteDiff[] = [];
  for (const repo of names) {
    const a = stored.repos[repo];
    const b = current.repos[repo];
    if (a !== undefined && b === undefined) {
      out.push({ repo, status: 'removed', fields: [] });
    } else if (a === undefined && b !== undefined) {
      out.push({ repo, status: 'added', fields: [] });
    } else if (a !== undefined && b !== undefined) {
      const fields = repoProfileFieldChanges(a, b);
      if (fields.length > 0) out.push({ repo, status: 'changed', fields });
    }
  }
  return out;
}

/**
 * Current-vs-snapshot comparison primitive for dirty detection. Compares the
 * `repos` maps only — `name`/`created` metadata and config-file snapshots are
 * ignored (the dirty check compares live card state, not file contents).
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
   * the group this store is currently showing, then reconcile the active
   * selection (adopt a profile created elsewhere, deselect one deleted
   * out from under us).
   */
  async init(): Promise<void> {
    await this.events.onProfilesChanged((payload) => {
      void this.refresh(this._group())
        .then((names) => this.reconcileActive(names, payload.saved))
        .catch(() => undefined);
    });
  }

  /**
   * Cross-window selection sync after a re-list. `saved` (the name a save in
   * another window just wrote, present in this group) is adopted as the active
   * profile; otherwise an active profile that vanished from the list was
   * deleted elsewhere and is deselected. Pure list-membership — no group of
   * the payload is trusted, so a save in a DIFFERENT group never steals focus.
   */
  private reconcileActive(names: readonly string[], saved: string | null): void {
    if (saved !== null && names.includes(saved)) {
      void this.load(saved, this._group()).catch(() => undefined);
      return;
    }
    const active = this._activeProfileName();
    if (active !== null && !names.includes(active)) {
      this._activeProfileName.set(null);
      this._snapshot.set(null);
    }
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
