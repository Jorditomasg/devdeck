/**
 * Pure, framework-free logic for `ui-searchable-select` — extracted so the
 * v1 SearchableCombo behaviors (inventory-gui §32) are unit-testable without
 * a DOM: filtering, 30/+30 infinite-scroll paging, ≥98.5% scroll trigger,
 * recents-divider placement and keyboard navigation.
 */

/** v1: filter debounce 150ms (§32 "Filtering"). */
export const FILTER_DEBOUNCE_MS = 150;
/** v1: first page 30 items, +30 per load (§32 "Infinite scroll"). */
export const PAGE_SIZE = 30;
/** v1: load more when scrolled ≥98.5% of the way down (§32). */
export const LOAD_MORE_RATIO = 0.985;
/** v1: max 9 visible rows before the list scrolls (§32 "Sizing"). */
export const MAX_VISIBLE_ROWS = 9;

/**
 * Case-insensitive substring filter (§32). An empty/blank query returns the
 * full list unchanged (preserving recents ordering).
 */
export function filterOptions(options: readonly string[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((opt) => opt.toLowerCase().includes(needle));
}

/**
 * True when the scroll position has passed the load-more threshold
 * (≥98.5% of the way down — §32). A non-scrollable list never loads more.
 */
export function shouldLoadMore(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  if (scrollHeight <= clientHeight) return false;
  return (scrollTop + clientHeight) / scrollHeight >= LOAD_MORE_RATIO;
}

/** Next render cap after a load-more trigger: +30, clamped to the total. */
export function nextRenderCount(current: number, total: number): number {
  return Math.min(current + PAGE_SIZE, total);
}

/**
 * Index AFTER which the recents divider is drawn, or -1 for none.
 * v1 rule (§32 "Recents separator"): only on the unfiltered list, only when
 * it separates two non-empty groups.
 */
export function separatorIndex(recentCount: number, filtered: boolean, total: number): number {
  if (filtered || recentCount <= 0 || recentCount >= total) return -1;
  return recentCount - 1;
}

/**
 * Keyboard navigation (v2 addition — v1 had search+click only, §32
 * "Keyboard"): move the active index by `delta`, wrapping around. From the
 * "nothing active" state (-1), ArrowDown lands on the first item and
 * ArrowUp on the last.
 */
export function moveActiveIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}
