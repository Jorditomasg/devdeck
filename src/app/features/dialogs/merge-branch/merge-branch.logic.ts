/**
 * Pure merge-dialog logic (inventory-gui §20): form validation, source-list
 * exclusion with recents-separator adjustment, MergeRequest assembly, and
 * the 5-outcome → view mapping.
 */
import type { MergeOutcome, MergeRequest } from '../../../core/ipc/tauri.types';

/** Dialog target modes (v1 radio pair; `current` is not offered by the UI). */
export type MergeMode = 'existing' | 'new';

/** Live form state of the merge dialog. */
export interface MergeFormState {
  readonly mode: MergeMode;
  readonly destination: string;
  readonly base: string;
  readonly newBranch: string;
  readonly source: string;
  readonly sourceRemote: boolean;
  readonly pullTarget: boolean;
  readonly push: boolean;
}

/**
 * v1 `_collect_params` validation (§20). Returns the i18n key of the first
 * problem, or `null` when the form is valid. Order matters (v1 parity):
 * source → (existing: target, same-branch) / (new: base, name).
 */
export function validateMergeForm(form: MergeFormState): string | null {
  if (form.source.trim() === '') {
    return 'dialog.merge.error_no_source';
  }
  if (form.mode === 'existing') {
    if (form.destination.trim() === '') {
      return 'dialog.merge.error_no_target';
    }
    if (form.destination === form.source) {
      return 'dialog.merge.error_same_branch';
    }
    return null;
  }
  if (form.base.trim() === '') {
    return 'dialog.merge.error_no_base';
  }
  if (form.newBranch.trim() === '') {
    return 'dialog.merge.error_no_new';
  }
  return null;
}

/**
 * Source selector options (§20 "Source exclusion"): in `existing` mode the
 * chosen destination is excluded and the recents-separator index shifts down
 * when the excluded branch sat in the recents section; in `new` mode the
 * full list is offered.
 */
export function sourceOptions(
  branches: readonly string[],
  recentCount: number,
  mode: MergeMode,
  destination: string,
): { options: readonly string[]; recentCount: number } {
  if (mode !== 'existing' || destination === '') {
    return { options: branches, recentCount };
  }
  const index = branches.indexOf(destination);
  if (index === -1) {
    return { options: branches, recentCount };
  }
  return {
    options: branches.filter((b) => b !== destination),
    recentCount: index < recentCount ? recentCount - 1 : recentCount,
  };
}

/** Build the IPC `MergeRequest` from the validated form (§10.4 backend). */
export function buildMergeRequest(
  form: MergeFormState,
  dirtyIgnore: readonly string[],
): MergeRequest {
  return {
    source: form.source,
    sourceRemote: form.sourceRemote,
    targetMode: form.mode,
    ...(form.mode === 'existing'
      ? { target: form.destination }
      : { base: form.base, newBranch: form.newBranch.trim() }),
    pullTarget: form.pullTarget,
    push: form.push,
    dirtyIgnore,
  };
}

/** Visual tone of an outcome banner (distinct styling per state, §20). */
export type OutcomeTone = 'success' | 'warning' | 'error' | 'blocked';

/** Rendering instructions for one of the 5 merge outcomes. */
export interface OutcomeView {
  readonly tone: OutcomeTone;
  /** i18n key of the outcome log/banner line (`dialog.merge.done_*`). */
  readonly logKey: string;
  readonly params: Readonly<Record<string, string | number>>;
  /**
   * `true` → the run is final and the action button becomes Close
   * (ok / ok_push_failed / conflict); `false` → button resets for retry
   * (blocked_dirty / error). v1 `_report` (§20).
   */
  readonly terminal: boolean;
  /** `true` when the merge landed (ok / ok_push_failed) → revert point valid. */
  readonly applied: boolean;
  /** Files to list under the banner (dirty ≤20, or the conflicted paths). */
  readonly files: readonly string[];
}

/** Max dirty files listed under a blocked_dirty outcome (v1 §20). */
export const MAX_DIRTY_FILES_SHOWN = 20;

/** Map a `git_merge` outcome to its view (the documented 5-state handling). */
export function outcomeView(outcome: MergeOutcome): OutcomeView {
  switch (outcome.status) {
    case 'ok':
      return {
        tone: 'success',
        logKey: 'dialog.merge.done_ok',
        params: {},
        terminal: true,
        applied: true,
        files: [],
      };
    case 'ok_push_failed':
      return {
        tone: 'warning',
        logKey: 'dialog.merge.done_push_failed',
        params: { msg: outcome.message },
        terminal: true,
        applied: true,
        files: [],
      };
    case 'conflict':
      return {
        tone: 'warning',
        logKey: 'dialog.merge.done_conflict',
        params: { count: outcome.conflicts.length },
        terminal: true,
        applied: false,
        files: outcome.conflicts,
      };
    case 'blocked_dirty':
      return {
        tone: 'blocked',
        logKey: 'dialog.merge.done_dirty',
        params: {},
        terminal: false,
        applied: false,
        files: outcome.dirty.slice(0, MAX_DIRTY_FILES_SHOWN),
      };
    case 'error':
      return {
        tone: 'error',
        logKey: 'dialog.merge.done_error',
        params: { msg: outcome.message },
        terminal: false,
        applied: false,
        files: [],
      };
  }
}
