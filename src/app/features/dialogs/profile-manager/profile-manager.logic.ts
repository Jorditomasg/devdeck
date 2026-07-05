/**
 * Pure logic of the Profile manager + Import Options dialogs
 * (inventory-gui §21): the load/import change plan (v1 `_build_changes_text`
 * diff), import name-collision handling (`name1`, `name2`, …), the Java
 * version mapping of the options wizard, and a small bounded-concurrency
 * runner for the clone pool (v1 5-worker ThreadPoolExecutor).
 */
import type { ProfileDocument, RepoProfile } from '../../../core/ipc/tauri.types';
import { normalizeJavaVersion, type OverwriteField } from '../../../core/state/profiles.store';

/** i18n label key per overwrite-diff field (save-overwrite preview). */
export const FIELD_LABEL_KEYS: Record<OverwriteField, string> = {
  branch: 'dialog.profile.field_branch',
  profile: 'dialog.profile.field_profile',
  profile_tracked: 'dialog.profile.field_profile_tracked',
  command_profile: 'dialog.profile.field_command_profile',
  java_version: 'dialog.profile.field_java_version',
  selected: 'dialog.profile.field_selected',
  docker_compose_active: 'dialog.profile.field_docker_active',
  docker_profile_services: 'dialog.profile.field_docker_services',
};

/** v1 clone pool width (§21 step 2: "5-worker ThreadPoolExecutor"). */
export const IMPORT_CLONE_CONCURRENCY = 5;

/** One `from ➔ to` repo field change of the §21 change preview. */
export interface FieldChange {
  readonly repo: string;
  readonly from: string;
  readonly to: string;
}

/** The §21 change preview, structured (the component renders/translates it). */
export interface ChangePlan {
  /** Repos in the profile that are absent from the workspace (clone lines). */
  readonly missingNames: readonly string[];
  readonly branchChanges: readonly FieldChange[];
  readonly profileChanges: readonly FieldChange[];
  /** Embedded config-files count (the `changes_overwrite_files` summary). */
  readonly overwriteCount: number;
}

/**
 * Diff a loaded/imported profile against the live workspace capture —
 * v1 `_build_changes_text` (§21): missing repos to clone, per-repo branch
 * changes (only when the profile TRACKS the branch, i.e. non-null), profile
 * (env selection) changes, and the embedded config-files count.
 */
export function buildChangePlan(
  doc: ProfileDocument,
  current: ProfileDocument,
): ChangePlan {
  const missingNames: string[] = [];
  const branchChanges: FieldChange[] = [];
  const profileChanges: FieldChange[] = [];
  for (const [name, rp] of Object.entries(doc.repos)) {
    const live = current.repos[name];
    if (!live) {
      missingNames.push(name);
      continue;
    }
    if (rp.branch !== null && rp.branch !== '' && rp.branch !== (live.branch ?? '')) {
      branchChanges.push({ repo: name, from: live.branch ?? '', to: rp.branch });
    }
    const wanted = rp.profile ?? '';
    const got = live.profile ?? '';
    if (wanted !== got) {
      profileChanges.push({ repo: name, from: got, to: wanted });
    }
  }
  return {
    missingNames,
    branchChanges,
    profileChanges,
    overwriteCount: countConfigFiles(doc),
  };
}

/** Total embedded config files of a profile (module → filename → content). */
export function countConfigFiles(doc: ProfileDocument): number {
  let count = 0;
  for (const rp of Object.values(doc.repos)) {
    for (const files of Object.values(rp.config_files ?? {})) {
      count += Object.keys(files).length;
    }
  }
  return count;
}

/** `true` when the plan produces at least one preview line (§21). */
export function hasChanges(plan: ChangePlan): boolean {
  return (
    plan.missingNames.length > 0 ||
    plan.branchChanges.length > 0 ||
    plan.profileChanges.length > 0 ||
    plan.overwriteCount > 0
  );
}

/**
 * Content equality ignoring `name`/`created` metadata — the v1 import
 * "identical → no_changes_identical" check (§21 :347-384).
 */
export function profilesEquivalent(a: ProfileDocument, b: ProfileDocument): boolean {
  return stableStringify(a.repos) === stableStringify(b.repos);
}

/** Deterministic JSON: object keys sorted at every level. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** v1 import auto-rename on differing collision: `name1`, `name2`, … (§21). */
export function uniqueImportedName(
  existing: readonly string[],
  base: string,
): string {
  const taken = new Set(existing);
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 1; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** One Java version the profile needs but the local registry lacks (§21). */
export interface JavaMappingNeed {
  readonly version: string;
  /** Repos referencing it (the "used in repo…" hint). */
  readonly repos: readonly string[];
}

/**
 * Java versions referenced by the profile but not registered locally —
 * each gets a mapping row in the options wizard (§21 step 1). The v1
 * system-default sentinel never needs mapping.
 */
export function javaMappingsNeeded(
  doc: ProfileDocument,
  localLabels: readonly string[],
): readonly JavaMappingNeed[] {
  const local = new Set(localLabels);
  const needs = new Map<string, string[]>();
  for (const [name, rp] of Object.entries(doc.repos)) {
    const version = normalizeJavaVersion(rp.java_version);
    if (version !== undefined && !local.has(version)) {
      const repos = needs.get(version) ?? [];
      repos.push(name);
      needs.set(version, repos);
    }
  }
  return [...needs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([version, repos]) => ({ version, repos }));
}

/**
 * Rewrite `java_version` per the user's mapping (§21 "Applied as a rewrite
 * of java_version in the profile data"). Mapping values: a local label, or
 * `''` = system default (the key is dropped). Unmapped versions pass through.
 */
export function applyJavaMappings(
  doc: ProfileDocument,
  mapping: Readonly<Record<string, string>>,
): ProfileDocument {
  const repos: Record<string, RepoProfile> = {};
  for (const [name, rp] of Object.entries(doc.repos)) {
    const version = normalizeJavaVersion(rp.java_version);
    if (version === undefined || !(version in mapping)) {
      repos[name] = rp;
      continue;
    }
    const mapped = mapping[version] ?? '';
    const { java_version: _drop, ...rest } = rp;
    repos[name] = mapped === '' ? rest : { ...rest, java_version: mapped };
  }
  return { ...doc, repos };
}

/**
 * Strip embedded `config_files` from every repo entry (the wizard's
 * "overwrite config files" checkbox OFF — `apply_profile_environments`
 * otherwise writes them to the repo dirs, ipc-contract §2.7 #46).
 * `saved_environments` are kept (v1 always merged those, §21 step 3).
 */
export function stripConfigFiles(doc: ProfileDocument): ProfileDocument {
  const repos: Record<string, RepoProfile> = {};
  for (const [name, rp] of Object.entries(doc.repos)) {
    const { config_files: _drop, ...rest } = rp;
    repos[name] = rest;
  }
  return { ...doc, repos };
}

/** Per-repo export selection — which categories of a repo entry to include. */
export interface RepoExportSelection {
  /** Include this repo at all. */
  readonly included: boolean;
  /** Start command (`command_profile`). */
  readonly starts: boolean;
  /** Environment selection: branch, env, docker, card selection. */
  readonly environment: boolean;
  /** Saved environments (`saved_environments`). */
  readonly savedEnvs: boolean;
}

/** `true` when the repo carries at least one saved environment. */
export function hasSavedEnvironments(rp: RepoProfile): boolean {
  return Object.keys(rp.saved_environments ?? {}).length > 0;
}

/**
 * Build a filtered profile document for a selective export. Only included
 * repos are kept; per repo `git_url`/`type`/`java_version` are always exported
 * (repo identity), the rest gated by the category flags. `config_files` is
 * never exported (redundant with the repo — see export-options design).
 * Omitted fields import cleanly thanks to Rust's `#[serde(default)]`.
 */
export function filterProfileDocument(
  doc: ProfileDocument,
  selection: Readonly<Record<string, RepoExportSelection>>,
): ProfileDocument {
  const repos: Record<string, RepoProfile> = {};
  for (const [name, rp] of Object.entries(doc.repos)) {
    const sel = selection[name];
    if (!sel?.included) {
      continue;
    }
    let out: RepoProfile = {
      // Intrinsic repo identity — always exported.
      git_url: rp.git_url,
      type: rp.type,
      // Environment selection (branch / env / docker / card selection).
      branch: sel.environment ? rp.branch : null,
      profile: sel.environment ? rp.profile : null,
      profile_tracked: sel.environment ? rp.profile_tracked : [],
      selected: sel.environment ? rp.selected : false,
      // Start command.
      command_profile: sel.starts ? rp.command_profile : null,
    };
    if (rp.java_version !== undefined) {
      out = { ...out, java_version: rp.java_version };
    }
    if (sel.environment && rp.docker_compose_active !== undefined) {
      out = { ...out, docker_compose_active: rp.docker_compose_active };
    }
    if (sel.environment && rp.docker_profile_services !== undefined) {
      out = { ...out, docker_profile_services: rp.docker_profile_services };
    }
    if (sel.savedEnvs && rp.saved_environments !== undefined) {
      out = { ...out, saved_environments: rp.saved_environments };
    }
    repos[name] = out;
  }
  return { ...doc, repos };
}

/**
 * Run `task` over `items` with at most `limit` in flight (the v1 clone pool).
 * Rejections do not abort the batch — the task must fold its own errors.
 */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, queue.length)) },
    async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          await task(item);
        } catch {
          // fold: a failed item must not sink its worker
        }
      }
    },
  );
  await Promise.all(workers);
}
