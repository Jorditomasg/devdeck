/**
 * Pure workspace-screen logic, extracted for unit testing:
 * - topbar path↔group-selector swap rule (inventory-gui.md §2)
 * - profile combo display name with the dirty marker (§24/§26)
 */
import { PROFILE_DIRTY_SUFFIX } from './workspace.constants';

/**
 * Topbar swap rule (§2 `_update_topbar_group_ui`): show the group selector —
 * hiding the workspace path label — when there is more than one group OR the
 * active group spans more than one path. Otherwise show the path label.
 */
export function showGroupSelector(
  groupCount: number,
  activeGroupPathCount: number,
): boolean {
  return groupCount > 1 || activeGroupPathCount > 1;
}

/**
 * Topbar profile combo display value (§26 "Dirty styling"): active profile
 * name, suffixed `" *"` while the live state deviates from the saved
 * snapshot; the (translated) no-profile sentinel when none is active.
 */
export function profileDisplayName(
  activeName: string | null,
  dirty: boolean,
  noProfileLabel: string,
): string {
  if (!activeName) {
    return noProfileLabel;
  }
  return dirty ? `${activeName}${PROFILE_DIRTY_SUFFIX}` : activeName;
}

/**
 * Profile dropdown values (§26 "Dropdown"): the sentinel appears when no
 * profiles exist, or ahead of the list while no profile is active; it is
 * hidden while a profile IS active.
 */
export function profileDropdownOptions(
  profiles: readonly string[],
  activeName: string | null,
  noProfileLabel: string,
): readonly string[] {
  if (profiles.length === 0) {
    return [noProfileLabel];
  }
  return activeName ? profiles : [noProfileLabel, ...profiles];
}

/** One module's env state for the drift check (§10 drift deselection). */
export interface EnvDriftInput {
  readonly moduleKey: string;
  /** Selected saved-env name (`''` = no selection → never drifts). */
  readonly selectedName: string;
  /** Content stored for `selectedName` (`undefined` if the env was deleted). */
  readonly savedContent: string | undefined;
  /** Current on-disk content of the active file (`''` if missing). */
  readonly currentContent: string;
}

/**
 * Module keys whose on-disk env file no longer matches their selected saved
 * environment (§10 drift deselection). A module drifts when it HAS a selection
 * and either the saved env is gone (`savedContent === undefined`) or the file
 * content differs byte-for-byte (writers write verbatim, so an exact compare
 * has no false positives). Modules with no selection never drift.
 */
export function driftedModules(inputs: readonly EnvDriftInput[]): string[] {
  return inputs
    .filter(
      (i) =>
        i.selectedName !== '' &&
        (i.savedContent === undefined || i.currentContent !== i.savedContent),
    )
    .map((i) => i.moduleKey);
}

/**
 * Group `active_configs` (`"{repo}::{module}"` → env name, §10 / contract
 * §1.5) into per-repo module maps, keeping only detected repos and non-empty
 * selections. Used to re-hydrate the env dropdowns on startup: the selection
 * is persisted on every pick but is otherwise never read back, so a transient
 * env choice (not captured into a profile) was lost across restarts.
 */
export function activeConfigsByRepo(
  activeConfigs: Readonly<Record<string, string>> | undefined,
  detectedRepos: readonly string[],
): ReadonlyMap<string, Record<string, string>> {
  const byRepo = new Map<string, Record<string, string>>();
  if (!activeConfigs) {
    return byRepo;
  }
  const wanted = new Set(detectedRepos);
  for (const [key, value] of Object.entries(activeConfigs)) {
    if (!value) {
      continue; // deselected (persisted null) → nothing to restore
    }
    const sep = key.indexOf('::');
    if (sep < 0) {
      continue;
    }
    const repo = key.slice(0, sep);
    const moduleKey = key.slice(sep + 2);
    if (!moduleKey || !wanted.has(repo)) {
      continue; // orphan key for a repo no longer in this group
    }
    const entry = byRepo.get(repo) ?? {};
    entry[moduleKey] = value;
    byRepo.set(repo, entry);
  }
  return byRepo;
}

/**
 * Display name of a compose file button (§7 row 3.5): `docker-compose.yml` →
 * `docker-compose`; `docker-compose.<x>.yml` → `<x>`; anything else → its
 * basename without extension.
 */
export function composeDisplayName(composeFile: string): string {
  const base = composeFile.replace(/\\/g, '/').split('/').pop() ?? composeFile;
  const noExt = base.replace(/\.ya?ml$/i, '');
  const match = /^docker-compose\.(.+)$/.exec(noExt);
  if (match) {
    return match[1] as string;
  }
  return noExt;
}
