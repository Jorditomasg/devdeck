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
