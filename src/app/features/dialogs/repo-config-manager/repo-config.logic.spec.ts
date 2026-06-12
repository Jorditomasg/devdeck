/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import {
  basenameOf,
  envNameFromFile,
  newConfigEntries,
  renameDangerName,
  toggleDangerName,
} from './repo-config.logic';

describe('envNameFromFile', () => {
  it('strips the fixed prefix/suffix of the matching pattern (v1 §23 auto-import)', () => {
    expect(envNameFromFile('application-dev.yml', ['application*.yml'])).toBe('dev');
    expect(envNameFromFile('environment.production.ts', ['environment*.ts'])).toBe(
      'production',
    );
    expect(envNameFromFile('.env.local', ['.env*'])).toBe('local');
  });

  it('falls back to "default" when the wildcard remainder is empty', () => {
    expect(envNameFromFile('application.yml', ['application*.yml'])).toBe('default');
    expect(envNameFromFile('.env', ['.env*'])).toBe('default');
  });

  it('falls back to "default" when no pattern matches (v1 code behavior)', () => {
    expect(envNameFromFile('readme.md', ['application*.yml'])).toBe('default');
    expect(envNameFromFile('anything', [])).toBe('default');
  });

  it('tries patterns in order and uses the first match', () => {
    expect(
      envNameFromFile('application-uat.properties', [
        'application*.yml',
        'application*.properties',
      ]),
    ).toBe('uat');
  });

  it('escapes regex metacharacters in patterns', () => {
    expect(envNameFromFile('app.config(x)-qa.json', ['app.config(x)*.json'])).toBe('qa');
  });
});

describe('newConfigEntries', () => {
  it('keeps only names that are not already saved', () => {
    const result = newConfigEntries(
      { dev: 'a: 1', prod: 'b: 2' },
      ['prod', 'local'],
    );
    expect(result).toEqual({ dev: 'a: 1' });
  });

  it('returns an empty object when every candidate exists', () => {
    expect(newConfigEntries({ dev: 'x' }, ['dev'])).toEqual({});
  });
});

describe('toggleDangerName', () => {
  it('adds a missing name, sorted', () => {
    expect(toggleDangerName(['prod'], 'dev')).toEqual(['dev', 'prod']);
  });

  it('removes a present name', () => {
    expect(toggleDangerName(['dev', 'prod'], 'prod')).toEqual(['dev']);
  });
});

describe('renameDangerName', () => {
  it('carries the danger flag over to the new name', () => {
    expect(renameDangerName(['dev', 'prod'], 'prod', 'production')).toEqual([
      'dev',
      'production',
    ]);
  });

  it('is a no-op when the old name was not flagged', () => {
    const names = ['dev'];
    expect(renameDangerName(names, 'prod', 'production')).toBe(names);
  });
});

describe('basenameOf', () => {
  it('handles both separators', () => {
    expect(basenameOf('/ws/repo/src/app.yml')).toBe('app.yml');
    expect(basenameOf('C:\\ws\\repo\\app.yml')).toBe('app.yml');
  });
});
