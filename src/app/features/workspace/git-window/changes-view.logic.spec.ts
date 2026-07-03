import { describe, expect, it } from 'vitest';

import type { GitChangeEntry } from '../../../core/ipc/tauri.types';
import { canEdit, changeKey, groupChanges, isUntracked } from './changes-view.logic';

const entry = (path: string, staged: boolean, status: string): GitChangeEntry => ({
  path,
  staged,
  status,
});

describe('changes-view logic', () => {
  it('splits entries into the two groups preserving order', () => {
    const groups = groupChanges([
      entry('a.ts', true, 'M'),
      entry('a.ts', false, 'M'),
      entry('new.txt', false, 'U'),
    ]);
    expect(groups.staged.map((e) => e.path)).toEqual(['a.ts']);
    expect(groups.unstaged.map((e) => e.path)).toEqual(['a.ts', 'new.txt']);
  });

  it('keys a partially staged file uniquely per group', () => {
    expect(changeKey(entry('a.ts', true, 'M'))).not.toBe(changeKey(entry('a.ts', false, 'M')));
  });

  it('flags editability and untracked status', () => {
    expect(canEdit(entry('gone.ts', false, 'D'))).toBe(false);
    expect(canEdit(entry('a.ts', false, 'M'))).toBe(true);
    expect(isUntracked(entry('new.txt', false, 'U'))).toBe(true);
    expect(isUntracked(entry('a.ts', false, 'M'))).toBe(false);
  });
});
