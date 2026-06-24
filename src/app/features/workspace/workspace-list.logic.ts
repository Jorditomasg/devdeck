/**
 * Pure helpers for the workspace repo LIST presentation (no Angular, no IPC):
 * search filtering, manual drag-ordering via fractional indices, and the
 * "running in another workspace" orphan computation. Kept side-effect-free so
 * the workspace page stays a thin wiring layer and these stay unit-testable.
 *
 * Ordering model (§ workspace UX): repos sort by an EFFECTIVE order =
 * persisted `repo_state.order` when present, else the repo's alphabetical
 * rank as a stable baseline. Dragging assigns a fractional order between the
 * drop neighbours — so a reorder persists ONE repo, not the whole list.
 */
import type { RepoInfo } from '../../core/ipc/tauri.types';

/** Active service statuses (mirror of `ServiceStatus::is_active`, Rust-side). */
const ACTIVE = new Set(['starting', 'running', 'stopping', 'installing']);

/** Service ids are `"repo"` or `"repo::module"` — the repo is the head. */
export function repoOfServiceId(id: string): string {
  return id.split('::')[0] as string;
}

/**
 * Effective order resolver: persisted fractional `order` when present, else
 * the repo's alphabetical rank as a stable baseline. Shared by the list sort
 * and the drag-drop neighbour math so both agree on every repo's position.
 */
export function effectiveOrder(
  repos: readonly RepoInfo[],
  orderOf: (name: string) => number | undefined,
): (name: string) => number {
  const alpha = [...repos].sort((a, b) => a.name.localeCompare(b.name));
  const rank = new Map(alpha.map((r, i) => [r.name, i] as const));
  return (name) => orderOf(name) ?? (rank.get(name) as number);
}

/**
 * Repos in display order: alphabetical baseline, overridden by any persisted
 * fractional `order`. Stable — equal effective orders keep alphabetical order.
 */
export function orderedRepos(
  repos: readonly RepoInfo[],
  orderOf: (name: string) => number | undefined,
): RepoInfo[] {
  const eff = effectiveOrder(repos, orderOf);
  return [...repos]
    .sort((a, b) => a.name.localeCompare(b.name))
    .sort((a, b) => eff(a.name) - eff(b.name));
}

/** Case-insensitive substring filter on the repo name (empty query = all). */
export function filterRepos(repos: readonly RepoInfo[], query: string): RepoInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...repos];
  }
  return repos.filter((r) => r.name.toLowerCase().includes(q));
}

/** Move `from` → `to` in a copy (indices into the array, `to` post-removal). */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved as T);
  return next;
}

/**
 * Fractional order for an item dropped between two effective orders. Picks the
 * midpoint inside the list, and steps ±1 past the ends so head/tail drops keep
 * a strict total order without ever colliding with a neighbour.
 */
export function midOrder(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) {
    return 0;
  }
  if (before === undefined) {
    return (after as number) - 1;
  }
  if (after === undefined) {
    return before + 1;
  }
  return (before + after) / 2;
}

/** One service running under a workspace other than the active one. */
export interface Orphan {
  readonly id: string;
  readonly repo: string;
  readonly group: string;
}

/**
 * Services with a live process whose repo is NOT in the active workspace —
 * i.e. left running when the user switched groups. `groupOf` resolves the
 * origin workspace label captured at switch time (`'?'` when unknown, e.g.
 * after an app restart that lost the session map).
 */
export function computeOrphans(
  services: Readonly<Record<string, { status: string }>>,
  activeRepoNames: readonly string[],
  groupOf: (repo: string) => string | undefined,
): Orphan[] {
  const here = new Set(activeRepoNames);
  return Object.entries(services)
    .filter(([, s]) => ACTIVE.has(s.status))
    .map(([id]) => ({ id, repo: repoOfServiceId(id) }))
    .filter((o) => !here.has(o.repo))
    .map((o) => ({ ...o, group: groupOf(o.repo) ?? '?' }));
}

/** Distinct origin-group labels of a set of orphans, for the banner text. */
export function orphanGroups(orphans: readonly Orphan[]): string[] {
  return [...new Set(orphans.map((o) => o.group))].filter((g) => g !== '?');
}
