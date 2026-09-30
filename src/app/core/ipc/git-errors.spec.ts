import { describe, expect, it } from 'vitest';
import { isGitAuthError } from './git-errors';

describe('isGitAuthError', () => {
  it('flags HTTPS and SSH credential failures', () => {
    expect(
      isGitAuthError(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
    ).toBe(true);
    expect(isGitAuthError("fatal: Authentication failed for 'https://x/y.git/'")).toBe(true);
    expect(isGitAuthError('The requested URL returned error: 403')).toBe(true);
    expect(isGitAuthError('git@github.com: Permission denied (publickey).')).toBe(true);
  });

  it('ignores unrelated git errors', () => {
    expect(isGitAuthError('fatal: Not possible to fast-forward, aborting.')).toBe(false);
    expect(isGitAuthError("fatal: destination path 'x' already exists")).toBe(false);
  });
});
