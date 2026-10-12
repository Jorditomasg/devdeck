/**
 * "Worktrees (N)" section of a repo card (git-worktrees design 2026-10-12):
 * one `ui-worktree-row` per linked worktree of the parent, each a full service
 * of its own (`"<repo>@<folder>"` id) — start/stop/restart in parallel with the
 * parent, per-worktree port, logs/terminal/history windows, delete. Container:
 * injects the stores, translates every label.
 */
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { RepoInfo } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ServicesStore } from '../../../core/state/services.store';
import { SettingsStore } from '../../../core/state/settings.store';
import {
  IconButtonComponent,
  IconComponent,
  WorktreeRowComponent,
  type WorktreeRowText,
} from '../../../ui';
import { OpenerService } from '../opener.service';
import { RepoActionsService } from '../state/repo-actions.service';
import { dotStatusFor, visibilityForStatus } from './card-visibility';

interface WorktreeRowVm {
  readonly repo: RepoInfo;
  readonly status: ReturnType<typeof dotStatusFor>;
  readonly port: number | null;
  readonly changes: number;
  readonly canStart: boolean;
  readonly canStop: boolean;
}

@Component({
  selector: 'app-worktree-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconButtonComponent, IconComponent, TPipe, WorktreeRowComponent],
  styleUrl: './worktree-section.component.scss',
  template: `
    <div class="wts__head">
      <button type="button" class="wts__toggle" (click)="open.set(!open())">
        <ui-icon [name]="open() ? 'chevron-down' : 'chevron-up'" [size]="14" />
        {{ 'label.worktrees' | t: { count: rows().length } }}
      </button>
      <ui-icon-button size="sm" [title]="'tooltip.worktree_new' | t" (clicked)="onAdd()">
        <ui-icon name="plus" [size]="14" />
      </ui-icon-button>
      <ui-icon-button size="sm" [title]="'tooltip.worktree_prune' | t" (clicked)="onPrune()">
        <ui-icon name="eraser" [size]="14" />
      </ui-icon-button>
    </div>
    @if (open()) {
      @for (row of rows(); track row.repo.name) {
        <ui-worktree-row
          [branch]="row.repo.worktreeBranch ?? null"
          [path]="row.repo.path"
          [status]="row.status"
          [port]="row.port"
          [portConfigurable]="!!row.repo.portInjection"
          [changes]="row.changes"
          [canStart]="row.canStart"
          [canStop]="row.canStop"
          [text]="text()"
          (portChange)="onPort(row.repo, $event)"
          (start)="actions.start(row.repo)"
          (stop)="actions.stop(row.repo)"
          (restart)="actions.restart(row.repo)"
          (logs)="onLogs(row.repo)"
          (folder)="opener.openPath(row.repo.path)"
          (terminal)="onTerminal(row.repo)"
          (history)="onHistory(row.repo)"
          (remove)="actions.removeWorktree(row.repo)"
        />
      }
    }
  `,
})
export class WorktreeSectionComponent {
  readonly parent = input.required<RepoInfo>();

  protected readonly open = signal(true);

  protected readonly rows = computed<readonly WorktreeRowVm[]>(() => {
    const runtimes = this.services.services();
    const badges = this.repos.badges();
    const ports = this.settings.config()?.worktree_ports ?? {};
    return this.repos.worktreesOf(this.parent().name).map((repo) => {
      const runtime = runtimes[repo.name];
      const status = runtime?.status ?? 'stopped';
      const vis = visibilityForStatus(status);
      const badge = badges[repo.name];
      return {
        repo,
        status: dotStatusFor(status),
        port: ports[repo.name] ?? runtime?.port ?? null,
        changes: badge ? badge.staged + badge.unstaged : 0,
        canStart: vis.showStart && vis.startEnabled,
        canStop: vis.showStop && vis.stopEnabled,
      };
    });
  });

  protected readonly text = computed<WorktreeRowText>(() => ({
    detached: this.i18n.t('label.worktree_detached'),
    portTip: this.i18n.t('tooltip.worktree_port'),
    portNotConfigurable: this.i18n.t('tooltip.worktree_port_unsupported'),
    changesTip: this.i18n.t('tooltip.worktree_changes'),
    start: this.i18n.t('tooltip.start_btn'),
    stop: this.i18n.t('tooltip.stop_btn'),
    restart: this.i18n.t('tooltip.restart_btn'),
    logs: this.i18n.t('label.log_section'),
    folder: this.i18n.t('menu.open_folder'),
    terminal: this.i18n.t('menu.open_terminal'),
    history: this.i18n.t('btn.git_history'),
    remove: this.i18n.t('tooltip.worktree_remove'),
  }));

  constructor(
    private readonly repos: ReposStore,
    private readonly services: ServicesStore,
    private readonly settings: SettingsStore,
    private readonly commands: IpcCommands,
    private readonly i18n: TranslationService,
    protected readonly actions: RepoActionsService,
    protected readonly opener: OpenerService,
  ) {}

  protected onAdd(): void {
    void this.actions.addWorktree(this.parent());
  }

  protected onPrune(): void {
    void this.actions.pruneWorktrees(this.parent());
  }

  protected onPort(repo: RepoInfo, port: number | null): void {
    void this.actions.setWorktreePort(repo, port);
  }

  private title(repo: RepoInfo, key: string): string {
    return `${repo.worktreeBranch ?? repo.name} — ${this.i18n.t(key)}`;
  }

  protected onLogs(repo: RepoInfo): void {
    void this.commands
      .openLogWindow(repo.name, this.title(repo, 'label.log_section'))
      .catch((err: unknown) => console.error('open log window failed', err));
  }

  protected onTerminal(repo: RepoInfo): void {
    void this.commands.terminal
      .openWindow(repo.name, repo.path, this.title(repo, 'label.terminal'))
      .catch((err: unknown) => console.error('open terminal window failed', err));
  }

  protected onHistory(repo: RepoInfo): void {
    void this.commands.git
      .openWindow(repo.name, this.title(repo, 'git.title_history'))
      .catch((err: unknown) => console.error('open git window failed', err));
  }
}
