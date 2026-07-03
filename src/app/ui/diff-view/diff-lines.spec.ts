import { describe, expect, it } from 'vitest';

import { parseDiffLines } from './diff-lines';

const SAMPLE = [
  'diff --git a/src/main.rs b/src/main.rs',
  'index 0e97b59..d19dd96 100644',
  '--- a/src/main.rs',
  '+++ b/src/main.rs',
  '@@ -10,3 +10,4 @@ fn main() {',
  ' let a = 1;',
  '-let b = 2;',
  '+let b = 3;',
  '+let c = 4;',
  '\\ No newline at end of file',
].join('\n');

describe('parseDiffLines', () => {
  it('types header lines as meta and tracks hunk line numbers', () => {
    const rows = parseDiffLines(SAMPLE);
    expect(rows.map((r) => r.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'del',
      'add',
      'add',
      'meta',
    ]);
    const context = rows[5];
    expect([context.oldNo, context.newNo]).toEqual([10, 10]);
    const del = rows[6];
    expect([del.oldNo, del.newNo]).toEqual([11, null]);
    const add1 = rows[7];
    expect([add1.oldNo, add1.newNo]).toEqual([null, 11]);
    const add2 = rows[8];
    expect([add2.oldNo, add2.newNo]).toEqual([null, 12]);
  });

  it('strips the ±/space marker from code rows but keeps hunk text verbatim', () => {
    const rows = parseDiffLines(SAMPLE);
    expect(rows[5].text).toBe('let a = 1;');
    expect(rows[6].text).toBe('let b = 2;');
    expect(rows[7].text).toBe('let b = 3;');
    expect(rows[4].text).toBe('@@ -10,3 +10,4 @@ fn main() {');
  });

  it('handles hunk headers without a count (single-line files)', () => {
    const rows = parseDiffLines('@@ -1 +1 @@\n-old\n+new\n');
    expect(rows[1].oldNo).toBe(1);
    expect(rows[2].newNo).toBe(1);
  });

  it('returns no rows for empty input', () => {
    expect(parseDiffLines('')).toEqual([]);
  });
});
