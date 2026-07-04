import type { MenuEntry } from './context-menu.types';

/**
 * Step the active row by `delta`, skipping disabled entries, wrapping around.
 * Returns the previous index when every entry is disabled.
 */
export function nextEnabledIndex(
  items: readonly MenuEntry[],
  current: number,
  delta: number,
): number {
  if (!items.length) return current;
  let idx = current;
  for (let step = 0; step < items.length; step++) {
    idx = (idx + delta + items.length) % items.length;
    if (!items[idx].disabled) return idx;
  }
  return current;
}

/**
 * Flip/clamp a menu of size `w`×`h` opened at (`x`,`y`) into the
 * `vw`×`vh` viewport, keeping `margin` from every edge (tooltip behavior).
 */
export function clampMenuPosition(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
  margin: number,
): { x: number; y: number } {
  let px = x;
  let py = y;
  if (px + w > vw - margin) px = x - w; // flip left
  if (py + h > vh - margin) py = y - h; // flip up
  px = Math.max(margin, Math.min(px, vw - w - margin));
  py = Math.max(margin, Math.min(py, vh - h - margin));
  return { x: px, y: py };
}
