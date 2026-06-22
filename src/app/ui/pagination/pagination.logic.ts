/**
 * Pure, framework-free pagination math for `ui-pagination` — extracted so the
 * page-count / clamping / slicing rules are unit-testable without a DOM. All
 * page indices are 1-based (matching the "{page} / {total}" display).
 */

/** Number of pages needed for `total` items at `size` per page (never < 1). */
export function pageCount(total: number, size: number): number {
  if (size <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/** Clamp a 1-based page into `[1, pageCount(total, size)]`. */
export function clampPage(page: number, total: number, size: number): number {
  const max = pageCount(total, size);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(Math.floor(page), max);
}

/** The slice of `items` visible on the (clamped) 1-based `page`. */
export function pageSlice<T>(items: readonly T[], page: number, size: number): readonly T[] {
  if (size <= 0) return items;
  const start = (clampPage(page, items.length, size) - 1) * size;
  return items.slice(start, start + size);
}
