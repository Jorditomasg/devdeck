/**
 * Pure workspace-groups dialog logic (inventory-gui §24): collision-safe
 * group naming, rename/path mutations, and the save-time empty-paths
 * validation. All functions are immutable — they return new arrays.
 */
import type { WorkspaceGroup } from '../../../core/ipc/tauri.types';

/**
 * v1 add-group naming (§24): the base name, auto-suffixed `" 1"`, `" 2"`, …
 * on collision.
 */
export function uniqueGroupName(
  groups: readonly WorkspaceGroup[],
  base: string,
): string {
  const taken = new Set(groups.map((g) => g.name));
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 1; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Rename a group in place. Returns `null` when the new name is empty or
 * collides with another group (v1 silently ignored both, §24).
 */
export function renameGroup(
  groups: readonly WorkspaceGroup[],
  index: number,
  newName: string,
): readonly WorkspaceGroup[] | null {
  const name = newName.trim();
  const group = groups[index];
  if (!group || name === '') {
    return null;
  }
  if (name === group.name) {
    return groups;
  }
  if (groups.some((g, i) => i !== index && g.name === name)) {
    return null;
  }
  return groups.map((g, i) => (i === index ? { ...g, name } : g));
}

/** Add a path to a group, deduplicated per group (v1 §24). */
export function addGroupPath(
  groups: readonly WorkspaceGroup[],
  index: number,
  path: string,
): readonly WorkspaceGroup[] {
  const group = groups[index];
  if (!group || group.paths.includes(path)) {
    return groups;
  }
  return groups.map((g, i) =>
    i === index ? { ...g, paths: [...g.paths, path] } : g,
  );
}

/** Remove a path from a group (no-op when absent). */
export function removeGroupPath(
  groups: readonly WorkspaceGroup[],
  index: number,
  path: string,
): readonly WorkspaceGroup[] {
  const group = groups[index];
  if (!group || !group.paths.includes(path)) {
    return groups;
  }
  return groups.map((g, i) =>
    i === index ? { ...g, paths: g.paths.filter((p) => p !== path) } : g,
  );
}

/** Names of groups with zero paths — the save-time rejection list (§24). */
export function emptyPathGroupNames(
  groups: readonly WorkspaceGroup[],
): readonly string[] {
  return groups.filter((g) => g.paths.length === 0).map((g) => g.name);
}

/**
 * The active-group name to persist on save: keeps `wanted` when it still
 * names a group, otherwise falls back to the first group (v1 §24 save).
 */
export function effectiveActiveName(
  groups: readonly WorkspaceGroup[],
  wanted: string,
): string {
  return groups.some((g) => g.name === wanted) ? wanted : (groups[0]?.name ?? '');
}
