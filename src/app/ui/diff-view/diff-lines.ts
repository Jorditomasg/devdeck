/**
 * Unified-diff line model (git suite phase 1) — pure parsing of `git diff`
 * text into typed rows the diff view renders with ± coloring and line
 * numbers. Syntax highlighting inside diffs is a deliberate non-goal of
 * phase 1 (design doc: CodeMirror renders the full-file view instead).
 */

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Raw line text, WITHOUT the leading `+`/`-`/` ` marker for code rows. */
  readonly text: string;
  /** 1-based line number in the OLD file; null for meta/hunk/add rows. */
  readonly oldNo: number | null;
  /** 1-based line number in the NEW file; null for meta/hunk/del rows. */
  readonly newNo: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse unified diff text into typed rows, tracking old/new line numbers
 * from the `@@` hunk headers. Anything before the first hunk (diff --git,
 * index, ---, +++, rename/similarity notes) and `\ No newline…` markers are
 * `meta` rows.
 */
export function parseDiffLines(diff: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[2], 10);
      inHunk = true;
      rows.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) {
      if (line !== '') {
        rows.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
      }
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    } else if (line.startsWith(' ') || line === '') {
      // Trailing '' from the final \n split is a legit empty context line
      // only when a hunk is still open; git never emits one, so skip it.
      if (line === '') {
        continue;
      }
      rows.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else {
      // New file header inside a multi-file diff (defensive; phase 1 asks
      // one file per call).
      inHunk = false;
      rows.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    }
  }
  return rows;
}
