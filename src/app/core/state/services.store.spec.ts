/**
 * TestBed-free specs (vitest-style; runner wiring is a later task).
 * The FakeTauriBridge drives store transitions exactly like Rust would:
 * stubbed command results + emitted events.
 */
import { describe, expect, it } from 'vitest';

import { CMD, IpcCommands } from '../ipc/commands';
import { EVT, IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import type { ServiceLogEvent, ServiceStatusEvent } from '../ipc/tauri.types';
import {
  GLOBAL_LOG_MAX_LINES,
  SERVICE_LOG_MAX_LINES,
  ServicesStore,
  appendCapped,
} from './services.store';

function makeStore(bridge: FakeTauriBridge): ServicesStore {
  return new ServicesStore(new IpcCommands(bridge), new IpcEvents(bridge));
}

function statusEvent(partial: Partial<ServiceStatusEvent> & { name: string; status: ServiceStatusEvent['status'] }): ServiceStatusEvent {
  return { ...partial };
}

function logEvent(name: string, lines: string[], stream: ServiceLogEvent['stream'] = 'service'): ServiceLogEvent {
  return { name, stream, lines, timestampMs: 0 };
}

describe('appendCapped (ring buffer)', () => {
  it('appends below the cap without trimming', () => {
    expect(appendCapped([1, 2], [3], 5)).toEqual([1, 2, 3]);
  });

  it('drops the OLDEST entries when exceeding the cap', () => {
    expect(appendCapped([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5]);
  });

  it('keeps only the tail of an oversized batch', () => {
    expect(appendCapped([1], [2, 3, 4, 5, 6], 3)).toEqual([4, 5, 6]);
  });

  it('returns the same array for empty additions', () => {
    const existing = [1, 2];
    expect(appendCapped(existing, [], 3)).toBe(existing);
  });

  it('handles a batch exactly at the cap', () => {
    expect(appendCapped([0], [1, 2, 3], 3)).toEqual([1, 2, 3]);
  });
});

describe('ServicesStore', () => {
  it('subscribes to status and log events on init and hydrates', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.listServices, [
      { id: 'api', status: 'running', port: 8080, pid: 42 },
    ]);
    const store = makeStore(bridge);
    await store.init();

    expect(bridge.listenerCount(EVT.serviceStatusChanged)).toBe(1);
    expect(bridge.listenerCount(EVT.serviceLogLine)).toBe(1);
    expect(store.statusFor('api')).toBe('running');
    expect(store.services()['api']?.port).toBe(8080);
  });

  it('drives the 6-state machine from status events', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.listServices, []);
    const store = makeStore(bridge);
    await store.init();

    expect(store.statusFor('api')).toBe('stopped'); // never-seen default

    bridge.emit(EVT.serviceStatusChanged, statusEvent({ name: 'api', status: 'starting' }));
    expect(store.statusFor('api')).toBe('starting');

    bridge.emit(
      EVT.serviceStatusChanged,
      statusEvent({ name: 'api', status: 'running', port: 8081 }),
    );
    expect(store.statusFor('api')).toBe('running');
    expect(store.services()['api']?.port).toBe(8081);
    expect(store.runningCount()).toBe(1);
    expect(store.activeCount()).toBe(1);

    // A later event without port must NOT erase the detected port.
    bridge.emit(EVT.serviceStatusChanged, statusEvent({ name: 'api', status: 'stopping' }));
    expect(store.services()['api']?.port).toBe(8081);
    expect(store.activeCount()).toBe(1);
    expect(store.runningCount()).toBe(0);

    bridge.emit(
      EVT.serviceStatusChanged,
      statusEvent({ name: 'api', status: 'stopped', exitCode: 0 }),
    );
    expect(store.statusFor('api')).toBe('stopped');
    expect(store.activeCount()).toBe(0);
  });

  it('start() flips status optimistically and invokes the command', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.listServices, []);
    const store = makeStore(bridge);
    await store.init();

    await store.start('api', { customCommand: 'mvn spring-boot:run' });

    expect(store.statusFor('api')).toBe('starting');
    expect(bridge.invokesOf(CMD.startService)[0]?.args).toEqual({
      serviceId: 'api',
      customCommand: 'mvn spring-boot:run',
    });
  });

  it('reverts the optimistic status when the command rejects', async () => {
    const bridge = new FakeTauriBridge()
      .whenInvoked(CMD.listServices, [])
      .whenInvoked(CMD.startService, () => {
        throw { kind: 'process', message: 'spawn failed' };
      });
    const store = makeStore(bridge);
    await store.init();

    // Prior known status the card should fall back to, not a stuck "starting".
    bridge.emit(EVT.serviceStatusChanged, statusEvent({ name: 'api', status: 'stopped' }));

    await expect(store.start('api')).rejects.toMatchObject({ message: 'spawn failed' });
    expect(store.statusFor('api')).toBe('stopped');
    expect(store.activeCount()).toBe(0);
  });

  it('install() marks installing (the v2 status replacing v1 string reuse)', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.listServices, []);
    const store = makeStore(bridge);
    await store.init();

    await store.install('web', true, 'Java 17 (jdk-17)');

    expect(store.statusFor('web')).toBe('installing');
    expect(bridge.invokesOf(CMD.installDependencies)[0]?.args).toEqual({
      serviceId: 'web',
      reinstall: true,
      javaLabel: 'Java 17 (jdk-17)',
    });
  });

  it('appends log batches per service and caps at SERVICE_LOG_MAX_LINES', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.listServices, []);
    const store = makeStore(bridge);
    await store.init();

    bridge.emit(EVT.serviceLogLine, logEvent('api', ['a', 'b']));
    bridge.emit(EVT.serviceLogLine, logEvent('api', ['c'], 'install'));

    const logs = store.logsFor('api')();
    expect(logs.map((l) => l.line)).toEqual(['a', 'b', 'c']);
    expect(logs[2]?.stream).toBe('install');

    const big = Array.from({ length: SERVICE_LOG_MAX_LINES + 100 }, (_, i) => `l${i}`);
    bridge.emit(EVT.serviceLogLine, logEvent('api', big));
    const capped = store.logsFor('api')();
    expect(capped.length).toBe(SERVICE_LOG_MAX_LINES);
    expect(capped[capped.length - 1]?.line).toBe(`l${SERVICE_LOG_MAX_LINES + 99}`);
  });

  it('feeds the global log with service names and caps at GLOBAL_LOG_MAX_LINES', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.listServices, []);
    const store = makeStore(bridge);
    await store.init();

    bridge.emit(EVT.serviceLogLine, logEvent('api', ['hello']));
    expect(store.globalLog()[0]).toEqual({
      name: 'api',
      stream: 'service',
      line: 'hello',
    });

    const big = Array.from({ length: GLOBAL_LOG_MAX_LINES + 50 }, (_, i) => `g${i}`);
    bridge.emit(EVT.serviceLogLine, logEvent('web', big));
    expect(store.globalLog().length).toBe(GLOBAL_LOG_MAX_LINES);
  });

  it('clearLogs empties one service buffer only', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.listServices, []);
    const store = makeStore(bridge);
    await store.init();

    bridge.emit(EVT.serviceLogLine, logEvent('api', ['x']));
    bridge.emit(EVT.serviceLogLine, logEvent('web', ['y']));
    store.clearLogs('api');

    expect(store.logsFor('api')()).toEqual([]);
    expect(store.logsFor('web')().length).toBe(1);
  });
});
