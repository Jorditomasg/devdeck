/**
 * Global panel container — batch controls over the selected repo cards
 * (inventory-gui.md §3): select-all, apply-branch / pull-all / install-all
 * (left) and start / stop / restart (right).
 *
 * Concurrency contracts (workspace.constants, §28): apply-branch fans out at
 * cap 3, pull-all is strictly sequential (cap 1), install-all caps at 3, and
 * batch restart waits `GLOBAL_RESTART_DELAY_MS` (3000 ms) between stop and
 * start. The three async git buttons disable together while any of them runs
 * (v1 `_set_async_btns_state`).
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from '@angular/core';

import { TranslationService } from '../../core/i18n/translation.service';
import { IpcCommands } from '../../core/ipc/commands';
import type { RepoInfo } from '../../core/ipc/tauri.types';
import { ReposStore } from '../../core/state/repos.store';
import { ButtonComponent, TooltipDirective } from '../../ui';
import { DialogService } from '../dialogs/dialog.service';
import { runBatch } from './batch';
import { RepoActionsService } from './state/repo-actions.service';
import { WorkspaceStore } from './state/workspace.store';
import {
  GIT_BATCH_CONCURRENCY,
  GLOBAL_RESTART_DELAY_MS,
  INSTALL_ALL_CONCURRENCY,
  PULL_ALL_CONCURRENCY,
} from './workspace.constants';

@Component({
  selector: 'app-global-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, TooltipDirective],
  styleUrl: './global-panel.component.scss',
  template: `
    <!-- Row 1 — title + select-all (§3) -->
    <div class="panel__row">
      <span class="panel__title">{{ i18n.t('label.global_panel_title') }}</span>
      <span class="panel__spacer"></span>
      <label class="panel__select-all">
        <input
          type="checkbox"
          [checked]="allSelected()"
          (change)="onSelectAll($any($event.target).checked)"
        />
        {{ i18n.t('label.select_all') }}
      </label>
    </div>

    <!-- Row 2 — branch tools (left) + service actions (right) (§3) -->
    <div class="panel__row">
      <span class="panel__label">{{ i18n.t('label.global_branch') }}</span>
      <input
        class="panel__branch"
        type="text"
        [placeholder]="i18n.t('label.branch_placeholder')"
        [value]="branchInput()"
        (input)="branchInput.set($any($event.target).value)"
        (keydown.enter)="onApplyBranch()"
      />
      <ui-button
        variant="blue"
        [disabled]="busy()"
        [uiTooltip]="i18n.t('tooltip.apply_branch')"
        (clicked)="onApplyBranch()"
      >{{ i18n.t('btn.apply_branch') }}</ui-button>
      <ui-button
        variant="blue"
        [disabled]="busy()"
        [uiTooltip]="i18n.t('tooltip.pull_all')"
        (clicked)="onPullAll()"
      >{{ i18n.t('btn.pull_all') }}</ui-button>
      <ui-button
        variant="neutral-alt"
        [disabled]="busy()"
        [uiTooltip]="i18n.t('tooltip.install_all')"
        (clicked)="onInstallAll()"
      >{{ i18n.t('btn.install_all') }}</ui-button>

      <span class="panel__spacer"></span>

      <ui-button
        variant="start"
        [uiTooltip]="i18n.t('tooltip.start_selected')"
        (clicked)="onStartSelected()"
      >{{ i18n.t('btn.start') }}</ui-button>
      <ui-button
        variant="danger"
        [uiTooltip]="i18n.t('tooltip.stop_selected')"
        (clicked)="onStopSelected()"
      >{{ i18n.t('btn.stop') }}</ui-button>
      <ui-button
        variant="warning"
        [uiTooltip]="i18n.t('tooltip.restart_selected')"
        (clicked)="onRestartSelected()"
      >{{ i18n.t('btn.restart') }}</ui-button>
    </div>
  `,
})
export class GlobalPanelComponent {
  protected readonly branchInput = signal('');
  /** Disables apply/pull/install together while a batch git op runs (§3). */
  protected readonly busy = signal(false);

  protected readonly allSelected = computed(() => {
    const repos = this.repos.repos();
    return (
      repos.length > 0 &&
      repos.every((r) => this.ws.cardSignal(r.name)().selected)
    );
  });

  constructor(
    protected readonly i18n: TranslationService,
    private readonly repos: ReposStore,
    private readonly ws: WorkspaceStore,
    private readonly actions: RepoActionsService,
    private readonly dialogs: DialogService,
    private readonly commands: IpcCommands,
  ) {}

  protected onSelectAll(selected: boolean): void {
    this.ws.setAllSelected(
      this.repos.repos().map((r) => r.name),
      selected,
    );
  }

  /**
   * Apply branch (§3): validates input + selection, checks branch existence
   * per repo (cap 3), checks out where it exists, then warns listing the
   * repos that don't have the branch.
   */
  protected async onApplyBranch(): Promise<void> {
    const branch = this.branchInput().trim();
    if (!branch) {
      await this.dialogs.warning(
        this.i18n.t('misc.warning_title'),
        this.i18n.t('misc.enter_branch'),
      );
      return;
    }
    const selected = await this.requireSelected();
    if (!selected) {
      return;
    }
    this.busy.set(true);
    try {
      const missing: string[] = [];
      await runBatch(selected, GIT_BATCH_CONCURRENCY, async (repo) => {
        const exists = await this.commands.git
          .hasBranch(repo.path, branch)
          .catch(() => false);
        if (!exists) {
          missing.push(repo.name);
          return;
        }
        if (this.ws.card(repo.name).branch === branch) {
          return; // v1 set_branch: skip when already on it (§6)
        }
        const result = await this.commands.git.checkout(repo.path, branch);
        if (result.ok) {
          this.ws.patchCard(repo.name, { branch });
          await this.repos.refreshBadge(repo.path).catch(() => undefined);
        }
      });
      if (missing.length > 0) {
        await this.dialogs.warning(
          this.i18n.t('misc.branch_not_found_title'),
          this.i18n.t('misc.branch_not_found_msg', {
            branch,
            repos: missing.map((name) => `• ${name}`).join('\n'),
          }),
        );
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Pull all (§3): strictly sequential over the selected repos. */
  protected async onPullAll(): Promise<void> {
    const selected = await this.requireSelected();
    if (!selected) {
      return;
    }
    this.busy.set(true);
    try {
      await runBatch(selected, PULL_ALL_CONCURRENCY, (repo) =>
        this.actions.pull(repo),
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** Install all (§3): selected repos with an install command, cap 3. */
  protected async onInstallAll(): Promise<void> {
    const selected = await this.requireSelected();
    if (!selected) {
      return;
    }
    const targets = selected.filter((r) => r.runInstallCmd);
    if (targets.length === 0) {
      await this.dialogs.info(
        this.i18n.t('btn.install_all'),
        this.i18n.t('log.global_all_installed'),
      );
      return;
    }
    this.busy.set(true);
    try {
      await runBatch(targets, INSTALL_ALL_CONCURRENCY, (repo) =>
        this.actions.install(repo, false),
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected onStartSelected(): void {
    for (const repo of this.selectedRepos()) {
      void this.actions.start(repo);
    }
  }

  protected onStopSelected(): void {
    for (const repo of this.selectedRepos()) {
      void this.actions.stop(repo);
    }
  }

  /** Restart (§3): stop all selected, start again after 3000 ms (§28). */
  protected onRestartSelected(): void {
    const repos = this.selectedRepos();
    for (const repo of repos) {
      void this.actions.stop(repo);
    }
    setTimeout(() => {
      for (const repo of repos) {
        void this.actions.start(repo);
      }
    }, GLOBAL_RESTART_DELAY_MS);
  }

  private selectedRepos(): readonly RepoInfo[] {
    return this.repos.repos().filter((r) => this.ws.card(r.name).selected);
  }

  /** Selection guard shared by the batch ops (v1 `misc.no_repos_selected`). */
  private async requireSelected(): Promise<readonly RepoInfo[] | null> {
    const selected = this.selectedRepos();
    if (selected.length === 0) {
      await this.dialogs.warning(
        this.i18n.t('misc.warning_title'),
        this.i18n.t('misc.no_repos_selected'),
      );
      return null;
    }
    return selected;
  }
}
