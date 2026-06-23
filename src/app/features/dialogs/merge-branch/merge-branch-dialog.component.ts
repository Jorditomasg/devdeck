/**
 * Merge-branch dialog with revert support — v1 `MergeBranchDialog`
 * (inventory-gui §20), the most complex dialog of the suite.
 *
 * Flow (faithful to the documented state machine):
 * 1. Branch pickers load via `git_branches` (reflog-recency order +
 *    separator) and `git_current_branch`; destination/base default-track the
 *    current branch until the user picks manually (§20 "default tracking").
 * 2. Source list excludes the chosen destination in existing mode, with the
 *    recents separator adjusted (`sourceOptions`).
 * 3. Merge run: `git_capture_revert_point` ALWAYS precedes `git_merge`
 *    (ipc-contract §2.4 #19); progress log lines arrive via
 *    `service://log-line` (`stream: "git"`, name = repo) and mirror into the
 *    dialog's live log.
 * 4. The 5 outcomes render distinct banners (`outcomeView`): ok /
 *    ok_push_failed / conflict are terminal (button → Close); blocked_dirty
 *    (with the dirty-file explanation, ≤20 files) and error reset the button
 *    for retry.
 * 5. Applied, non-pushed merges append to the revert-points list; each entry
 *    offers a confirmed `git_revert_merge`. Closing with unreverted merges
 *    asks to revert first; a pushed merge is NEVER reverted locally (v1
 *    policy — warns `revert_pushed_*` instead).
 *
 * Deviation from v1: the "cancel while the merge worker is in flight" path
 * (§20 `cancel_requested`) cannot exist — `git_merge` is a single IPC call
 * with no cancellation channel; while it runs the dialog knocks instead of
 * closing, and the revert offer appears as soon as the outcome lands.
 */
import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { RevertPoint } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ServicesStore } from '../../../core/state/services.store';
import {
  ButtonComponent,
  DialogLogComponent,
  DialogShellComponent,
  IconComponent,
  SearchableSelectComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import {
  buildMergeRequest,
  outcomeView,
  sourceOptions,
  validateMergeForm,
  type MergeFormState,
  type MergeMode,
  type OutcomeView,
} from './merge-branch.logic';

/** One revertible merge performed during this dialog session. */
interface RevertEntry {
  readonly point: RevertPoint;
  /** Human label: `source → target`. */
  readonly label: string;
}

@Component({
  selector: 'app-merge-branch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DialogLogComponent,
    DialogShellComponent,
    IconComponent,
    SearchableSelectComponent,
    TPipe,
  ],
  styleUrl: './merge-branch-dialog.component.scss',
  template: `
    <ui-dialog-shell
      #shell
      [dialogTitle]="'dialog.merge.title' | t: { name: repoName() }"
      (closed)="requestClose()"
    >
      <div class="merge">
        <!-- Target section (§20) -->
        <section class="merge__section">
          <h3 class="merge__section-title">{{ 'dialog.merge.target_section' | t }}</h3>

          <div class="merge__row">
            <label class="merge__radio">
              <input
                type="radio"
                name="merge-mode"
                [checked]="mode() === 'existing'"
                (change)="setMode('existing')"
              />
              {{ 'dialog.merge.target_branch' | t }}
            </label>
            <ui-searchable-select
              class="merge__combo merge__combo--dest"
              [options]="branches()"
              [recentCount]="recentCount()"
              [value]="destination()"
              [disabled]="mode() !== 'existing' || merging()"
              [placeholder]="loadingLabel()"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              (selectionChange)="onDestinationPick($event)"
            />
          </div>

          <div class="merge__row">
            <label class="merge__radio">
              <input
                type="radio"
                name="merge-mode"
                [checked]="mode() === 'new'"
                (change)="setMode('new')"
              />
              {{ 'dialog.merge.target_new' | t }}
            </label>
            <span class="merge__sublabel">{{ 'dialog.merge.base_label' | t }}</span>
            <ui-searchable-select
              class="merge__combo merge__combo--base"
              [options]="branches()"
              [recentCount]="recentCount()"
              [value]="base()"
              [disabled]="mode() !== 'new' || merging()"
              [placeholder]="loadingLabel()"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              (selectionChange)="onBasePick($event)"
            />
            <input
              #newBranchInput
              class="merge__input"
              type="text"
              [placeholder]="'dialog.merge.new_placeholder' | t"
              [value]="newBranch()"
              [disabled]="mode() !== 'new' || merging()"
              (input)="newBranch.set(newBranchInput.value)"
            />
          </div>
        </section>

        <!-- Source section (§20) -->
        <section class="merge__section">
          <h3 class="merge__section-title">{{ 'dialog.merge.source_section' | t }}</h3>
          <div class="merge__row">
            <span class="merge__sublabel">{{ 'dialog.merge.source_label' | t }}</span>
            <ui-searchable-select
              class="merge__combo merge__combo--source"
              [options]="sourceView().options"
              [recentCount]="sourceView().recentCount"
              [value]="source()"
              [disabled]="merging()"
              [placeholder]="loadingLabel()"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              (selectionChange)="source.set($event)"
            />
            <label class="merge__radio">
              <input
                type="radio"
                name="merge-origin"
                [checked]="sourceRemote()"
                (change)="sourceRemote.set(true)"
              />
              {{ 'dialog.merge.origin_remote' | t }}
            </label>
            <label class="merge__radio">
              <input
                type="radio"
                name="merge-origin"
                [checked]="!sourceRemote()"
                (change)="sourceRemote.set(false)"
              />
              {{ 'dialog.merge.origin_local' | t }}
            </label>
          </div>
        </section>

        <div class="merge__opts">
          <label class="merge__check">
            <input
              type="checkbox"
              [checked]="pullTarget()"
              [disabled]="merging()"
              (change)="pullTarget.set(!pullTarget())"
            />
            {{ 'dialog.merge.pull_opt' | t }}
          </label>
          <label class="merge__check">
            <input
              type="checkbox"
              [checked]="push()"
              [disabled]="merging()"
              (change)="push.set(!push())"
            />
            {{ 'dialog.merge.push_opt' | t }}
          </label>
        </div>

        @if (inlineError()) {
          <p class="merge__error">{{ inlineError() }}</p>
        }

        <!-- Outcome banner: distinct styling per state (§20) -->
        @if (outcome(); as view) {
          <div class="merge__outcome merge__outcome--{{ view.tone }}">
            <p class="merge__outcome-msg">{{ view.logKey | t: view.params }}</p>
            @if (view.files.length > 0) {
              <ul class="merge__outcome-files">
                @for (file of view.files; track file) {
                  <li>{{ file }}</li>
                }
              </ul>
            }
            @if (view.tone === 'blocked') {
              <div class="merge__stash-retry">
                <input
                  #stashNameInput
                  class="merge__input"
                  type="text"
                  [placeholder]="'dialog.merge.stash_name_placeholder' | t"
                  [value]="stashName()"
                  [disabled]="merging() || stashing()"
                  (input)="stashName.set(stashNameInput.value)"
                />
                <ui-button
                  variant="blue"
                  [loading]="merging() || stashing()"
                  (clicked)="stashAndRetry()"
                >
                  {{ 'dialog.merge.stash_and_retry' | t }}
                </ui-button>
              </div>
            }
          </div>
        }

        <!-- Revert points -->
        @if (revertPoints().length > 0) {
          <section class="merge__section">
            <h3 class="merge__section-title">{{ 'dialog.merge.revert_points' | t }}</h3>
            <!-- track $index: labels are user-facing text and can repeat
                 (same source/target merged twice) — index is append-only. -->
            @for (entry of revertPoints(); track $index) {
              <div class="merge__revert-row">
                <span class="merge__revert-label">{{ entry.label }}</span>
                <ui-button
                  variant="danger-deep"
                  size="sm"
                  [disabled]="merging() || reverting()"
                  (clicked)="revert(entry)"
                >
                  <ui-icon name="rotate-ccw" [size]="14" /> {{ 'dialog.merge.btn_revert' | t }}
                </ui-button>
              </div>
            }
          </section>
        }

        <!-- Live progress log (§20) — detachable to its own window + clearable. -->
        <ui-dialog-log
          [label]="'dialog.merge.log_label' | t"
          [lines]="logLines()"
          [emptyText]="'label.log_empty' | t"
          [detachText]="'btn.detach_log' | t"
          [clearText]="'btn.clear_log' | t"
          (detach)="detachLog()"
          (clear)="clearLog()"
        />
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" [disabled]="merging()" (clicked)="requestClose()">
          {{ 'btn.cancel' | t }}
        </ui-button>
        @if (terminalDone()) {
          <ui-button variant="success" (clicked)="closeSelf()">
            {{ 'btn.close' | t }}
          </ui-button>
        } @else {
          <ui-button variant="blue" [loading]="merging()" (clicked)="runMerge()">
            {{ (merging() ? 'dialog.merge.btn_running' : 'dialog.merge.btn') | t }}
          </ui-button>
        }
      </div>
    </ui-dialog-shell>
  `,
})
export class MergeBranchDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly services = inject(ServicesStore);
  private readonly i18n = inject(TranslationService);
  private readonly shell = viewChild.required<DialogShellComponent>('shell');

  // -- form state --------------------------------------------------------------
  protected readonly mode = signal<MergeMode>('existing');
  protected readonly destination = signal('');
  protected readonly base = signal('');
  protected readonly newBranch = signal('');
  protected readonly source = signal('');
  protected readonly sourceRemote = signal(true); // §20 default: remote
  protected readonly pullTarget = signal(true); // §20 default ON
  protected readonly push = signal(false); // §20 default OFF

  // -- branch data ---------------------------------------------------------------
  protected readonly branches = signal<readonly string[]>([]);
  protected readonly recentCount = signal(0);
  protected readonly loading = signal(true);
  private destTouched = false;
  private baseTouched = false;

  // -- run state ---------------------------------------------------------------
  protected readonly merging = signal(false);
  protected readonly reverting = signal(false);
  protected readonly inlineError = signal('');
  protected readonly outcome = signal<OutcomeView | null>(null);
  protected readonly revertPoints = signal<readonly RevertEntry[]>([]);
  /** A merge was applied AND pushed — never reverted locally (v1 policy). */
  private pushedMerge = false;
  private logBaseline = 0;
  /** Local status lines appended below the streamed git lines. */
  private readonly extraLog = signal<readonly string[]>([]);
  /** Optional name for the stash created from the blocked-dirty retry path. */
  protected readonly stashName = signal('');
  /** Guards the stash-and-retry window (the `merging` flag is only set once
   * `runMerge` starts, so a separate guard prevents a double-click from firing
   * two `stashPush` calls). */
  protected readonly stashing = signal(false);

  protected readonly sourceView = computed(() =>
    sourceOptions(this.branches(), this.recentCount(), this.mode(), this.destination()),
  );

  /** Terminal outcome reached → action button becomes Close (§20). */
  protected readonly terminalDone = computed(() => this.outcome()?.terminal === true);

  protected readonly loadingLabel = computed(() =>
    this.loading() ? this.i18n.t('label.loading') : '',
  );

  /** Dialog log = git-stream lines since the merge started + local notices. */
  protected readonly logLines = computed<readonly string[]>(() => {
    const streamed = this.services
      .logsFor(this.repoName())()
      .slice(this.logBaseline)
      .filter((l) => l.stream === 'git')
      .map((l) => l.line);
    return [...streamed, ...this.extraLog()];
  });

  /** Detach the live log into its own OS window (reuses `open_log_window`). */
  protected detachLog(): void {
    void this.commands
      .openLogWindow(this.repoName(), this.i18n.t('dialog.merge.title', { name: this.repoName() }))
      .catch((err: unknown) => console.error('open log window failed', err));
  }

  /** Clear the dialog's view of the log (non-destructive: baseline bump). */
  protected clearLog(): void {
    this.logBaseline = this.services.logsFor(this.repoName())().length;
    this.extraLog.set([]);
  }

  constructor() {
    super();
    // Inputs (repoName) are bound by the host AFTER construction, so defer the
    // first load to after the first render — otherwise repoPath() is empty and
    // the branch combos come back blank.
    afterNextRender(() => void this.loadBranches());
  }

  // -- selector logic (§20) -----------------------------------------------------

  protected setMode(mode: MergeMode): void {
    this.mode.set(mode);
    this.ensureSourceValid();
  }

  protected onDestinationPick(branch: string): void {
    this.destTouched = true; // stop default-tracking (§20)
    this.destination.set(branch);
    this.ensureSourceValid();
  }

  protected onBasePick(branch: string): void {
    this.baseTouched = true;
    this.base.set(branch);
  }

  /** Reset a colliding/vanished source to the first available option (§20). */
  private ensureSourceValid(): void {
    const { options } = this.sourceView();
    if (this.source() !== '' && !options.includes(this.source())) {
      this.source.set(options[0] ?? '');
    }
  }

  private async loadBranches(): Promise<void> {
    const repoPath = this.repoPath();
    if (repoPath === '') {
      this.loading.set(false);
      return;
    }
    try {
      const [ordered, current] = await Promise.all([
        this.commands.git.branches(repoPath),
        this.commands.git.currentBranch(repoPath),
      ]);
      this.branches.set(ordered.branches);
      this.recentCount.set(ordered.recentCount);
      // Default tracking: destination/base follow the current branch until
      // the user manually picks (§20).
      if (!this.destTouched) {
        this.destination.set(current);
      }
      if (!this.baseTouched) {
        this.base.set(current);
      }
      if (this.source() === '') {
        const { options } = this.sourceView();
        this.source.set(options.find((b) => b !== this.destination()) ?? '');
      }
    } finally {
      this.loading.set(false);
    }
  }

  // -- merge run (§20) ------------------------------------------------------------

  protected async runMerge(): Promise<void> {
    if (this.merging()) {
      return;
    }
    const form: MergeFormState = {
      mode: this.mode(),
      destination: this.destination(),
      base: this.base(),
      newBranch: this.newBranch(),
      source: this.source(),
      sourceRemote: this.sourceRemote(),
      pullTarget: this.pullTarget(),
      push: this.push(),
    };
    const errorKey = validateMergeForm(form);
    if (errorKey) {
      this.inlineError.set(this.i18n.t(errorKey));
      return;
    }
    this.inlineError.set('');
    this.outcome.set(null);
    this.extraLog.set([]);
    this.logBaseline = this.services.logsFor(this.repoName())().length;
    this.merging.set(true);

    const repoPath = this.repoPath();
    const request = buildMergeRequest(form, this.dirtyIgnore());
    try {
      // Revert point MUST be captured before the merge (ipc-contract §2.4 #19).
      const point = await this.commands.git.captureRevertPoint(repoPath, request);
      const result = await this.commands.git.merge(repoPath, request);
      const view = outcomeView(result);
      this.outcome.set(view);
      this.appendLog(this.i18n.t(view.logKey, view.params));
      if (view.applied) {
        if (result.status === 'ok' && form.push) {
          this.pushedMerge = true; // pushed merges are never reverted (v1)
        } else {
          const target =
            form.mode === 'existing' ? form.destination : form.newBranch.trim();
          this.revertPoints.update((entries) => [
            ...entries,
            { point, label: `${form.source} → ${target}` },
          ]);
        }
        void this.repos.refreshBadge(repoPath); // v1 on_complete refresh
      }
    } catch (err: unknown) {
      this.outcome.set({
        tone: 'error',
        logKey: 'dialog.merge.done_error',
        params: { msg: describe(err) },
        terminal: false,
        applied: false,
        files: [],
      });
      this.appendLog(this.i18n.t('dialog.merge.done_error', { msg: describe(err) }));
    } finally {
      this.merging.set(false);
    }
  }

  /**
   * Blocked-dirty escape hatch: stash the uncommitted changes (optional name,
   * untracked included) and re-run the merge. The stash is LEFT for manual
   * recovery from the Stash dialog (design decision — no auto-pop).
   */
  protected async stashAndRetry(): Promise<void> {
    if (this.merging() || this.stashing()) {
      return;
    }
    this.stashing.set(true);
    const repoPath = this.repoPath();
    this.appendLog(this.i18n.t('dialog.merge.stashing'));
    let stashed = false;
    try {
      const result = await this.commands.git.stashPush(
        repoPath,
        this.stashName().trim() || null,
        true,
      );
      if (!result.ok) {
        this.appendLog(this.i18n.t('dialog.merge.stash_failed', { msg: result.message }));
        return;
      }
      this.appendLog(this.i18n.t('dialog.merge.stashed'));
      void this.repos.refreshBadge(repoPath);
      this.stashName.set('');
      stashed = true;
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.merge.stash_failed', { msg: describe(err) }));
    } finally {
      // Release BEFORE re-running the merge: runMerge guards on `merging`, not
      // `stashing`, and would early-return if this were still set.
      this.stashing.set(false);
    }
    if (stashed) {
      await this.runMerge();
    }
  }

  // -- revert (§20 cancel/revert section) -----------------------------------------

  protected async revert(entry: RevertEntry): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.merge.revert_confirm_title'),
      this.i18n.t('dialog.merge.revert_confirm_msg'),
    );
    if (!confirmed) {
      return;
    }
    await this.doRevert(entry);
  }

  private async doRevert(entry: RevertEntry): Promise<boolean> {
    this.reverting.set(true);
    this.appendLog(this.i18n.t('dialog.merge.reverting'));
    try {
      const result = await this.commands.git.revertMerge(this.repoPath(), entry.point);
      if (result.status === 'ok') {
        this.revertPoints.update((entries) => entries.filter((e) => e !== entry));
        this.appendLog(this.i18n.t('dialog.merge.revert_done'));
        void this.repos.refreshBadge(this.repoPath());
        return true;
      }
      this.appendLog(
        this.i18n.t('dialog.merge.revert_error', { msg: result.message ?? '' }),
      );
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        this.i18n.t('dialog.merge.revert_error', { msg: result.message ?? '' }),
      );
      return false;
    } catch (err: unknown) {
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        this.i18n.t('dialog.merge.revert_error', { msg: describe(err) }),
      );
      return false;
    } finally {
      this.reverting.set(false);
    }
  }

  // -- close guard (§20) -----------------------------------------------------------

  protected async requestClose(): Promise<void> {
    if (this.merging()) {
      this.shell().knock(); // no cancel channel for an in-flight git_merge
      return;
    }
    if (this.revertPoints().length > 0) {
      const revertFirst = await this.dialogs.confirm(
        this.i18n.t('dialog.merge.revert_confirm_title'),
        this.i18n.t('dialog.merge.revert_confirm_msg'),
      );
      if (revertFirst) {
        // Undo in reverse order (latest merge first).
        const entries = [...this.revertPoints()].reverse();
        for (const entry of entries) {
          if (!(await this.doRevert(entry))) {
            return; // a failed revert keeps the dialog open
          }
        }
      }
      this.closeSelf();
      return;
    }
    if (this.pushedMerge) {
      // Policy: never revert after a successful push (§20).
      await this.dialogs.warning(
        this.i18n.t('dialog.merge.revert_pushed_title'),
        this.i18n.t('dialog.merge.revert_pushed_msg'),
      );
    }
    this.closeSelf();
  }

  // -- helpers --------------------------------------------------------------------

  private repoPath(): string {
    return this.repos.repoByName(this.repoName())?.path ?? '';
  }

  private dirtyIgnore(): readonly string[] {
    return this.repos.repoByName(this.repoName())?.envPullIgnorePatterns ?? [];
  }

  private appendLog(line: string): void {
    this.extraLog.update((lines) => [...lines, line]);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
