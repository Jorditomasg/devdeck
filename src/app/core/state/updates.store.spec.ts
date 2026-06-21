/** TestBed-free specs (vitest-style). */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import { UpdatesStore } from './updates.store';

function makeStore(bridge: FakeTauriBridge): UpdatesStore {
  return new UpdatesStore(new IpcCommands(bridge), new IpcEvents(bridge));
}

describe('UpdatesStore', () => {
  it('exposes availability after a successful check', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.checkForUpdate, {
      available: true,
      version: '1.1.0',
      notes: 'New stuff',
      date: '2026-07-01',
    });
    const store = makeStore(bridge);

    await store.check();

    expect(store.available()).toBe(true);
    expect(store.info()?.version).toBe('1.1.0');
  });

  it('stays unavailable and swallows errors on silent startup check', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.checkForUpdate, () => {
      throw { kind: 'updater', message: 'offline' };
    });
    const store = makeStore(bridge);

    await store.checkSilently();

    expect(store.available()).toBe(false);
    expect(store.info()).toBeNull();
  });

  it('caches the changelog after first load', async () => {
    const releases = [
      {
        version: '1.0.0',
        date: '2026-06-21',
        added: ['x'],
        changed: [],
        fixed: [],
        removed: [],
      },
    ];
    const bridge = new FakeTauriBridge().whenInvoked(CMD.getChangelog, releases);
    const store = makeStore(bridge);

    const first = await store.loadChangelog();
    const second = await store.loadChangelog();

    expect(first).toEqual(releases);
    expect(second).toEqual(releases);
    expect(bridge.invokesOf(CMD.getChangelog).length).toBe(1);
  });

  it('maps progress events to a 0..1 ratio', async () => {
    const bridge = new FakeTauriBridge();
    const store = makeStore(bridge);

    await store.listenProgress();
    bridge.emit('update://progress', { downloaded: 50, contentLength: 200 });

    expect(store.progress()).toBe(0.25);
  });
});
