import { describe, expect, it } from 'vitest';

import type { RepoInfo } from '../../core/ipc/tauri.types';
import {
  computeOrphans,
  filterRepos,
  midOrder,
  orderedRepos,
  orphanGroups,
  reorder,
  repoOfServiceId,
} from './workspace-list.logic';

/** Minimal RepoInfo stub — only `name` matters to these helpers. */
function repo(name: string): RepoInfo {
  return { name } as RepoInfo;
}

const names = (rs: readonly RepoInfo[]): string[] => rs.map((r) => r.name);

describe('orderedRepos', () => {
  it('alphabetical when no orders persisted', () => {
    const out = orderedRepos([repo('c'), repo('a'), repo('b')], () => undefined);
    expect(names(out)).toEqual(['a', 'b', 'c']);
  });

  it('persisted fractional order overrides the alphabetical baseline', () => {
    // Move "a" (rank 0) to sit between "b" (rank 1) and "c" (rank 2).
    const order = new Map([['a', 1.5]]);
    const out = orderedRepos([repo('a'), repo('b'), repo('c')], (n) => order.get(n));
    expect(names(out)).toEqual(['b', 'a', 'c']);
  });
});

describe('filterRepos', () => {
  it('empty query returns all', () => {
    expect(names(filterRepos([repo('api'), repo('web')], '  '))).toEqual(['api', 'web']);
  });
  it('case-insensitive substring match', () => {
    expect(names(filterRepos([repo('api-Gateway'), repo('web')], 'GATE'))).toEqual([
      'api-Gateway',
    ]);
  });
});

describe('reorder + midOrder (fractional drag)', () => {
  it('reorder moves an item to a new index', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });
  it('midpoint between two neighbours', () => {
    expect(midOrder(1, 2)).toBe(1.5);
  });
  it('steps past the ends so head/tail drops never collide', () => {
    expect(midOrder(undefined, 0)).toBe(-1);
    expect(midOrder(5, undefined)).toBe(6);
    expect(midOrder(undefined, undefined)).toBe(0);
  });
});

describe('computeOrphans (running in another workspace)', () => {
  const services = {
    'api::core': { status: 'running' },
    web: { status: 'starting' },
    legacy: { status: 'stopped' },
  };

  it('flags active services whose repo is absent from the active group', () => {
    const orphans = computeOrphans(services, ['web'], (r) =>
      r === 'api' ? 'Backend' : undefined,
    );
    expect(orphans).toEqual([{ id: 'api::core', repo: 'api', group: 'Backend' }]);
  });

  it('stopped services are never orphans', () => {
    expect(computeOrphans(services, [], () => undefined).some((o) => o.repo === 'legacy')).toBe(
      false,
    );
  });

  it('repoOfServiceId takes the head before "::"', () => {
    expect(repoOfServiceId('api::core')).toBe('api');
    expect(repoOfServiceId('web')).toBe('web');
  });

  it('orphanGroups lists distinct known labels', () => {
    expect(
      orphanGroups([
        { id: 'a', repo: 'a', group: 'X' },
        { id: 'b', repo: 'b', group: 'X' },
        { id: 'c', repo: 'c', group: '?' },
      ]),
    ).toEqual(['X']);
  });
});
