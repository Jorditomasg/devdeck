import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTERS,
  authorLabel,
  buildLogFilter,
  emailOfLabel,
  formatCommitDate,
  formatRelativeDate,
  shortSha,
  sortFilesFirst,
} from './git-window.logic';

describe('buildLogFilter', () => {
  it('drops empty fields and asks for the whole-repo flow when no branch is set', () => {
    expect(buildLogFilter(EMPTY_FILTERS, 0)).toEqual({
      all: true,
      branch: undefined,
      author: undefined,
      grep: undefined,
      path: undefined,
      since: undefined,
      until: undefined,
      skip: 0,
    });
  });

  it('trims values, maps text → grep and scopes to the branch when set', () => {
    const filter = buildLogFilter(
      {
        branch: ' develop ',
        author: 'jordi',
        text: ' fix ',
        path: 'src/app',
        since: '2026-01-01',
        until: '',
      },
      100,
    );
    expect(filter).toEqual({
      all: false,
      branch: 'develop',
      author: 'jordi',
      grep: 'fix',
      path: 'src/app',
      since: '2026-01-01',
      until: undefined,
      skip: 100,
    });
  });
});

describe('author labels', () => {
  it('round-trips name/email through the display label', () => {
    const label = authorLabel('Jordi Tomás', 'jordi@x.com');
    expect(label).toBe('Jordi Tomás <jordi@x.com>');
    expect(emailOfLabel(label)).toBe('jordi@x.com');
  });

  it('handles names containing angle brackets and empty labels', () => {
    expect(emailOfLabel('Weird <name <weird@x.com>')).toBe('weird@x.com');
    expect(emailOfLabel('')).toBe('');
    expect(emailOfLabel('Todos')).toBe('');
  });
});

describe('sortFilesFirst', () => {
  const files = [
    { path: 'README.md' },
    { path: 'src/app/ui/icon/icon.component.ts' },
    { path: 'docs/notes.md', oldPath: 'src/app/old-notes.md' },
    { path: 'src/app/core/ipc/commands.ts' },
  ];

  it('returns the same list untouched for an empty/blank query', () => {
    expect(sortFilesFirst(files, '')).toBe(files);
    expect(sortFilesFirst(files, '   ')).toBe(files);
  });

  it('moves matches first, keeping original order within each group', () => {
    expect(sortFilesFirst(files, 'SRC/APP').map((f) => f.path)).toEqual([
      'src/app/ui/icon/icon.component.ts',
      'docs/notes.md', // oldPath matches too
      'src/app/core/ipc/commands.ts',
      'README.md',
    ]);
  });

  it('hides nothing when nothing matches', () => {
    expect(sortFilesFirst(files, 'zzz')).toHaveLength(4);
  });
});

describe('shortSha', () => {
  it('abbreviates to 7 chars', () => {
    expect(shortSha('278120eb7ab7de76ba34eaca7ee2a0fb3ceacdea')).toBe('278120e');
    expect(shortSha('abc')).toBe('abc');
  });
});

describe('formatCommitDate', () => {
  it('formats ISO dates for the locale', () => {
    const out = formatCommitDate('2026-07-02T10:00:00+02:00', 'en-US');
    expect(out).toContain('2026');
    expect(out).not.toBe('2026-07-02T10:00:00+02:00');
  });

  it('returns the raw string for unparseable input', () => {
    expect(formatCommitDate('not-a-date', 'en-US')).toBe('not-a-date');
  });
});

describe('formatRelativeDate', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');

  it('formats recent dates relatively per unit', () => {
    expect(formatRelativeDate('2026-07-03T11:59:30Z', 'en-US', now)).toContain('second');
    expect(formatRelativeDate('2026-07-03T11:10:00Z', 'en-US', now)).toBe('50 minutes ago');
    expect(formatRelativeDate('2026-07-03T06:00:00Z', 'en-US', now)).toBe('6 hours ago');
    expect(formatRelativeDate('2026-06-30T12:00:00Z', 'en-US', now)).toBe('3 days ago');
  });

  it('falls back to the absolute date beyond ~30 days', () => {
    const out = formatRelativeDate('2026-01-01T00:00:00Z', 'en-US', now);
    expect(out).toContain('2026');
    expect(out).not.toContain('ago');
  });

  it('passes bad input through', () => {
    expect(formatRelativeDate('nope', 'en-US', now)).toBe('nope');
  });
});
