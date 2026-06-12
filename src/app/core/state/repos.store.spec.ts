/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from '../ipc/commands';
import { EVT, IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import type { GitBadgeEvent, RepoInfo } from '../ipc/tauri.types';
import { ReposStore } from './repos.store';

/** Minimal valid RepoInfo (camelCase wire shape). */
function repo(name: string, extra?: Partial<RepoInfo>): RepoInfo {
  return {
    name,
    path: `/ws/${name}`,
    repoType: 'spring-boot',
    profiles: [],
    environmentFiles: [],
    modules: [],
    envDefaultDir: '',
    envConfigWriterType: 'raw',
    envPullIgnorePatterns: [],
    envMainConfigFilename: '',
    envPatterns: [],
    uiConfig: { selectors: [], install: { check_dirs: [] } },
    features: [],
    portPatterns: [],
    dockerComposeFiles: [],
    detectedFramework: '',
    dangerFlags: [],
    ...extra,
  };
}

function badge(name: string): GitBadgeEvent {
  return { name, branch: 'develop', behind: 1, staged: 0, unstaged: 2, conflicts: 0 };
}

function makeStore(bridge: FakeTauriBridge): ReposStore {
  return new ReposStore(new IpcCommands(bridge), new IpcEvents(bridge));
}

describe('ReposStore', () => {
  it('scan() toggles scanning, stores the repo list and passes the paths', async () => {
    const bridge = new FakeTauriBridge();
    const store = makeStore(bridge);
    await store.init();

    let scanningDuringInvoke = false;
    bridge.whenInvoked(CMD.scanWorkspace, () => {
      scanningDuringInvoke = store.scanning();
      return [repo('alpha'), repo('beta')];
    });

    const result = await store.scan(['/ws']);

    expect(scanningDuringInvoke).toBe(true);
    expect(store.scanning()).toBe(false);
    expect(result.map((r) => r.name)).toEqual(['alpha', 'beta']);
    expect(store.repos().length).toBe(2);
    expect(bridge.invokesOf(CMD.scanWorkspace)[0]?.args).toEqual({
      paths: ['/ws'],
    });
  });

  it('folds git://badge events into the badge map (Rust poll loop feed)', async () => {
    const bridge = new FakeTauriBridge();
    const store = makeStore(bridge);
    await store.init();

    bridge.emit(EVT.gitBadge, badge('alpha'));

    expect(store.badges()['alpha']).toEqual({
      branch: 'develop',
      behind: 1,
      staged: 0,
      unstaged: 2,
      conflicts: 0,
    });
  });

  it('prunes badges of repos that disappeared on rescan', async () => {
    const bridge = new FakeTauriBridge();
    const store = makeStore(bridge);
    await store.init();

    bridge.emit(EVT.gitBadge, badge('alpha'));
    bridge.emit(EVT.gitBadge, badge('gone'));
    bridge.whenInvoked(CMD.scanWorkspace, [repo('alpha')]);

    await store.scan(['/ws']);

    expect(store.badges()['alpha']).toBeDefined();
    expect(store.badges()['gone']).toBeUndefined();
  });

  it('tracks scan progress and treats phase "done" as scan end', async () => {
    const bridge = new FakeTauriBridge();
    const store = makeStore(bridge);
    await store.init();

    bridge.emit(EVT.repoScanProgress, { phase: 'classifying', detected: 2, total: 5 });
    expect(store.scanProgress()?.detected).toBe(2);

    bridge.emit(EVT.repoScanProgress, { phase: 'done', detected: 5, total: 5 });
    expect(store.scanning()).toBe(false);
  });

  it('exposes docker-capable repo names and refreshBadge delegates', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.scanWorkspace, [
      repo('infra', { dockerComposeFiles: ['/ws/infra/docker-compose.yml'] }),
      repo('api'),
    ]);
    const store = makeStore(bridge);
    await store.init();
    await store.scan(['/ws']);

    expect(store.dockerRepoNames()).toEqual(['infra']);

    await store.refreshBadge('/ws/api');
    expect(bridge.invokesOf(CMD.gitRefreshBadge)[0]?.args).toEqual({
      repoPath: '/ws/api',
    });
  });
});
