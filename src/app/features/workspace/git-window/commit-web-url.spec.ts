import { describe, expect, it } from 'vitest';

import { commitWebUrl, remoteWebBase } from './commit-web-url';

describe('remoteWebBase', () => {
  it('normalizes https remotes (credentials, .git, trailing slash)', () => {
    expect(remoteWebBase('https://github.com/o/r.git')).toBe('https://github.com/o/r');
    expect(remoteWebBase('https://user:tok@gitlab.com/g/p.git/')).toBe('https://gitlab.com/g/p');
    expect(remoteWebBase('http://git.corp.local/o/r')).toBe('http://git.corp.local/o/r');
  });

  it('converts scp-like and ssh:// remotes', () => {
    expect(remoteWebBase('git@github.com:o/r.git')).toBe('https://github.com/o/r');
    expect(remoteWebBase('ssh://git@gitlab.com:2222/g/p.git')).toBe('https://gitlab.com/g/p');
  });

  it('rejects non-browsable remotes', () => {
    expect(remoteWebBase('')).toBe('');
    expect(remoteWebBase('/mnt/backups/repo.bundle')).toBe('');
    expect(remoteWebBase('C:\\repos\\local')).toBe('');
  });
});

describe('commitWebUrl', () => {
  const sha = 'abc123';

  it('uses the per-forge commit path', () => {
    expect(commitWebUrl('git@github.com:o/r.git', sha)).toBe(
      'https://github.com/o/r/commit/abc123',
    );
    expect(commitWebUrl('https://gitlab.com/g/p.git', sha)).toBe(
      'https://gitlab.com/g/p/-/commit/abc123',
    );
    expect(commitWebUrl('https://bitbucket.org/t/r.git', sha)).toBe(
      'https://bitbucket.org/t/r/commits/abc123',
    );
    expect(commitWebUrl('https://git.selfhosted.dev/o/r', sha)).toBe(
      'https://git.selfhosted.dev/o/r/commit/abc123',
    );
  });

  it('returns empty for underivable inputs', () => {
    expect(commitWebUrl('', sha)).toBe('');
    expect(commitWebUrl('git@github.com:o/r.git', '')).toBe('');
  });
});
