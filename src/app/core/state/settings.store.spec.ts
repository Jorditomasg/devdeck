/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from '../ipc/commands';
import { EVT, IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import type { AppConfig } from '../ipc/tauri.types';
import {
  SettingsStore,
  effectiveActiveGroup,
  workspaceGroupsOrDefault,
} from './settings.store';

function makeStore(bridge: FakeTauriBridge): SettingsStore {
  return new SettingsStore(new IpcCommands(bridge), new IpcEvents(bridge));
}

describe('workspaceGroupsOrDefault', () => {
  it('returns stored groups when present', () => {
    const config: AppConfig = {
      workspace_groups: [{ name: 'Work', paths: ['/a'] }],
    };
    expect(workspaceGroupsOrDefault(config)).toEqual([
      { name: 'Work', paths: ['/a'] },
    ]);
  });

  it('is empty when no groups exist (or config not loaded)', () => {
    expect(workspaceGroupsOrDefault({})).toEqual([]);
    expect(workspaceGroupsOrDefault(null)).toEqual([]);
  });
});

describe('effectiveActiveGroup (dangling tolerance)', () => {
  const config: AppConfig = {
    workspace_groups: [
      { name: 'A', paths: ['/a'] },
      { name: 'B', paths: ['/b'] },
    ],
    active_group: 'B',
  };

  it('resolves the named group', () => {
    expect(effectiveActiveGroup(config)?.name).toBe('B');
  });

  it('falls back to the first group for a dangling name', () => {
    expect(
      effectiveActiveGroup({ ...config, active_group: 'Removed' })?.name,
    ).toBe('A');
  });
});

describe('SettingsStore', () => {
  it('loads the config mirror and exposes defaults', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.getAppConfig, {
      language: 'es_ES',
      workspace_groups: [{ name: 'Main', paths: ['/ws'] }],
      active_group: 'Main',
      java_versions: { 'Java 17 (jdk-17)': '/jdk17' },
    } satisfies AppConfig);
    const store = makeStore(bridge);
    await store.init();

    expect(store.language()).toBe('es_ES');
    expect(store.minimizeToTray()).toBe(true); // default when absent
    expect(store.activeGroup()?.paths).toEqual(['/ws']);
    expect(store.javaVersions()['Java 17 (jdk-17)']).toBe('/jdk17');
  });

  it('defaults language to en_EN before/without config', () => {
    const store = makeStore(new FakeTauriBridge());
    expect(store.language()).toBe('en_EN');
  });

  it('setLanguage persists through IPC and mirrors locally', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.getAppConfig, {});
    const store = makeStore(bridge);
    await store.init();

    await store.setLanguage('es_ES');

    expect(bridge.invokesOf(CMD.setLanguage)[0]?.args).toEqual({
      language: 'es_ES',
    });
    expect(store.language()).toBe('es_ES');
  });

  it('setRepoState merges into the repo_state mirror', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.getAppConfig, {
      repo_state: { api: { selected: true } },
    } satisfies AppConfig);
    const store = makeStore(bridge);
    await store.init();

    await store.setRepoState('web', { selected: false, expanded: true });

    expect(store.repoStates()['api']).toEqual({ selected: true });
    expect(store.repoStates()['web']).toEqual({ selected: false, expanded: true });
    expect(bridge.invokesOf(CMD.setRepoState)[0]?.args).toEqual({
      repo: 'web',
      state: { selected: false, expanded: true },
    });
  });

  it('captures app://single-instance payloads', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.getAppConfig, {});
    const store = makeStore(bridge);
    await store.init();

    bridge.emit(EVT.appSingleInstance, { argv: ['exe', '/ws2'], cwd: '/ws2' });

    expect(store.singleInstance()?.cwd).toBe('/ws2');
  });

  it('lastProfileForActiveGroup reads last_profile_by_group', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.getAppConfig, {
      workspace_groups: [{ name: 'Main', paths: ['/ws'] }],
      active_group: 'Main',
      last_profile_by_group: { Main: 'KLK2' },
    } satisfies AppConfig);
    const store = makeStore(bridge);
    await store.init();

    expect(store.lastProfileForActiveGroup()).toBe('KLK2');
  });
});
