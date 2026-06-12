/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { detectFormat, validateConfigContent } from './config-validation';

describe('detectFormat', () => {
  it('classifies by extension, case-insensitive', () => {
    expect(detectFormat('application.yml')).toBe('yaml');
    expect(detectFormat('application.YAML')).toBe('yaml');
    expect(detectFormat('app.properties')).toBe('properties');
    expect(detectFormat('environment.ts')).toBe('other');
    expect(detectFormat('Dockerfile')).toBe('other');
  });
});

describe('validateConfigContent — yaml', () => {
  it('accepts well-formed yaml', () => {
    const content = 'server:\n  port: 8080\nspring:\n  profiles: dev\n';
    expect(validateConfigContent('yaml', content)).toEqual([]);
  });

  it('flags tabs in indentation with the line number', () => {
    const problems = validateConfigContent('yaml', 'server:\n\tport: 8080');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 2');
    expect(problems[0]).toContain('tab');
  });

  it('flags duplicate top-level keys', () => {
    const problems = validateConfigContent(
      'yaml',
      'server:\n  port: 1\nserver:\n  port: 2',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("duplicate top-level key 'server'");
  });

  it('does not treat nested keys as top-level duplicates', () => {
    const content = 'a:\n  port: 1\nb:\n  port: 2';
    expect(validateConfigContent('yaml', content)).toEqual([]);
  });
});

describe('validateConfigContent — properties', () => {
  it('accepts key=value, key: value, comments and blanks', () => {
    const content = '# comment\n! also comment\n\nspring.port=8080\nname: app\n';
    expect(validateConfigContent('properties', content)).toEqual([]);
  });

  it('flags lines without a separator', () => {
    const problems = validateConfigContent('properties', 'this is not a property');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 1');
  });

  it('tolerates backslash line continuations', () => {
    const content = 'list=a,\\\n     b,\\\n     c\n';
    expect(validateConfigContent('properties', content)).toEqual([]);
  });
});

describe('validateConfigContent — other', () => {
  it('never validates unknown formats', () => {
    expect(validateConfigContent('other', '\t???')).toEqual([]);
  });
});
