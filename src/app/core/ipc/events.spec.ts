/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import { EVT, IpcEvents } from './events';
import { FakeTauriBridge } from './tauri-bridge.fake';
import type { ServiceStatusEvent } from './tauri.types';

describe('EVT registry', () => {
  it('mirrors src-tauri/src/events.rs byte-for-byte', () => {
    expect(EVT.serviceStatusChanged).toBe('service://status-changed');
    expect(EVT.serviceLogLine).toBe('service://log-line');
    expect(EVT.repoScanProgress).toBe('repo://scan-progress');
    expect(EVT.gitBadge).toBe('git://badge');
    expect(EVT.dockerStatus).toBe('docker://status');
    expect(EVT.dockerSelection).toBe('docker://selection');
    expect(EVT.appSingleInstance).toBe('app://single-instance');
    expect(EVT.appCloseRequested).toBe('app://close-requested');
    expect(EVT.updateProgress).toBe('update://progress');
    expect(EVT.dialogResolved).toBe('dialog://resolved');
    expect(EVT.configChanged).toBe('config://changed');
    expect(EVT.profilesChanged).toBe('profiles://changed');
    expect(Object.values(EVT).length).toBe(12);
  });
});

describe('IpcEvents', () => {
  it('routes payloads to the typed handler and honors unlisten', async () => {
    const bridge = new FakeTauriBridge();
    const events = new IpcEvents(bridge);
    const seen: ServiceStatusEvent[] = [];

    const unlisten = await events.onServiceStatusChanged((e) => seen.push(e));
    bridge.emit(EVT.serviceStatusChanged, {
      name: 'api',
      status: 'running',
      port: 8080,
    });

    expect(seen).toEqual([{ name: 'api', status: 'running', port: 8080 }]);

    unlisten();
    bridge.emit(EVT.serviceStatusChanged, { name: 'api', status: 'stopped' });
    expect(seen.length).toBe(1);
    expect(bridge.listenerCount(EVT.serviceStatusChanged)).toBe(0);
  });

  it('supports independent subscriptions per event', async () => {
    const bridge = new FakeTauriBridge();
    const events = new IpcEvents(bridge);
    let badges = 0;
    let docker = 0;

    await events.onGitBadge(() => badges++);
    await events.onDockerStatus(() => docker++);
    bridge.emit(EVT.gitBadge, {
      name: 'api',
      branch: 'develop',
      behind: 0,
      staged: 0,
      unstaged: 0,
      conflicts: 0,
    });

    expect(badges).toBe(1);
    expect(docker).toBe(0);
  });
});
