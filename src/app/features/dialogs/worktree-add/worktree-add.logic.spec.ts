import { describe, expect, it } from 'vitest';

import { folderForBranch, worktreeTargetPath } from './worktree-add.logic';

describe('worktree-add logic', () => {
  it('sanitizes branch names like the Rust side', () => {
    expect(folderForBranch('feature/x')).toBe('feature-x');
    expect(folderForBranch('fix/JIRA-12_a.b')).toBe('fix-JIRA-12_a.b');
    expect(folderForBranch('a b:c')).toBe('a-b-c');
  });

  it('previews the sibling .worktrees folder', () => {
    expect(worktreeTargetPath('C:\\ws\\app', 'feature/x')).toBe('C:\\ws\\app.worktrees\\feature-x');
    expect(worktreeTargetPath('/ws/app/', 'main')).toBe('/ws/app.worktrees/main');
  });
});
