/** Pure branch-dialog logic: name validation (a git check-ref-format subset). */

/** Characters git forbids in a ref name component. */
const FORBIDDEN = /[ ~^:?*[\\]/;

/**
 * Validate a proposed branch name. Returns the i18n key of the first problem,
 * or `null` when acceptable. Covers the common `git check-ref-format` rules:
 * non-empty; no spaces / `~^:?*[` / backslash / control chars; no `..`; no
 * leading `-`; no trailing `/`, `.` or `.lock`.
 */
export function validateBranchName(name: string): string | null {
  const value = name.trim();
  if (value === '') {
    return 'dialog.branch.error_empty';
  }
  if (
    FORBIDDEN.test(value) ||
    value.includes('..') ||
    value.startsWith('-') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    return 'dialog.branch.error_invalid';
  }
  return null;
}
