/**
 * Pure helpers of the changes view (design doc 2026-07-03) — kept out of the
 * component for unit testing, mirroring `git-window.logic.ts`.
 */
import type { GitChangeEntry } from '../../../core/ipc/tauri.types';

/** The two list groups (VS Code model): staged first, then changes. */
export interface ChangeGroups {
  readonly staged: readonly GitChangeEntry[];
  readonly unstaged: readonly GitChangeEntry[];
}

export function groupChanges(entries: readonly GitChangeEntry[]): ChangeGroups {
  return {
    staged: entries.filter((e) => e.staged),
    unstaged: entries.filter((e) => !e.staged),
  };
}

/**
 * Selection identity: a partially staged file (`MM`) is listed in BOTH
 * groups, so the path alone cannot identify a row.
 */
export function changeKey(entry: GitChangeEntry): string {
  return `${entry.staged ? 's' : 'w'}:${entry.path}`;
}

/** Deleted files have no working-tree content to view or edit. */
export function canEdit(entry: GitChangeEntry): boolean {
  return entry.status !== 'D';
}

/** Untracked files have no diff — they jump straight to the editor. */
export function isUntracked(entry: GitChangeEntry): boolean {
  return entry.status === 'U';
}
