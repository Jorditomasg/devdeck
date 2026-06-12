/**
 * Pure, framework-free logic for `ui-log-viewer` — extracted so the v1 log
 * panel behaviors (inventory-gui §8, gui/log_helpers.py) are unit-testable:
 * line-cap trimming and stick-to-bottom autoscroll tracking.
 */

/** v1 LOG_MAX_LINES: per-card log buffers trim at 500 lines (§8, §28). */
export const DEFAULT_MAX_LINES = 500;

/**
 * Distance (px) from the bottom edge within which the viewer still counts as
 * "at bottom" and keeps autoscrolling. Generous enough to survive subpixel
 * scroll positions and line-height rounding.
 */
export const BOTTOM_STICK_THRESHOLD_PX = 8;

export interface CappedLines {
  /** The last `max` lines (the newest ones — v1 trims from the head). */
  readonly lines: readonly string[];
  /** How many lines were dropped from the head by this cap. */
  readonly dropped: number;
}

/**
 * Trim to the newest `max` lines, reporting how many head lines were dropped
 * so render track-keys (absolute line numbers) stay stable across trims —
 * the v1 equivalent is the O(1) `count_ref` head-trim in log_helpers.py.
 */
export function capLines(lines: readonly string[], max: number): CappedLines {
  if (max <= 0 || lines.length <= max) {
    return { lines, dropped: 0 };
  }
  return { lines: lines.slice(lines.length - max), dropped: lines.length - max };
}

/**
 * True while the viewport is scrolled to (or near) the bottom — autoscroll
 * stays engaged. Scrolling up past the threshold disengages it until the
 * user returns to the bottom (v1: textbox autoscroll-on-insert; v2 adds the
 * "unless the user scrolled up" refinement).
 */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold: number = BOTTOM_STICK_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
