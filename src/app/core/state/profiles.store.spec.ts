/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import type { ProfileDocument, RepoProfile } from '../ipc/tauri.types';
import {
  JAVA_SYSTEM_DEFAULT_SENTINEL,
  ProfilesStore,
  normalizeJavaVersion,
  profileReposEqual,
  repoProfileEquals,
} from './profiles.store';

function repoProfile(extra?: Partial<RepoProfile>): RepoProfile {
  return {
    git_url: 'https://github.com/org/api.git',
    branch: 'develop',
    type: 'spring-boot',
    profile: 'mysql',
    profile_tracked: ['src/main/resources/application.yml'],
    command_profile: null,
    selected: true,
    ...extra,
  };
}

function doc(repos: Record<string, RepoProfile>): ProfileDocument {
  return { repos };
}

function makeStore(bridge: FakeTauriBridge): ProfilesStore {
  return new ProfilesStore(new IpcCommands(bridge), new IpcEvents(bridge));
}

describe('normalizeJavaVersion (v1 sentinel tolerance — accepted forever)', () => {
  it('folds the Spanish sentinel and empties into undefined', () => {
    expect(normalizeJavaVersion(JAVA_SYSTEM_DEFAULT_SENTINEL)).toBeUndefined();
    expect(normalizeJavaVersion('')).toBeUndefined();
    expect(normalizeJavaVersion(undefined)).toBeUndefined();
  });

  it('keeps real labels', () => {
    expect(normalizeJavaVersion('Java 17 (jdk-17)')).toBe('Java 17 (jdk-17)');
  });
});

describe('repoProfileEquals', () => {
  it('treats the java sentinel as equal to absent (system default)', () => {
    expect(
      repoProfileEquals(
        repoProfile({ java_version: JAVA_SYSTEM_DEFAULT_SENTINEL }),
        repoProfile(),
      ),
    ).toBe(true);
  });

  it('detects branch / selection / docker differences', () => {
    expect(repoProfileEquals(repoProfile(), repoProfile({ branch: 'main' }))).toBe(false);
    expect(repoProfileEquals(repoProfile(), repoProfile({ selected: false }))).toBe(false);
    expect(
      repoProfileEquals(
        repoProfile({ docker_profile_services: { 'docker-compose.yml': ['db'] } }),
        repoProfile({ docker_profile_services: { 'docker-compose.yml': ['db', 'web'] } }),
      ),
    ).toBe(false);
  });
});

describe('profileReposEqual (dirty-detection primitive)', () => {
  it('compares repos maps ignoring name/created metadata', () => {
    const a: ProfileDocument = { name: 'A', created: '2024', repos: { api: repoProfile() } };
    const b: ProfileDocument = { name: 'B', created: '2025', repos: { api: repoProfile() } };
    expect(profileReposEqual(a, b)).toBe(true);
  });

  it('differs when a repo is added or changed', () => {
    expect(
      profileReposEqual(doc({ api: repoProfile() }), doc({ api: repoProfile(), web: repoProfile() })),
    ).toBe(false);
    expect(
      profileReposEqual(doc({ api: repoProfile() }), doc({ api: repoProfile({ profile: 'h2' }) })),
    ).toBe(false);
  });

  it('handles nulls (no snapshot)', () => {
    expect(profileReposEqual(null, doc({}))).toBe(false);
    expect(profileReposEqual(null, null)).toBe(true);
  });
});

describe('ProfilesStore', () => {
  it('refresh() lists profiles for a group', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.listProfiles, ['KLK2', 'dev']);
    const store = makeStore(bridge);

    await store.refresh('Squad');

    expect(store.profiles()).toEqual(['KLK2', 'dev']);
    expect(store.group()).toBe('Squad');
    expect(bridge.invokesOf(CMD.listProfiles)[0]?.args).toEqual({ group: 'Squad' });
  });

  it('load() adopts the document as dirty baseline', async () => {
    const loaded = doc({ api: repoProfile() });
    const bridge = new FakeTauriBridge().whenInvoked(CMD.loadProfile, loaded);
    const store = makeStore(bridge);

    const result = await store.load('KLK2');

    expect(result).toEqual(loaded);
    expect(store.activeProfileName()).toBe('KLK2');
    expect(store.hasSnapshot()).toBe(true);
    expect(store.isDirtyAgainst(doc({ api: repoProfile() }))).toBe(false);
    expect(store.isDirtyAgainst(doc({ api: repoProfile({ branch: 'main' }) }))).toBe(true);
  });

  it('load() of a broken profile (null) keeps the previous baseline', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.loadProfile, null);
    const store = makeStore(bridge);

    const result = await store.load('broken');

    expect(result).toBeNull();
    expect(store.activeProfileName()).toBeNull();
    expect(store.hasSnapshot()).toBe(false);
  });

  it('isDirtyAgainst is false without a snapshot (nothing to compare)', () => {
    const store = makeStore(new FakeTauriBridge());
    expect(store.isDirtyAgainst(doc({ api: repoProfile() }))).toBe(false);
  });

  it('save() adopts the new baseline and refreshes the list', async () => {
    const saved = doc({ api: repoProfile() });
    const bridge = new FakeTauriBridge()
      .whenInvoked(CMD.saveProfile, '/data/profiles/KLK2.json')
      .whenInvoked(CMD.listProfiles, ['KLK2']);
    const store = makeStore(bridge);

    const path = await store.save({ name: 'KLK2', doc: saved, includeConfigFiles: true });

    expect(path).toBe('/data/profiles/KLK2.json');
    expect(store.activeProfileName()).toBe('KLK2');
    expect(store.profiles()).toEqual(['KLK2']);
    expect(bridge.invokesOf(CMD.saveProfile)[0]?.args).toEqual({
      name: 'KLK2',
      group: undefined,
      doc: saved,
      includeConfigFiles: true,
    });
  });

  it('delete() of the active profile clears name + snapshot', async () => {
    const bridge = new FakeTauriBridge()
      .whenInvoked(CMD.loadProfile, doc({ api: repoProfile() }))
      .whenInvoked(CMD.deleteProfile, true)
      .whenInvoked(CMD.listProfiles, []);
    const store = makeStore(bridge);
    await store.load('KLK2');

    const deleted = await store.delete('KLK2');

    expect(deleted).toBe(true);
    expect(store.activeProfileName()).toBeNull();
    expect(store.hasSnapshot()).toBe(false);
  });
});
