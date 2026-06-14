/** Pure stash-dialog helpers (label rendering). */
import type { StashEntry } from '../../../core/ipc/tauri.types';

/** Human row label: `stash@{N} · <branch> — <message>` (branch part dropped
 * when empty, e.g. a stash made off a detached HEAD). */
export function stashEntryLabel(entry: StashEntry): string {
  const ref = `stash@{${entry.index}}`;
  const head = entry.branch ? `${ref} · ${entry.branch}` : ref;
  return `${head} — ${entry.message}`;
}
