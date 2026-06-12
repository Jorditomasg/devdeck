/**
 * Pure helpers for the in-page global log panel (inventory-gui.md §5).
 *
 * The global buffer lives in `ServicesStore.globalLog` (Rust-fed, trimmed at
 * 1000 lines) and exposes no clear API — clearing is a VIEW concern here:
 * remember the last visible entry as a marker and render only what arrived
 * after it ({@link linesAfterMarker}). Reference equality is reliable because
 * the store appends immutable entry objects and only ever drops from the
 * head.
 */
import type { GlobalLogLine } from '../../../core/state/services.store';

/**
 * Entries after the marker (exclusive). `null` marker ⇒ everything. A marker
 * that was trimmed out of the buffer also yields everything after it — i.e.
 * the whole remaining buffer is newer than the marker, which is correct.
 */
export function linesAfterMarker<T>(
  lines: readonly T[],
  marker: T | null,
): readonly T[] {
  if (marker === null) {
    return lines;
  }
  const index = lines.lastIndexOf(marker);
  return index < 0 ? lines : lines.slice(index + 1);
}

/** Render one global-log entry: `[service] line` (v1 global log style, §5). */
export function formatGlobalLine(entry: GlobalLogLine): string {
  return `[${entry.name}] ${entry.line}`;
}
