/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import type { ProfileDocument, RepoProfile } from '../ipc/tauri.types';
import {
  ProfilesStore,
  normalizeJavaVersion,
  profileOverwriteDiff,
  profileReposEqual,
  repoProfileEquals,
  repoProfileFieldChanges,
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

describe('normalizeJavaVersion', () => {
  it('folds empties into undefined', () => {
    expect(normalizeJavaVersion('')).toBeUndefined();
    expect(normalizeJavaVersion(undefined)).toBeUndefined();
  });

  it('keeps real labels', () => {
    expect(normalizeJavaVersion('Java 17 (jdk-17)')).toBe('Java 17 (jdk-17)');
  });
});

describe('repoProfileEquals', () => {
  it('treats an empty java label as equal to absent (system default)', () => {
    expect(
      repoProfileEquals(repoProfile({ java_version: '' }), repoProfile()),
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

describe('repoProfileFieldChanges', () => {
  it('lists only the configurable fields that differ (identity ignored)', () => {
    expect(repoProfileFieldChanges(repoProfile(), repoProfile())).toEqual([]);
    // git_url is identity — not reported even when it changes.
    expect(
      repoProfileFieldChanges(repoProfile(), repoProfile({ git_url: 'x' })),
    ).toEqual([]);
    expect(
      repoProfileFieldChanges(
        repoProfile(),
        repoProfile({ branch: 'main', selected: false }),
      ),
    ).toEqual(['branch', 'selected']);
  });

  it('folds empty java against absent (no phantom change)', () => {
    expect(
      repoProfileFieldChanges(repoProfile({ java_version: '' }), repoProfile()),
    ).toEqual([]);
  });
});

describe('profileOverwriteDiff', () => {
  it('reports changed fields, added and removed repos, sorted', () => {
    const stored = doc({
      api: repoProfile(),
      gone: repoProfile(),
    });
    const current = doc({
      api: repoProfile({ profile: 'h2' }),
      web: repoProfile(),
    });
    expect(profileOverwriteDiff(stored, current)).toEqual([
      { repo: 'api', status: 'changed', fields: ['profile'] },
      { repo: 'gone', status: 'removed', fields: [] },
      { repo: 'web', status: 'added', fields: [] },
    ]);
  });

  it('is empty when nothing changed', () => {
    expect(profileOverwriteDiff(doc({ api: repoProfile() }), doc({ api: repoProfile() }))).toEqual(
      [],
    );
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

  it('a profiles://changed delete elsewhere deselects a vanished active profile', async () => {
    const bridge = new FakeTauriBridge()
      .whenInvoked(CMD.loadProfile, doc({ api: repoProfile() }))
      .whenInvoked(CMD.listProfiles, []); // re-list returns it gone
    const store = makeStore(bridge);
    await store.init();
    await store.load('KLK2');

    bridge.emit('profiles://changed', { group: null, saved: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.activeProfileName()).toBeNull();
    expect(store.hasSnapshot()).toBe(false);
  });

  it('a profiles://changed save elsewhere adopts the saved profile as active', async () => {
    const bridge = new FakeTauriBridge()
      .whenInvoked(CMD.listProfiles, ['KLK2'])
      .whenInvoked(CMD.loadProfile, doc({ api: repoProfile() }));
    const store = makeStore(bridge);
    await store.init();

    bridge.emit('profiles://changed', { group: null, saved: 'KLK2' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.activeProfileName()).toBe('KLK2');
    expect(store.hasSnapshot()).toBe(true);
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
