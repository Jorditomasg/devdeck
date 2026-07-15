/**
 * Pure helpers of the git history window (git suite phase 1) — kept out of
 * the component so they stay unit-testable without a DOM.
 */
import type { GitLogFilter } from '../../../core/ipc/tauri.types';

/** Filter-bar state, verbatim from the inputs (empty string = unset). */
export interface FilterFormState {
  readonly branch: string;
  readonly author: string;
  readonly text: string;
  readonly path: string;
  readonly since: string;
  readonly until: string;
}

export const EMPTY_FILTERS: FilterFormState = {
  branch: '',
  author: '',
  text: '',
  path: '',
  since: '',
  until: '',
};

/**
 * Map the filter form to the `git_log` wire filter: trims everything, drops
 * empties (git receives ONLY the filters actually set), carries the
 * pagination cursor. No branch selected ⇒ whole-repo flow view (`all`,
 * phase-2 contextual scope).
 */
export function buildLogFilter(form: FilterFormState, skip: number): GitLogFilter {
  const opt = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const branch = opt(form.branch);
  return {
    all: branch === undefined,
    branch,
    author: opt(form.author),
    grep: opt(form.text),
    path: opt(form.path),
    since: opt(form.since),
    until: opt(form.until),
    skip,
  };
}

/**
 * File-list search of the shared files/diff panel: matches (path or oldPath
 * contains the query, case-insensitive) sort FIRST, both groups keeping
 * their original order. Nothing is hidden — the query prioritizes.
 */
export function sortFilesFirst<T extends { path: string; oldPath?: string }>(
  files: readonly T[],
  query: string,
): readonly T[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return files;
  }
  return [...files].sort(
    (a, b) => Number(fileMatchesQuery(b, q)) - Number(fileMatchesQuery(a, q)),
  );
}

/** Case-insensitive substring match on path/oldPath (`query` pre-lowered). */
export function fileMatchesQuery(
  file: { path: string; oldPath?: string },
  query: string,
): boolean {
  return (
    file.path.toLowerCase().includes(query) ||
    (file.oldPath?.toLowerCase().includes(query) ?? false)
  );
}

/** Author dropdown display string. */
export function authorLabel(name: string, email: string): string {
  return `${name} <${email}>`;
}

/** Email back out of an [`authorLabel`] display string ('' when none). */
export function emailOfLabel(label: string): string {
  const open = label.lastIndexOf('<');
  return open === -1 ? '' : label.slice(open + 1).replace(/>$/, '');
}

/** Short sha for display (7 chars — git's default abbreviation floor). */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}


/**
 * Commit date → local display string. ISO input comes from `%aI`; a bad
 * date renders as-is rather than `Invalid Date`.
 */
export function formatCommitDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * Commit date → relative display ("hace 3 horas") for the last ~30 days,
 * falling back to the absolute [`formatCommitDate`] beyond that (relative
 * "hace 8 meses" reads worse than a date). `now` injectable for tests.
 */
export function formatRelativeDate(iso: string, locale: string, now = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) {
    return rtf.format(seconds, 'second');
  }
  if (abs < 3600) {
    return rtf.format(Math.trunc(seconds / 60), 'minute');
  }
  if (abs < 86400) {
    return rtf.format(Math.trunc(seconds / 3600), 'hour');
  }
  if (abs < 30 * 86400) {
    return rtf.format(Math.trunc(seconds / 86400), 'day');
  }
  return formatCommitDate(iso, locale);
}
