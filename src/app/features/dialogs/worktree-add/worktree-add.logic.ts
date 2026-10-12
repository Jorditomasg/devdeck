/**
 * Pure helpers of the new-worktree dialog — mirror Rust
 * `git::worktrees::{folder_for_branch, target_dir}` so the dialog can preview
 * the exact folder git will create.
 */

/** Branch → folder name: anything outside `[A-Za-z0-9._-]` becomes `-`. */
export function folderForBranch(branch: string): string {
  return branch.trim().replace(/[^A-Za-z0-9._-]/g, '-');
}

/** `<repo-parent>/<repo-dir>.worktrees/<folder>` with the repo's separator. */
export function worktreeTargetPath(repoPath: string, branch: string): string {
  const sep = repoPath.includes('\\') ? '\\' : '/';
  const trimmed = repoPath.replace(/[\\/]+$/, '');
  const cut = trimmed.lastIndexOf(sep);
  const parent = cut >= 0 ? trimmed.slice(0, cut) : '';
  const base = trimmed.slice(cut + 1);
  return `${parent}${sep}${base}.worktrees${sep}${folderForBranch(branch)}`;
}
