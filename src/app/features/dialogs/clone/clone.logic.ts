/**
 * Pure clone-dialog logic (inventory-gui §15) — URL validation, default
 * folder derivation (v1 clone.py:56-63) and git progress parsing (the Rust
 * side forwards `git clone` stderr progress as `[git] …` log lines,
 * ipc-contract.md §2.4 #15).
 */

/** Accepted git remote URL shapes (https, ssh scp-like, ssh://, git://, file://). */
const GIT_URL_RE = /^(?:https?:\/\/\S+|git@[\w.-]+:\S+|ssh:\/\/\S+|git:\/\/\S+|file:\/\/\S+)$/i;

/** True when the string looks like a clonable git URL. */
export function isValidGitUrl(url: string): boolean {
  return GIT_URL_RE.test(url.trim());
}

/**
 * Default destination folder: the URL's last path segment minus `.git`
 * (v1 clone.py:56-63). Empty string when nothing derivable.
 */
export function defaultFolderName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return '';
  }
  const lastSegment = trimmed.split(/[/:]/).pop() ?? '';
  return lastSegment.replace(/\.git$/i, '');
}

/**
 * Extract a clone progress percentage (0-100) from a git progress log line
 * (e.g. `Receiving objects:  42% (123/290)`); `null` when the line carries
 * no percentage.
 */
export function parseClonePercent(line: string): number | null {
  const match = /(\d{1,3})%/.exec(line);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : null;
}

/**
 * Fold a batch of git log lines into the latest known progress, starting
 * from `current`. Progress never goes backwards within one clone run
 * (git restarts percentages per phase: counting → compressing → receiving →
 * resolving; the bar tracking the max keeps the v1 monotonic feel).
 */
export function foldCloneProgress(current: number, lines: readonly string[]): number {
  let progress = current;
  for (const line of lines) {
    const pct = parseClonePercent(line);
    if (pct !== null && pct > progress) {
      progress = pct;
    }
  }
  return progress;
}
