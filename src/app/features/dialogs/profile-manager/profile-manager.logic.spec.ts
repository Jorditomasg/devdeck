/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import type { ProfileDocument, RepoProfile } from '../../../core/ipc/tauri.types';
import {
  applyJavaMappings,
  buildChangePlan,
  countConfigFiles,
  filterProfileDocument,
  hasChanges,
  hasSavedEnvironments,
  javaMappingsNeeded,
  profilesEquivalent,
  runLimited,
  stableStringify,
  stripConfigFiles,
  uniqueImportedName,
  type RepoExportSelection,
} from './profile-manager.logic';

function repo(partial: Partial<RepoProfile> = {}): RepoProfile {
  return {
    git_url: 'git@host:r.git',
    branch: null,
    type: 'spring-boot',
    profile: null,
    profile_tracked: [],
    command_profile: null,
    selected: true,
    ...partial,
  };
}

function doc(repos: Record<string, RepoProfile>): ProfileDocument {
  return { repos };
}

describe('buildChangePlan', () => {
  const current = doc({
    api: repo({ branch: 'develop', profile: 'dev' }),
    web: repo({ branch: 'main', profile: null }),
  });

  it('reports repos missing from the workspace (clone lines, §21)', () => {
    const plan = buildChangePlan(doc({ infra: repo() }), current);
    expect(plan.missingNames).toEqual(['infra']);
  });

  it('reports branch changes only when the profile tracks the branch', () => {
    const tracked = buildChangePlan(
      doc({ api: repo({ branch: 'main', profile: 'dev' }) }),
      current,
    );
    expect(tracked.branchChanges).toEqual([
      { repo: 'api', from: 'develop', to: 'main' },
    ]);

    const untracked = buildChangePlan(
      doc({ api: repo({ branch: null, profile: 'dev' }) }),
      current,
    );
    expect(untracked.branchChanges).toEqual([]);
  });

  it('reports profile changes with null/"" treated equal', () => {
    const plan = buildChangePlan(
      doc({ api: repo({ branch: 'develop', profile: 'uat' }), web: repo({ profile: '' }) }),
      current,
    );
    expect(plan.profileChanges).toEqual([{ repo: 'api', from: 'dev', to: 'uat' }]);
  });

  it('counts embedded config files for the overwrite summary', () => {
    const withFiles = doc({
      api: repo({
        branch: 'develop',
        profile: 'dev',
        config_files: { root: { 'a.yml': 'x', 'b.yml': 'y' }, src: { 'c.ts': 'z' } },
      }),
    });
    const plan = buildChangePlan(withFiles, current);
    expect(plan.overwriteCount).toBe(3);
    expect(countConfigFiles(withFiles)).toBe(3);
  });

  it('hasChanges is false for an identical capture', () => {
    const plan = buildChangePlan(current, current);
    expect(hasChanges(plan)).toBe(false);
  });
});

describe('profilesEquivalent / stableStringify', () => {
  it('ignores name/created metadata (v1 import identity check)', () => {
    const a: ProfileDocument = { name: 'one', created: '2024', repos: { r: repo() } };
    const b: ProfileDocument = { name: 'two', created: '2025', repos: { r: repo() } };
    expect(profilesEquivalent(a, b)).toBe(true);
  });

  it('is key-order independent', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('detects content differences', () => {
    expect(
      profilesEquivalent(doc({ r: repo() }), doc({ r: repo({ branch: 'x' }) })),
    ).toBe(false);
  });
});

describe('uniqueImportedName', () => {
  it('keeps a free name and suffixes 1, 2, … on collision (§21)', () => {
    expect(uniqueImportedName(['other'], 'prod')).toBe('prod');
    expect(uniqueImportedName(['prod'], 'prod')).toBe('prod1');
    expect(uniqueImportedName(['prod', 'prod1'], 'prod')).toBe('prod2');
  });
});

describe('javaMappingsNeeded', () => {
  it('lists unregistered versions with the repos using them', () => {
    const d = doc({
      api: repo({ java_version: 'Java 17' }),
      job: repo({ java_version: 'Java 17' }),
      web: repo({ java_version: 'Java 21' }),
    });
    expect(javaMappingsNeeded(d, ['Java 21'])).toEqual([
      { version: 'Java 17', repos: ['api', 'job'] },
    ]);
  });

  it('never asks to map an empty java label (system default)', () => {
    const d = doc({ api: repo({ java_version: '' }) });
    expect(javaMappingsNeeded(d, [])).toEqual([]);
  });
});

describe('applyJavaMappings', () => {
  it('rewrites mapped versions and drops system-default mappings', () => {
    const d = doc({
      api: repo({ java_version: 'Java 17' }),
      web: repo({ java_version: 'Java 11' }),
      job: repo({ java_version: 'Java 8' }),
    });
    const result = applyJavaMappings(d, { 'Java 17': 'JDK 17 (local)', 'Java 11': '' });
    expect(result.repos['api']?.java_version).toBe('JDK 17 (local)');
    expect(result.repos['web']?.java_version).toBeUndefined();
    expect(result.repos['job']?.java_version).toBe('Java 8'); // unmapped passthrough
  });
});

describe('stripConfigFiles', () => {
  it('removes config_files but keeps saved_environments', () => {
    const d = doc({
      api: repo({
        config_files: { root: { 'a.yml': 'x' } },
        saved_environments: { 'a.yml': { dev: 'x' } },
      }),
    });
    const result = stripConfigFiles(d);
    expect(result.repos['api']?.config_files).toBeUndefined();
    expect(result.repos['api']?.saved_environments).toEqual({ 'a.yml': { dev: 'x' } });
  });
});

describe('filterProfileDocument', () => {
  const full = repo({
    branch: 'develop',
    profile: 'dev',
    profile_tracked: ['a.yml'],
    command_profile: 'run-fast',
    java_version: 'Java 17',
    docker_compose_active: ['docker-compose.yml'],
    docker_profile_services: { 'docker-compose.yml': ['db'] },
    config_files: { root: { 'a.yml': 'x' } },
    saved_environments: { 'a.yml': { dev: 'x' } },
  });
  const sel = (p: Partial<RepoExportSelection>): RepoExportSelection => ({
    included: true,
    starts: true,
    environment: true,
    savedEnvs: true,
    ...p,
  });

  it('drops repos that are not included and never exports config_files', () => {
    const d = doc({ api: full, web: repo() });
    const out = filterProfileDocument(d, {
      api: sel({}),
      web: sel({ included: false }),
    });
    expect(Object.keys(out.repos)).toEqual(['api']);
    expect(out.repos['api']?.config_files).toBeUndefined();
  });

  it('always keeps identity (git_url/type/java_version), gates the rest', () => {
    const out = filterProfileDocument(doc({ api: full }), {
      api: sel({ starts: false, environment: false, savedEnvs: false }),
    });
    const r = out.repos['api'];
    expect(r?.git_url).toBe('git@host:r.git');
    expect(r?.type).toBe('spring-boot');
    expect(r?.java_version).toBe('Java 17');
    // gated off → defaults, docker + saved_environments omitted
    expect(r?.command_profile).toBeNull();
    expect(r?.branch).toBeNull();
    expect(r?.selected).toBe(false);
    expect(r?.docker_compose_active).toBeUndefined();
    expect(r?.saved_environments).toBeUndefined();
  });

  it('includes only the selected categories', () => {
    const out = filterProfileDocument(doc({ api: full }), {
      api: sel({ starts: true, environment: false, savedEnvs: true }),
    });
    const r = out.repos['api'];
    expect(r?.command_profile).toBe('run-fast');
    expect(r?.branch).toBeNull(); // environment off
    expect(r?.docker_compose_active).toBeUndefined();
    expect(r?.saved_environments).toEqual({ 'a.yml': { dev: 'x' } });
  });
});

describe('hasSavedEnvironments', () => {
  it('is true only when at least one saved environment exists', () => {
    expect(hasSavedEnvironments(repo())).toBe(false);
    expect(hasSavedEnvironments(repo({ saved_environments: {} }))).toBe(false);
    expect(
      hasSavedEnvironments(repo({ saved_environments: { 'a.yml': { dev: 'x' } } })),
    ).toBe(true);
  });
});

describe('runLimited', () => {
  it('processes every item with bounded concurrency', async () => {
    const seen: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await runLimited([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      seen.push(n);
      inFlight -= 1;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('does not let one rejection sink the batch', async () => {
    const seen: number[] = [];
    await runLimited([1, 2, 3], 1, async (n) => {
      if (n === 2) {
        throw new Error('boom');
      }
      seen.push(n);
    });
    expect(seen).toEqual([1, 3]);
  });
});
