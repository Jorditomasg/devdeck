/** Pure branch-dialog logic: name validation (a git check-ref-format subset). */

/** A local result notice anchored to the git-stream length when it was added. */
export interface LogNotice {
  readonly at: number;
  readonly line: string;
}

/**
 * Interleave local notices into the streamed git lines in chronological order.
 * Each notice carries `at` — the number of streamed lines present when it was
 * appended — so a burst of ops renders 1-to-1 (git line, its notice, next git
 * line, …) instead of all git lines followed by all notices.
 */
export function mergeLog(
  streamed: readonly string[],
  notices: readonly LogNotice[],
): readonly string[] {
  const out: string[] = [];
  let n = 0;
  for (let i = 0; i <= streamed.length; i++) {
    while (n < notices.length && notices[n].at <= i) {
      out.push(notices[n].line);
      n++;
    }
    if (i < streamed.length) {
      out.push(streamed[i]);
    }
  }
  return out;
}

/** Characters git forbids in a ref name component. */
const FORBIDDEN = /[ ~^:?*[\\]/;

/**
 * Validate a proposed branch name. Returns the i18n key of the first problem,
 * or `null` when acceptable. Covers the common `git check-ref-format` rules:
 * non-empty; no spaces / `~^:?*[` / backslash / control chars; no `..`; no
 * `@{` and not the single `@`; no `//`; no leading `-` or `/`; no trailing
 * `/`, `.` or `.lock`.
 */
export function validateBranchName(name: string): string | null {
  const value = name.trim();
  if (value === '') {
    return 'dialog.branch.error_empty';
  }
  if (
    FORBIDDEN.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value === '@' ||
    value.includes('//') ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    return 'dialog.branch.error_invalid';
  }
  return null;
}
