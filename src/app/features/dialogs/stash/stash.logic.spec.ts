/** TestBed-free specs (vitest-style). */
import { describe, expect, it } from 'vitest';

import type { StashEntry } from '../../../core/ipc/tauri.types';
import { stashEntryLabel } from './stash.logic';

const entry = (extra?: Partial<StashEntry>): StashEntry => ({
  index: 0,
  branch: 'main',
  message: 'WIP',
  ...extra,
});

describe('stashEntryLabel', () => {
  it('renders index, branch and message', () => {
    expect(stashEntryLabel(entry({ index: 2, branch: 'develop', message: 'nightly' }))).toBe(
      'stash@{2} · develop — nightly',
    );
  });

  it('omits the branch separator when the branch is empty', () => {
    expect(stashEntryLabel(entry({ index: 0, branch: '', message: 'detached work' }))).toBe(
      'stash@{0} — detached work',
    );
  });
});
