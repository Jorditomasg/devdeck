/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import type { ComposeService } from '../../../core/ipc/tauri.types';
import {
  composeBasename,
  countRunning,
  mergeStatus,
  serviceState,
} from './docker-compose.logic';

const svc = (name: string): ComposeService => ({
  name,
  image: 'img',
  ports: [],
  dependsOn: [],
});

describe('composeBasename', () => {
  it.each([
    ['/repo/docker/docker-compose.yml', 'docker-compose.yml'],
    ['C:\\repo\\docker-compose.dev.yml', 'docker-compose.dev.yml'],
    ['compose.yml', 'compose.yml'],
  ])('extracts the basename of %s', (path, expected) => {
    expect(composeBasename(path)).toBe(expected);
  });
});

describe('serviceState', () => {
  it('returns the reported state', () => {
    expect(serviceState({ db: 'running' }, 'db')).toBe('running');
  });

  it('defaults unknown services to stopped (ipc §3)', () => {
    expect(serviceState({}, 'db')).toBe('stopped');
  });
});

describe('countRunning', () => {
  it('counts only running services of the given list', () => {
    const services = [svc('db'), svc('api'), svc('cache')];
    const status = { db: 'running', cache: 'stopped', other: 'running' } as const;
    expect(countRunning(services, status)).toBe(1);
  });

  it('is 0 with no status reports yet', () => {
    expect(countRunning([svc('db')], {})).toBe(0);
  });
});

describe('mergeStatus', () => {
  it('merges incoming over current without dropping other services', () => {
    const merged = mergeStatus(
      { db: 'running', api: 'stopped' },
      { api: 'running' },
    );
    expect(merged).toEqual({ db: 'running', api: 'running' });
  });
});
