/** TestBed-free specs (vitest-style). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the platform plugin — the store is the only unit under test here; the
// real registry/.desktop writes are the plugin's responsibility, not ours.
// `vi.hoisted` so the fns exist before the hoisted `vi.mock` factory runs.
const { enable, disable, isEnabled } = vi.hoisted(() => ({
  enable: vi.fn(async () => {}),
  disable: vi.fn(async () => {}),
  isEnabled: vi.fn(async () => false),
}));
vi.mock('@tauri-apps/plugin-autostart', () => ({ enable, disable, isEnabled }));

import { AutostartStore } from './autostart.store';

describe('AutostartStore', () => {
  beforeEach(() => {
    enable.mockClear();
    disable.mockClear();
    isEnabled.mockReset().mockResolvedValue(false);
  });

  it('load() reflects the OS state into the signal', async () => {
    isEnabled.mockResolvedValue(true);
    const store = new AutostartStore();
    expect(store.enabled()).toBe(false); // initial default
    expect(await store.load()).toBe(true);
    expect(store.enabled()).toBe(true);
  });

  it('set(true) enables and updates the signal', async () => {
    const store = new AutostartStore();
    await store.set(true);
    expect(enable).toHaveBeenCalledOnce();
    expect(disable).not.toHaveBeenCalled();
    expect(store.enabled()).toBe(true);
  });

  it('set(false) disables and updates the signal', async () => {
    const store = new AutostartStore();
    await store.set(false);
    expect(disable).toHaveBeenCalledOnce();
    expect(enable).not.toHaveBeenCalled();
    expect(store.enabled()).toBe(false);
  });
});
