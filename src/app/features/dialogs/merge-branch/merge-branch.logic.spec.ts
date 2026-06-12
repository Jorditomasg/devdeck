/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import type { MergeOutcome } from '../../../core/ipc/tauri.types';
import {
  MAX_DIRTY_FILES_SHOWN,
  buildMergeRequest,
  outcomeView,
  sourceOptions,
  validateMergeForm,
  type MergeFormState,
} from './merge-branch.logic';

function form(extra?: Partial<MergeFormState>): MergeFormState {
  return {
    mode: 'existing',
    destination: 'develop',
    base: '',
    newBranch: '',
    source: 'feature/x',
    sourceRemote: true,
    pullTarget: true,
    push: false,
    ...extra,
  };
}

describe('validateMergeForm (v1 _collect_params order, §20)', () => {
  it('valid existing-mode form passes', () => {
    expect(validateMergeForm(form())).toBeNull();
  });

  it('missing source comes first', () => {
    expect(validateMergeForm(form({ source: ' ', destination: '' }))).toBe(
      'dialog.merge.error_no_source',
    );
  });

  it('existing mode requires a destination', () => {
    expect(validateMergeForm(form({ destination: '' }))).toBe(
      'dialog.merge.error_no_target',
    );
  });

  it('rejects merging a branch into itself', () => {
    expect(validateMergeForm(form({ destination: 'feature/x' }))).toBe(
      'dialog.merge.error_same_branch',
    );
  });

  it('new mode requires base then name', () => {
    expect(validateMergeForm(form({ mode: 'new', base: '' }))).toBe(
      'dialog.merge.error_no_base',
    );
    expect(validateMergeForm(form({ mode: 'new', base: 'main', newBranch: ' ' }))).toBe(
      'dialog.merge.error_no_new',
    );
    expect(
      validateMergeForm(form({ mode: 'new', base: 'main', newBranch: 'release/1' })),
    ).toBeNull();
  });
});

describe('sourceOptions (§20 source exclusion)', () => {
  const branches = ['develop', 'main', 'feature/x', 'release/1'] as const;

  it('excludes the destination in existing mode', () => {
    const result = sourceOptions([...branches], 2, 'existing', 'main');
    expect(result.options).toEqual(['develop', 'feature/x', 'release/1']);
  });

  it('shifts the recents separator when the excluded branch was recent', () => {
    expect(sourceOptions([...branches], 2, 'existing', 'develop').recentCount).toBe(1);
    expect(sourceOptions([...branches], 2, 'existing', 'feature/x').recentCount).toBe(2);
  });

  it('offers the full list in new mode', () => {
    const result = sourceOptions([...branches], 2, 'new', 'develop');
    expect(result.options).toEqual(branches);
    expect(result.recentCount).toBe(2);
  });

  it('ignores an unknown destination', () => {
    const result = sourceOptions([...branches], 2, 'existing', 'ghost');
    expect(result.options).toEqual(branches);
    expect(result.recentCount).toBe(2);
  });
});

describe('buildMergeRequest', () => {
  it('builds an existing-mode request', () => {
    expect(buildMergeRequest(form(), ['*.env'])).toEqual({
      source: 'feature/x',
      sourceRemote: true,
      targetMode: 'existing',
      target: 'develop',
      pullTarget: true,
      push: false,
      dirtyIgnore: ['*.env'],
    });
  });

  it('builds a new-mode request (base + trimmed name, no target)', () => {
    const request = buildMergeRequest(
      form({ mode: 'new', base: 'main', newBranch: ' release/2 ' }),
      [],
    );
    expect(request.targetMode).toBe('new');
    expect(request.base).toBe('main');
    expect(request.newBranch).toBe('release/2');
    expect(request.target).toBeUndefined();
  });
});

describe('outcomeView (5-outcome mapping, §20 _report)', () => {
  const outcome = (extra: Partial<MergeOutcome>): MergeOutcome => ({
    status: 'ok',
    message: '',
    conflicts: [],
    dirty: [],
    ...extra,
  });

  it('ok → success, terminal, applied', () => {
    const view = outcomeView(outcome({ status: 'ok' }));
    expect(view).toMatchObject({
      tone: 'success',
      logKey: 'dialog.merge.done_ok',
      terminal: true,
      applied: true,
    });
  });

  it('ok_push_failed → warning, terminal, still applied (revertible)', () => {
    const view = outcomeView(outcome({ status: 'ok_push_failed', message: 'denied' }));
    expect(view).toMatchObject({
      tone: 'warning',
      terminal: true,
      applied: true,
      params: { msg: 'denied' },
    });
  });

  it('conflict → warning, terminal, lists conflicted files and count', () => {
    const view = outcomeView(
      outcome({ status: 'conflict', conflicts: ['a.txt', 'b.txt'] }),
    );
    expect(view).toMatchObject({ tone: 'warning', terminal: true, applied: false });
    expect(view.params).toEqual({ count: 2 });
    expect(view.files).toEqual(['a.txt', 'b.txt']);
  });

  it('blocked_dirty → blocked, retryable, lists at most 20 files', () => {
    const dirty = Array.from({ length: 25 }, (_, i) => `file-${i}`);
    const view = outcomeView(outcome({ status: 'blocked_dirty', dirty }));
    expect(view).toMatchObject({ tone: 'blocked', terminal: false, applied: false });
    expect(view.files).toHaveLength(MAX_DIRTY_FILES_SHOWN);
  });

  it('error → error, retryable, carries the message', () => {
    const view = outcomeView(outcome({ status: 'error', message: 'boom' }));
    expect(view).toMatchObject({
      tone: 'error',
      terminal: false,
      applied: false,
      params: { msg: 'boom' },
    });
  });
});
