import { describe, expect, it } from 'vitest';

import { extensionOf, languageFor } from './language-by-extension';

describe('extensionOf', () => {
  it('lowercases and takes the last dot segment of the basename', () => {
    expect(extensionOf('src/app/Main.TS')).toBe('ts');
    expect(extensionOf('a/b/config.spec.ts')).toBe('ts');
    expect(extensionOf('pom.xml')).toBe('xml');
  });

  it('returns empty for dotless and dotfile names', () => {
    expect(extensionOf('Dockerfile')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('dir.with.dots/README')).toBe('');
  });
});

describe('languageFor', () => {
  it('resolves the suite stacks (TS, Java, Rust, markup, config)', () => {
    for (const name of [
      'main.ts',
      'app.tsx',
      'index.js',
      'Api.java',
      'lib.rs',
      'index.html',
      'styles.scss',
      'package.json',
      'compose.yml',
      'pom.xml',
      'README.md',
      'script.py',
    ]) {
      expect(languageFor(name), name).not.toBeNull();
    }
  });

  it('returns null (plain text) for unknown extensions', () => {
    expect(languageFor('binary.dat')).toBeNull();
    expect(languageFor('Dockerfile')).toBeNull();
  });
});
