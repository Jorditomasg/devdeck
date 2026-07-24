/**
 * Global panel container — a ONE-ROW command bar over the selected repo cards
 * (inventory-gui.md §3): the batch-git menu (left), live batch progress
 * (centre) and the selection readout + start / stop / restart (right).
 *
 * Layout rationale: the checkbox sits immediately left of the buttons it
 * governs (it used to live a full row away), the section title is an
 * `aria-label` on the host instead of a row of pixels restating where the user
 * already is, and the three batch-git actions live behind one dropdown because
 * they are weekly work sharing space with twenty-times-a-day work.
 *
 * Concurrency contracts (workspace.constants, §28): apply-branch fans out at
 * cap 3, pull-all is strictly sequential (cap 1), install-all caps at 3, and
 * batch restart waits `GLOBAL_RESTART_DELAY_MS` (3000 ms) between stop and
 * start. `progress` (not a bare boolean) is what disables the git menu while
 * any batch runs — pull-all is sequential and minutes long, so the user gets a
 * real counter, same as the stash dialog's bulk drop.
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
import { ServicesStore } from '../../core/state/services.store';
import {
  ButtonComponent,
  ContextMenuService,
  IconComponent,
  TooltipDirective,
  type MenuEntry,
} from '../../ui';
import { DialogService } from '../dialogs/dialog.service';
import { runBatch } from './batch';
import { activeAmong, selectionCounts } from './global-panel.logic';
import { RepoActionsService } from './state/repo-actions.service';
import { WorkspaceStore } from './state/workspace.store';
import {
  GIT_BATCH_CONCURRENCY,
  GLOBAL_RESTART_DELAY_MS,
  INSTALL_ALL_CONCURRENCY,
  PULL_ALL_CONCURRENCY,
} from './workspace.constants';

/** Live batch state: `null` when idle (also the enabled/disabled source). */
interface BatchProgress {
  readonly done: number;
  readonly total: number;
  /** Already-translated phase label ("Pulling", "Installing", …). */
  readonly label: string;
}

@Component({
  selector: 'app-global-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, TooltipDirective],
  styleUrl: './global-panel.component.scss',
  host: {
    role: 'group',
    '[attr.aria-label]': "i18n.t('label.global_panel_title')",
  },
  template: `
    <!-- Batch git (left) · progress (centre) · selection + service actions (right) -->
    <ui-button
      variant="neutral-alt"
      [disabled]="busy()"
      [uiTooltip]="i18n.t('tooltip.git_batch')"
      (clicked)="onGitMenu($event)"
    >
      <ui-icon name="git-branch" [size]="14" /> {{ i18n.t('btn.git_batch') }}
      <ui-icon name="chevron-down" [size]="12" />
    </ui-button>

    <!-- The <label> wrapper is what names the bar (same as the stash dialog). -->
    @if (progress(); as p) {
      <label class="panel__progress">
        {{ p.label }}
        <progress [value]="p.done" [max]="p.total"></progress>
        <span class="panel__progress-count">{{ p.done }}/{{ p.total }}</span>
      </label>
    }

    <span class="panel__spacer"></span>

    <label class="panel__select-all" [uiTooltip]="i18n.t('tooltip.select_all')">
      <input
        type="checkbox"
        [checked]="allSelected()"
        [indeterminate]="anySelected() && !allSelected()"
        [attr.aria-label]="i18n.t('label.select_all')"
        (change)="onSelectAll($any($event.target).checked)"
      />
      <span class="panel__count">{{ counts().selected }}/{{ counts().total }}</span>
    </label>

    <ui-button
      variant="start"
      [disabled]="!anySelected()"
      [uiTooltip]="i18n.t('tooltip.start_selected')"
      (clicked)="onStartSelected()"
    ><ui-icon name="play" [size]="14" /> {{ i18n.t('btn.start') }}{{ countSuffix() }}</ui-button>
    <ui-button
      variant="danger"
      [disabled]="!anySelected()"
      [uiTooltip]="i18n.t('tooltip.stop_selected')"
      (clicked)="onStopSelected()"
    ><ui-icon name="square" [size]="14" /> {{ i18n.t('btn.stop') }}{{ countSuffix() }}</ui-button>
    <ui-button
      variant="warning"
      [disabled]="!anySelected()"
      [uiTooltip]="i18n.t('tooltip.restart_selected')"
      (clicked)="onRestartSelected()"
    ><ui-icon name="refresh" [size]="14" /> {{ i18n.t('btn.restart') }}{{ countSuffix() }}</ui-button>
  `,
})
export class GlobalPanelComponent {
  /** Last branch typed into the apply-branch prompt — pre-fills the next one
   *  (the inline input is gone; its convenience is not). */
  private lastBranch = '';

  protected readonly progress = signal<BatchProgress | null>(null);

  /** Disables the git menu while any batch git op runs (§3). */
  protected readonly busy = computed(() => this.progress() !== null);

  protected readonly counts = computed(() =>
    selectionCounts(
      this.repos.repos().map((r) => r.name),
      (name) => this.ws.cardSignal(name)().selected,
    ),
  );

  protected readonly allSelected = computed(() => {
    const { selected, total } = this.counts();
    return total > 0 && selected === total;
  });

  /** Start/Stop/Restart grey out with nothing marked (visible feedback —
   * the git actions already dialog-warn; these used to no-op silently). */
  protected readonly anySelected = computed(() => this.counts().selected > 0);

  /** ` (3)` appended to the action labels — never a bare "Start" over 12 repos. */
  protected readonly countSuffix = computed(() => {
    const selected = this.counts().selected;
    return selected > 0 ? ` (${selected})` : '';
  });

  constructor(
    protected readonly i18n: TranslationService,
    private readonly repos: ReposStore,
    private readonly ws: WorkspaceStore,
    private readonly services: ServicesStore,
    private readonly actions: RepoActionsService,
    private readonly dialogs: DialogService,
    private readonly menu: ContextMenuService,
    private readonly commands: IpcCommands,
  ) {}

  protected onSelectAll(selected: boolean): void {
    this.ws.setAllSelected(
      this.repos.repos().map((r) => r.name),
      selected,
    );
  }

  /** Batch-git dropdown, anchored under the button like a real menu. */
  protected async onGitMenu(event: MouseEvent): Promise<void> {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const items: readonly MenuEntry[] = [
      {
        id: 'branch',
        label: this.i18n.t('btn.apply_branch_menu'),
        icon: 'git-branch',
        title: this.i18n.t('tooltip.apply_branch'),
      },
      {
        id: 'pull',
        label: this.i18n.t('btn.pull_all'),
        icon: 'arrow-down',
        title: this.i18n.t('tooltip.pull_all'),
      },
      {
        id: 'install',
        label: this.i18n.t('btn.install_all'),
        icon: 'package',
        title: this.i18n.t('tooltip.install_all'),
      },
    ];
    switch (await this.menu.open(rect.left, rect.bottom + 2, items)) {
      case 'branch':
        await this.onApplyBranch();
        break;
      case 'pull':
        await this.onPullAll();
        break;
      case 'install':
        await this.onInstallAll();
        break;
    }
  }

  /**
   * Apply branch (§3): prompts for the branch, checks existence per repo
   * (cap 3), checks out where it exists, then warns listing the repos that
   * don't have it. Cancelling the prompt IS the "no branch entered" path —
   * there is nothing left to validate.
   */
  private async onApplyBranch(): Promise<void> {
    const selected = await this.requireSelected();
    if (!selected) {
      return;
    }
    const entered = await this.dialogs.prompt(
      this.i18n.t('btn.apply_branch'),
      this.i18n.t('misc.enter_branch'),
      { initialValue: this.lastBranch, placeholder: this.i18n.t('label.branch_placeholder') },
    );
    const branch = entered?.trim();
    if (!branch) {
      return;
    }
    this.lastBranch = branch;
    const missing: string[] = [];
    try {
      await this.runWithProgress(
        this.i18n.t('label.batch_applying_branch'),
        selected,
        GIT_BATCH_CONCURRENCY,
        async (repo) => {
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
        },
      );
    } finally {
      this.progress.set(null);
    }
    if (missing.length > 0) {
      await this.dialogs.warning(
        this.i18n.t('misc.branch_not_found_title'),
        this.i18n.t('misc.branch_not_found_msg', {
          branch,
          repos: missing.map((name) => `• ${name}`).join('\n'),
        }),
      );
    }
  }

  /**
   * Pull all (§3): fetch the selected repos (cap 3), then pull ONLY the ones
   * actually behind, strictly sequential. The fetch is what makes the filter
   * honest — `behind` in the badge is relative to the LAST fetch, so a repo
   * that was never fetched reads 0 and would be skipped with remote commits
   * waiting. Per-repo confirmation is off: this batch already is the confirm.
   * Two progress phases because they have different sizes AND different pace.
   */
  private async onPullAll(): Promise<void> {
    const selected = await this.requireSelected();
    if (!selected) {
      return;
    }
    try {
      const behind: RepoInfo[] = [];
      await this.runWithProgress(
        this.i18n.t('label.batch_fetching'),
        selected,
        GIT_BATCH_CONCURRENCY,
        async (repo) => {
          await this.commands.git.fetch(repo.path).catch(() => undefined);
          const badge = await this.commands.git
            .statusSummary(repo.path)
            .catch(() => null);
          if ((badge?.behind ?? 0) > 0) {
            behind.push(repo);
          }
        },
      );
      if (behind.length === 0) {
        this.progress.set(null);
        await this.dialogs.info(
          this.i18n.t('btn.pull_all'),
          this.i18n.t('log.global_all_up_to_date'),
        );
        return;
      }
      await this.runWithProgress(
        this.i18n.t('label.batch_pulling'),
        behind,
        PULL_ALL_CONCURRENCY,
        (repo) => this.actions.pull(repo, false),
      );
    } finally {
      this.progress.set(null);
    }
  }

  /**
   * Install all (§3): selected repos with an install command that are NOT
   * already installed (`is_installed` over the type's `install_check_dirs`),
   * cap 3. A type without check dirs can't be probed → it still installs,
   * same as before (skipping it would make the action a silent no-op).
   */
  private async onInstallAll(): Promise<void> {
    const selected = await this.requireSelected();
    if (!selected) {
      return;
    }
    try {
      const targets: RepoInfo[] = [];
      await this.runWithProgress(
        this.i18n.t('label.batch_checking_install'),
        selected.filter((r) => r.runInstallCmd),
        INSTALL_ALL_CONCURRENCY,
        async (repo) => {
          const dirs = repo.uiConfig.install_check_dirs ?? [];
          const installed =
            dirs.length > 0 &&
            (await this.commands.process
              .isInstalled(repo.path, dirs)
              .catch(() => false));
          if (!installed) {
            targets.push(repo);
          }
        },
      );
      if (targets.length === 0) {
        this.progress.set(null);
        await this.dialogs.info(
          this.i18n.t('btn.install_all'),
          this.i18n.t('log.global_all_installed'),
        );
        return;
      }
      await this.runWithProgress(
        this.i18n.t('label.batch_installing'),
        targets,
        INSTALL_ALL_CONCURRENCY,
        (repo) => this.actions.install(repo, false),
      );
    } finally {
      this.progress.set(null);
    }
  }

  protected onStartSelected(): void {
    for (const repo of this.selectedRepos()) {
      void this.actions.start(repo);
    }
  }

  /**
   * Stop (§3): the one destructive batch here — it can kill a dozen live
   * processes — so it confirms, counting ONLY the repos actually alive. All
   * selected already stopped → nothing to confirm, nothing to do.
   */
  protected async onStopSelected(): Promise<void> {
    const repos = this.selectedRepos();
    const alive = activeAmong(
      repos.map((r) => r.name),
      (name) => this.services.services()[name]?.status,
    );
    if (alive === 0) {
      return;
    }
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('btn.stop'),
      this.i18n.tn('misc.confirm_stop_selected', alive),
    );
    if (!confirmed) {
      return;
    }
    for (const repo of repos) {
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

  /** `runBatch` + a live counter. Callers own the reset (`finally`). */
  private async runWithProgress<T>(
    label: string,
    items: readonly T[],
    cap: number,
    task: (item: T) => Promise<unknown>,
  ): Promise<void> {
    this.progress.set({ done: 0, total: items.length, label });
    await runBatch(items, cap, async (item) => {
      try {
        await task(item);
      } finally {
        this.progress.update((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    });
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
