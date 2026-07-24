import { describe, expect, it } from 'vitest';
import type { ServiceStatus } from '../../core/ipc/tauri.types';
import { activeAmong, selectionCounts } from './global-panel.logic';

describe('selectionCounts (global panel §3 selection readout)', () => {
  const selected = new Set(['a', 'c']);
  const isSelected = (name: string): boolean => selected.has(name);

  it('counts the selected names against the total', () => {
    expect(selectionCounts(['a', 'b', 'c'], isSelected)).toEqual({ selected: 2, total: 3 });
  });

  it('an empty workspace is neither all- nor partially selected', () => {
    const counts = selectionCounts([], isSelected);
    expect(counts).toEqual({ selected: 0, total: 0 });
    // The template derives both flags from this — 0/0 must NOT read as "all".
    expect(counts.total > 0 && counts.selected === counts.total).toBe(false);
    expect(counts.selected > 0).toBe(false);
  });
});

describe('activeAmong (global panel §3 stop-confirmation scope)', () => {
  const statuses: Record<string, ServiceStatus> = {
    up: 'running',
    booting: 'starting',
    dying: 'stopping',
    installing: 'installing',
    down: 'stopped',
    broken: 'error',
  };
  const statusOf = (name: string): ServiceStatus | undefined => statuses[name];

  it('counts every status with a live process, not just running', () => {
    expect(activeAmong(['up', 'booting', 'dying', 'installing'], statusOf)).toBe(4);
  });

  it('ignores stopped, errored and unknown repos', () => {
    expect(activeAmong(['down', 'broken', 'never-started'], statusOf)).toBe(0);
  });

  it('counts only the names it is given', () => {
    expect(activeAmong(['up', 'down'], statusOf)).toBe(1);
  });
});
