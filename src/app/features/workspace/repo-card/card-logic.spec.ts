import { describe, expect, it } from 'vitest';
import {
  composeCountsLabel,
  dangerEnvActive,
  dockerButtonState,
  dockerCardStatus,
  firstConfigValue,
  headerHint,
  pathBasename,
  repoTypeLabel,
  serviceUrl,
} from './card-logic';

describe('repoTypeLabel (§6 type badge)', () => {
  it('title-cases and replaces dashes with spaces', () => {
    expect(repoTypeLabel('spring-boot')).toBe('Spring Boot');
  });

  it('handles single-word types', () => {
    expect(repoTypeLabel('angular')).toBe('Angular');
  });

  it('handles docker-infra', () => {
    expect(repoTypeLabel('docker-infra')).toBe('Docker Infra');
  });
});

describe('headerHint (§6 hint fragments)', () => {
  it('joins all three fragments with three spaces', () => {
    expect(headerHint('develop', 'local', 'npm start')).toBe(
      '⎇ develop   ⚙ local   $ npm start',
    );
  });

  it('drops empty fragments', () => {
    expect(headerHint('main', '', '')).toBe('⎇ main');
    expect(headerHint('', 'qa', '')).toBe('⚙ qa');
    expect(headerHint('', '', 'mvn spring-boot:run')).toBe('$ mvn spring-boot:run');
  });

  it('returns empty string with nothing to show', () => {
    expect(headerHint('', '', '')).toBe('');
  });
});

describe('firstConfigValue (§6 ⚙ fragment source)', () => {
  it('returns the first non-empty selection in module order', () => {
    expect(
      firstConfigValue({ root: '', 'src/env': 'qa' }, ['root', 'src/env']),
    ).toBe('qa');
  });

  it('returns empty when nothing is selected', () => {
    expect(firstConfigValue({}, ['root'])).toBe('');
  });
});

describe('dangerEnvActive (§10 danger badge)', () => {
  it('is true when an active config is flagged dangerous', () => {
    expect(dangerEnvActive({ root: 'prod' }, ['prod'])).toBe(true);
  });

  it('is false when the dangerous config is not active', () => {
    expect(dangerEnvActive({ root: 'local' }, ['prod'])).toBe(false);
  });

  it('ignores empty selections even if "" were flagged', () => {
    expect(dangerEnvActive({ root: '' }, [''])).toBe(false);
  });

  it('is false without danger flags', () => {
    expect(dangerEnvActive({ root: 'prod' }, [])).toBe(false);
  });
});

describe('dockerButtonState (§7 row 3.5 colors)', () => {
  it('running containers win over profile-active', () => {
    expect(dockerButtonState(2, true)).toBe('running');
    expect(dockerButtonState(1, false)).toBe('running');
  });

  it('profile-active with zero running is blue/active', () => {
    expect(dockerButtonState(0, true)).toBe('active');
  });

  it('unknown counts behave like zero running', () => {
    expect(dockerButtonState(null, true)).toBe('active');
    expect(dockerButtonState(null, false)).toBe('stopped');
  });

  it('inactive and stopped is grey', () => {
    expect(dockerButtonState(0, false)).toBe('stopped');
  });
});

describe('composeCountsLabel (§7 [running/total])', () => {
  it('renders counts', () => {
    expect(composeCountsLabel({ running: 2, total: 5 })).toBe('[2/5]');
  });

  it('renders the unknown placeholder before the first fetch', () => {
    expect(composeCountsLabel(null)).toBe('[?/?]');
  });
});

describe('dockerCardStatus (§11)', () => {
  it('is running with at least one container up', () => {
    expect(dockerCardStatus(1)).toBe('running');
  });

  it('is stopped otherwise', () => {
    expect(dockerCardStatus(0)).toBe('stopped');
  });
});

describe('serviceUrl (§8 clickable port)', () => {
  it('builds a localhost URL from the port', () => {
    expect(serviceUrl(8080, undefined)).toBe('http://localhost:8080');
  });

  it('appends the context path with a leading slash', () => {
    expect(serviceUrl(8080, 'api')).toBe('http://localhost:8080/api');
    expect(serviceUrl(8080, '/api')).toBe('http://localhost:8080/api');
  });

  it('is null without a port', () => {
    expect(serviceUrl(undefined, '/api')).toBeNull();
  });
});

describe('pathBasename', () => {
  it('handles posix and windows separators', () => {
    expect(pathBasename('/a/b/docker-compose.yml')).toBe('docker-compose.yml');
    expect(pathBasename('C:\\ws\\repo\\docker-compose.dev.yml')).toBe(
      'docker-compose.dev.yml',
    );
  });

  it('returns the input when there is no separator', () => {
    expect(pathBasename('file.yml')).toBe('file.yml');
  });
});
