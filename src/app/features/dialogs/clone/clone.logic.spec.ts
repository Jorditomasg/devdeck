/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import {
  defaultFolderName,
  foldCloneProgress,
  isValidGitUrl,
  parseClonePercent,
} from './clone.logic';

describe('isValidGitUrl', () => {
  it.each([
    'https://github.com/org/repo.git',
    'http://gitlab.local/group/repo',
    'git@github.com:org/repo.git',
    'ssh://git@host:2222/org/repo.git',
    'git://host/repo.git',
    'file:///srv/git/repo.git',
    '  https://github.com/org/repo.git  ', // surrounding whitespace tolerated
  ])('accepts %s', (url) => {
    expect(isValidGitUrl(url)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'github.com/org/repo', // no scheme
    'ftp://host/repo.git',
    'https://', // scheme only
    'git@host', // scp-like without path
    'just some text',
  ])('rejects %s', (url) => {
    expect(isValidGitUrl(url)).toBe(false);
  });
});

describe('defaultFolderName', () => {
  it('takes the last path segment minus .git (v1 clone.py:56-63)', () => {
    expect(defaultFolderName('https://github.com/org/my-repo.git')).toBe('my-repo');
  });

  it('handles scp-like ssh URLs', () => {
    expect(defaultFolderName('git@github.com:org/api.git')).toBe('api');
  });

  it('handles URLs without .git suffix', () => {
    expect(defaultFolderName('https://host/group/frontend')).toBe('frontend');
  });

  it('ignores trailing slashes', () => {
    expect(defaultFolderName('https://host/org/repo.git///')).toBe('repo');
  });

  it('returns empty string for empty input', () => {
    expect(defaultFolderName('')).toBe('');
    expect(defaultFolderName('   ')).toBe('');
  });
});

describe('parseClonePercent', () => {
  it('extracts the percentage from git progress lines', () => {
    expect(parseClonePercent('Receiving objects:  42% (123/290)')).toBe(42);
    expect(parseClonePercent('[git] Resolving deltas: 100% (50/50), done.')).toBe(100);
    expect(parseClonePercent('Counting objects: 0% (0/12)')).toBe(0);
  });

  it('returns null for lines without a percentage', () => {
    expect(parseClonePercent("Cloning into 'repo'...")).toBeNull();
    expect(parseClonePercent('')).toBeNull();
  });

  it('rejects out-of-range values', () => {
    expect(parseClonePercent('weird 999% line')).toBeNull();
  });
});

describe('foldCloneProgress', () => {
  it('tracks the max across a batch (monotonic bar)', () => {
    const lines = ['Receiving objects: 10%', 'Receiving objects: 35%', 'noise'];
    expect(foldCloneProgress(0, lines)).toBe(35);
  });

  it('never goes backwards across git phases', () => {
    expect(foldCloneProgress(80, ['Resolving deltas: 5%'])).toBe(80);
  });

  it('keeps current progress when no percentages appear', () => {
    expect(foldCloneProgress(50, ['done.'])).toBe(50);
  });
});
