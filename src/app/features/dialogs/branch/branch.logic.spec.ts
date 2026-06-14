/** TestBed-free specs (vitest-style). */
import { describe, expect, it } from 'vitest';

import { validateBranchName } from './branch.logic';

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
});
