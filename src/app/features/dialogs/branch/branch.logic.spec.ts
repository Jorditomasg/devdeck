/** TestBed-free specs (vitest-style). */
import { describe, expect, it } from 'vitest';

import { mergeLog, validateBranchName } from './branch.logic';

describe('validateBranchName (git check-ref-format subset)', () => {
  it('accepts a normal branch name', () => {
    expect(validateBranchName('feature/login')).toBeNull();
    expect(validateBranchName('release-1.2')).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(validateBranchName('   ')).toBe('dialog.branch.error_empty');
  });

  it('rejects names with spaces or forbidden characters', () => {
    for (const bad of ['has space', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a..b']) {
      expect(validateBranchName(bad)).toBe('dialog.branch.error_invalid');
    }
  });

  it('rejects edge placements (leading -, trailing / or .lock, trailing dot)', () => {
    for (const bad of ['-lead', 'trail/', 'feature.lock', 'ends.']) {
      expect(validateBranchName(bad)).toBe('dialog.branch.error_invalid');
    }
  });

  it('rejects @-forms, double slash and leading slash', () => {
    for (const bad of ['@', 'feat@{upstream}', 'a//b', '/lead']) {
      expect(validateBranchName(bad)).toBe('dialog.branch.error_invalid');
    }
  });

  it('still accepts a name containing a lone @ (not @{)', () => {
    expect(validateBranchName('feat@2')).toBeNull();
  });
});

describe('mergeLog (interleave git stream with local notices)', () => {
  it('interleaves a burst of ops 1-to-1 instead of all-lines-then-all-notices', () => {
    const streamed = ['g1', 'g2', 'g3'];
    const notices = [
      { at: 1, line: 'done1' },
      { at: 2, line: 'done2' },
      { at: 3, line: 'done3' },
    ];
    expect(mergeLog(streamed, notices)).toEqual(['g1', 'done1', 'g2', 'done2', 'g3', 'done3']);
  });

  it('flushes trailing notices anchored past the last git line', () => {
    expect(mergeLog(['g1'], [{ at: 1, line: 'done1' }, { at: 1, line: 'extra' }])).toEqual([
      'g1',
      'done1',
      'extra',
    ]);
  });

  it('emits notices anchored at 0 before any git line', () => {
    expect(mergeLog(['g1'], [{ at: 0, line: 'pre' }])).toEqual(['pre', 'g1']);
  });

  it('handles empty inputs', () => {
    expect(mergeLog([], [])).toEqual([]);
    expect(mergeLog(['g1', 'g2'], [])).toEqual(['g1', 'g2']);
  });
});
