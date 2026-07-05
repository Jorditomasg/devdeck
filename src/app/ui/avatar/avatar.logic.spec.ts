import { describe, expect, it } from 'vitest';

import { gravatarUrl, hueOf, initialsOf } from './avatar.logic';

describe('initialsOf', () => {
  it('takes the first letters of the first two words, uppercased', () => {
    expect(initialsOf('Jordi Tomás')).toBe('JT');
    expect(initialsOf('ada lovelace king')).toBe('AL');
  });

  it('handles single words, extra whitespace and empty names', () => {
    expect(initialsOf('root')).toBe('R');
    expect(initialsOf('  spaced   out  ')).toBe('SO');
    expect(initialsOf('')).toBe('');
  });
});

describe('hueOf', () => {
  it('is deterministic and within 0..359', () => {
    expect(hueOf('a@x.com')).toBe(hueOf('a@x.com'));
    for (const seed of ['a@x.com', 'b@y.dev', '', 'test@example.com']) {
      const hue = hueOf(seed);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('separates different emails (sanity, not a guarantee)', () => {
    expect(hueOf('a@x.com')).not.toBe(hueOf('b@y.dev'));
  });
});

describe('gravatarUrl', () => {
  it('hashes the trimmed, lowercased email with SHA-256 and asks d=404', async () => {
    // SHA-256("test@example.com") — fixed vector.
    const url = await gravatarUrl('  Test@Example.COM ');
    expect(url).toBe(
      'https://gravatar.com/avatar/973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b?d=404&s=64',
    );
  });

  it('honors a custom size', async () => {
    const url = await gravatarUrl('test@example.com', 128);
    expect(url).toContain('s=128');
  });
});
