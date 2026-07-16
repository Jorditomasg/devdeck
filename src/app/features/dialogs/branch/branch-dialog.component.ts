/**
 * Branch-management dialog — create (off a base, optional checkout), and per
 * branch checkout / rename (prompt) / publish / delete-local (force fallback
 * when not merged) / delete-remote (confirmed). Mutations refresh the badge
 * and re-list; progress streams via `service://log-line` (`stream: "git"`).
 */
import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { OpOutput, OrderedBranches } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ServicesStore } from '../../../core/state/services.store';
import {
  ButtonComponent,
  ContextMenuService,
  DialogLogComponent,
  DialogShellComponent,
  FilterTableComponent,
  IconButtonComponent,
  IconComponent,
  SearchableSelectComponent,
  TableHeadDirective,
  TableRowDirective,
  TooltipDirective,
  type MenuEntry,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import { mergeLog, validateBranchName } from './branch.logic';

/** Rows shown per page in the branch table. */
const PAGE_SIZE = 15;

@Component({
  selector: 'app-branch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './branch-dialog.component.scss',
  imports: [
    ButtonComponent,
    DialogLogComponent,
    DialogShellComponent,
    FilterTableComponent,
    IconButtonComponent,
    IconComponent,
    SearchableSelectComponent,
    TableHeadDirective,
    TableRowDirective,
    TooltipDirective,
    TPipe,
  ],
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.branch.title' | t: { name: repoName() }"
      (closed)="closeSelf()"
    >
      <div class="branch">
        <div class="branch__panel">
          <section class="branch__section">
            <h3 class="branch__section-title">{{ 'dialog.branch.create_section' | t }}</h3>
            <div class="branch__row">
              <input
                #nameInput
                class="branch__input"
                type="text"
                [placeholder]="'dialog.branch.name_placeholder' | t"
                [value]="newName()"
                [disabled]="busy()"
                (input)="newName.set(nameInput.value)"
              />
              <span class="branch__sublabel">{{ 'dialog.branch.base_label' | t }}</span>
              <ui-searchable-select
                class="branch__combo"
                [options]="branches()"
                [recentCount]="recentCount()"
                [value]="base()"
                [disabled]="busy()"
                [searchPlaceholder]="'placeholder.search' | t"
                [noResultsText]="'placeholder.no_results' | t"
                (selectionChange)="base.set($event)"
              />
              <label class="branch__check">
                <input
                  type="checkbox"
                  [checked]="checkoutAfter()"
                  [disabled]="busy()"
                  (change)="checkoutAfter.set(!checkoutAfter())"
                />
                {{ 'dialog.branch.checkout_after' | t }}
              </label>
              <ui-button variant="blue" [loading]="busy()" (clicked)="create()">
                {{ 'dialog.branch.btn_create' | t }}
              </ui-button>
            </div>
            @if (createError()) {
              <p class="branch__error">{{ createError() }}</p>
            }
          </section>

          @if (branches().length === 0) {
            <p class="branch__empty">{{ 'dialog.branch.empty' | t }}</p>
          } @else {
            <ui-filter-table
              [items]="branches()"
              [haystack]="branchHaystack"
              [pageSize]="pageSize"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              [prevLabel]="'pagination.prev' | t"
              [nextLabel]="'pagination.next' | t"
              (filteredChange)="visibleBranches.set($event)"
            >
              <tr *uiTableHead>
                <th class="branch__select-head">
                  <input
                    type="checkbox"
                    [checked]="allVisibleSelected()"
                    [indeterminate]="selected().size > 0 && !allVisibleSelected()"
                    [disabled]="busy() || selectableVisible().length === 0"
                    (change)="toggleSelectAll()"
                  />
                </th>
                <th>{{ 'dialog.branch.col_branch' | t }}</th>
                <th class="branch__actions-head">{{ 'dialog.branch.col_actions' | t }}</th>
              </tr>
              <!-- Right-click offers the same actions as the buttons —
                   compact icon-buttons keep the table narrow. -->
              <tr *uiTableRow="let b" (contextmenu)="onRowMenu($event, b)">
                <td class="branch__select">
                  <input
                    type="checkbox"
                    [checked]="selected().has(b)"
                    [disabled]="busy() || b === current()"
                    (change)="toggleSelect(b)"
                  />
                </td>
                <td>
                  <span class="branch__name">{{ b }}</span>
                  @if (b === current()) {
                    <span class="branch__current">{{ 'dialog.branch.current_tag' | t }}</span>
                  }
                </td>
                <td>
                  <div class="branch__actions">
                    <ui-icon-button
                      size="sm"
                      variant="success"
                      [uiTooltip]="'dialog.branch.tip_checkout' | t"
                      [disabled]="busy() || b === current()"
                      (clicked)="checkout(b)"
                    ><ui-icon name="corner-down-left" [size]="14" /></ui-icon-button>
                    <ui-icon-button
                      size="sm"
                      variant="purple-alt"
                      [uiTooltip]="'dialog.branch.tip_history' | t"
                      (clicked)="openHistory(b)"
                    ><ui-icon name="history" [size]="14" /></ui-icon-button>
                    <ui-icon-button
                      size="sm"
                      variant="neutral"
                      [uiTooltip]="'dialog.branch.tip_rename' | t"
                      [disabled]="busy()"
                      (clicked)="rename(b)"
                    ><ui-icon name="pencil" [size]="14" /></ui-icon-button>
                    <ui-icon-button
                      size="sm"
                      variant="blue"
                      [uiTooltip]="'dialog.branch.tip_publish' | t"
                      [disabled]="busy()"
                      (clicked)="publish(b)"
                    ><ui-icon name="arrow-up" [size]="14" /></ui-icon-button>
                    <ui-icon-button
                      size="sm"
                      variant="purple"
                      [uiTooltip]="'dialog.branch.tip_delete_remote' | t"
                      [disabled]="busy()"
                      (clicked)="deleteRemote(b)"
                    ><ui-icon name="cloud" [size]="14" /></ui-icon-button>
                    <ui-icon-button
                      size="sm"
                      variant="danger-deep"
                      [uiTooltip]="'dialog.branch.tip_delete_local' | t"
                      [disabled]="busy() || b === current()"
                      (clicked)="deleteLocal(b)"
                    ><ui-icon name="trash" [size]="14" /></ui-icon-button>
                  </div>
                </td>
              </tr>
            </ui-filter-table>
            <div class="branch__bulk">
              <ui-button
                variant="danger-deep"
                [loading]="busy()"
                [disabled]="selected().size === 0"
                (clicked)="deleteSelected()"
              >
                {{ 'dialog.branch.btn_delete_selected' | t: { count: selected().size } }}
              </ui-button>
            </div>
          }
        </div>

        <!-- Live git log, inline below the content — detachable + clearable. -->
        <ui-dialog-log
          [label]="'dialog.branch.log_label' | t"
          [lines]="logLines()"
          [emptyText]="'label.log_empty' | t"
          [detachText]="'btn.detach_log' | t"
          [clearText]="'btn.clear_log' | t"
          [jumpText]="'log.jump_to_bottom' | t"
          (detach)="detachLog()"
          (clear)="clearLog()"
        />
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">{{ 'btn.close' | t }}</ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class BranchDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly services = inject(ServicesStore);
  private readonly i18n = inject(TranslationService);
  private readonly menu = inject(ContextMenuService);

  protected readonly branches = signal<readonly string[]>([]);
  protected readonly recentCount = signal(0);
  protected readonly current = signal('');
  protected readonly newName = signal('');
  protected readonly base = signal('');
  protected readonly checkoutAfter = signal(true);
  protected readonly busy = signal(false);
  protected readonly createError = signal('');
  /** Branch names checked for bulk delete — pruned to live entries on reload. */
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  /** What the table currently shows (post-filter) — the select-all scope. */
  protected readonly visibleBranches = signal<readonly string[]>([]);

  /** Select-all candidates: visible rows minus the current branch. */
  protected readonly selectableVisible = computed(() =>
    this.visibleBranches().filter((b) => b !== this.current()),
  );

  protected readonly allVisibleSelected = computed(() => {
    const visible = this.selectableVisible();
    const selected = this.selected();
    return visible.length > 0 && visible.every((b) => selected.has(b));
  });
  /**
   * Local result notices, each anchored to the number of streamed git lines
   * present when it was appended, so a burst of ops interleaves 1-to-1 with
   * the git stream instead of all-lines-then-all-notices.
   */
  private readonly extraLog = signal<readonly { at: number; line: string }[]>([]);
  /** Length of the repo's git log when the dialog opened — show only newer lines. */
  private logBaseline = 0;

  protected readonly pageSize = PAGE_SIZE;

  /** ui-filter-table haystack: a branch IS its searchable text. */
  protected readonly branchHaystack = (b: string): string => b;

  /** Git-stream lines since the dialog opened (the live op output). */
  private readonly streamedGit = computed<readonly string[]>(() =>
    this.services
      .logsFor(this.repoName())()
      .slice(this.logBaseline)
      .filter((l) => l.stream === 'git')
      .map((l) => l.line),
  );

  /** Dialog log = git-stream lines interleaved with local notices, in order. */
  protected readonly logLines = computed<readonly string[]>(() =>
    mergeLog(this.streamedGit(), this.extraLog()),
  );

  constructor() {
    super();
    // Inputs (repoName) are bound by the host AFTER construction, so defer the
    // first load to after the first render — otherwise repoPath() is empty and
    // the list comes back blank until a mutation triggers a second reload.
    afterNextRender(() => {
      this.logBaseline = this.services.logsFor(this.repoName())().length;
      void this.reload();
    });
  }

  /** Right-click on a branch row — same actions as the icon-buttons. */
  protected async onRowMenu(event: MouseEvent, b: string): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const isCurrent = b === this.current();
    const busy = this.busy();
    const items: MenuEntry[] = [
      {
        id: 'checkout',
        label: t('dialog.branch.btn_checkout'),
        icon: 'corner-down-left',
        disabled: busy || isCurrent,
      },
      { id: 'history', label: t('dialog.branch.btn_history'), icon: 'history' },
      { id: 'rename', label: t('dialog.branch.btn_rename'), icon: 'pencil', disabled: busy },
      { id: 'publish', label: t('dialog.branch.btn_publish'), icon: 'arrow-up', disabled: busy },
      {
        id: 'delete-remote',
        label: t('dialog.branch.btn_delete_remote'),
        icon: 'cloud',
        danger: true,
        disabled: busy,
        separator: true,
      },
      {
        id: 'delete-local',
        label: t('dialog.branch.btn_delete_local'),
        icon: 'trash',
        danger: true,
        disabled: busy || isCurrent,
      },
    ];

    switch (await this.menu.openFromEvent(event, items)) {
      case 'checkout': return this.checkout(b);
      case 'history': return this.openHistory(b);
      case 'rename': return this.rename(b);
      case 'publish': return this.publish(b);
      case 'delete-remote': return this.deleteRemote(b);
      case 'delete-local': return this.deleteLocal(b);
    }
  }

  /** Detach the live log into its own OS window (reuses `open_log_window`). */
  protected detachLog(): void {
    void this.commands
      .openLogWindow(this.repoName(), this.i18n.t('dialog.branch.title', { name: this.repoName() }))
      .catch((err: unknown) => console.error('open log window failed', err));
  }

  /** Clear the dialog's view of the log (non-destructive: baseline bump). */
  protected clearLog(): void {
    this.logBaseline = this.services.logsFor(this.repoName())().length;
    this.extraLog.set([]);
  }

  /** Detached git window scoped to this branch (git suite phase 2). */
  protected openHistory(branch: string): void {
    void this.commands.git
      .openWindow(this.repoName(), `${this.repoName()} — ${this.i18n.t('git.title_history')}`, {
        branch,
      })
      .catch((err: unknown) => console.error('open git window failed', err));
  }

  protected async create(): Promise<void> {
    const errorKey = validateBranchName(this.newName());
    if (errorKey) {
      this.createError.set(this.i18n.t(errorKey));
      return;
    }
    this.createError.set('');
    const name = this.newName().trim();
    const base = this.base().trim() || null;
    await this.run(
      () => this.commands.git.createBranch(this.repoPath(), name, base, this.checkoutAfter()),
      'dialog.branch.done_created',
    );
    this.newName.set('');
  }

  protected async checkout(branch: string): Promise<void> {
    await this.run(
      () => this.commands.git.checkout(this.repoPath(), branch),
      'dialog.branch.done_checked_out',
    );
  }

  protected async rename(branch: string): Promise<void> {
    const next = await this.dialogs.prompt(
      this.i18n.t('dialog.prompt.rename_title'),
      this.i18n.t('dialog.prompt.rename_msg', { name: branch }),
      { initialValue: branch },
    );
    if (next === null) {
      return;
    }
    const errorKey = validateBranchName(next);
    if (errorKey) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: this.i18n.t(errorKey) }));
      return;
    }
    await this.run(
      () => this.commands.git.renameBranch(this.repoPath(), branch, next.trim()),
      'dialog.branch.done_renamed',
    );
  }

  protected async publish(branch: string): Promise<void> {
    await this.run(
      () => this.commands.git.publishBranch(this.repoPath(), branch),
      'dialog.branch.done_published',
    );
  }

  protected async deleteRemote(branch: string): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_remote_confirm_title'),
      this.i18n.t('dialog.branch.delete_remote_confirm_msg', { name: branch }),
    );
    if (!confirmed) {
      return;
    }
    await this.run(
      () => this.commands.git.deleteRemoteBranch(this.repoPath(), branch),
      'dialog.branch.done_deleted',
    );
  }

  /** Check/uncheck every VISIBLE row (hidden-by-filter rows keep their state). */
  protected toggleSelectAll(): void {
    const visible = this.selectableVisible();
    const all = this.allVisibleSelected();
    this.selected.update((set) => {
      const next = new Set(set);
      for (const branch of visible) {
        if (all) {
          next.delete(branch);
        } else {
          next.add(branch);
        }
      }
      return next;
    });
  }

  protected toggleSelect(branch: string): void {
    this.selected.update((set) => {
      const next = new Set(set);
      if (!next.delete(branch)) {
        next.add(branch);
      }
      return next;
    });
  }

  /**
   * Delete every checked branch with `-d` (non-force). Failures — including
   * "not fully merged" — are logged and the branch stays checked; per-branch
   * force prompts don't belong in a bulk sweep.
   */
  protected async deleteSelected(): Promise<void> {
    const names = [...this.selected()];
    if (names.length === 0 || this.busy()) {
      return;
    }
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_confirm_title'),
      this.i18n.t('dialog.branch.delete_selected_confirm_msg', { count: names.length }),
    );
    if (!confirmed) {
      return;
    }
    this.busy.set(true);
    try {
      for (const name of names) {
        const result = await this.commands.git.deleteBranch(this.repoPath(), name, false);
        this.appendLog(
          result.ok
            ? this.i18n.t('dialog.branch.done_deleted')
            : this.i18n.t('dialog.branch.failed', { msg: result.message }),
        );
      }
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: describe(err) }));
    } finally {
      this.busy.set(false);
      await this.afterMutation();
    }
  }

  protected async deleteLocal(branch: string): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_confirm_title'),
      this.i18n.t('dialog.branch.delete_confirm_msg', { name: branch }),
    );
    if (!confirmed) {
      return;
    }
    const result = await this.runRaw(() =>
      this.commands.git.deleteBranch(this.repoPath(), branch, false),
    );
    if (result === null) {
      return;
    }
    if (result.ok) {
      this.appendLog(this.i18n.t('dialog.branch.done_deleted'));
      await this.afterMutation();
      return;
    }
    // Only a "not fully merged" failure warrants the forced -D path. Any other
    // failure (e.g. the name is a remote-only branch with no local ref) is just
    // logged — force-deleting would not fix it and the prompt would mislead.
    if (!/not fully merged/i.test(result.message)) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: result.message }));
      await this.afterMutation();
      return;
    }
    const force = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_force_title'),
      this.i18n.t('dialog.branch.delete_force_msg', { name: branch }),
    );
    if (!force) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: result.message }));
      return;
    }
    await this.run(
      () => this.commands.git.deleteBranch(this.repoPath(), branch, true),
      'dialog.branch.done_deleted',
    );
  }

  /** Run a mutation, log its outcome, refresh the badge, and re-list. */
  private async run(op: () => Promise<OpOutput>, okKey: string): Promise<void> {
    const result = await this.runRaw(op);
    if (result === null) {
      return;
    }
    this.appendLog(
      result.ok
        ? this.i18n.t(okKey)
        : this.i18n.t('dialog.branch.failed', { msg: result.message }),
    );
    await this.afterMutation();
  }

  /** Execute a mutation with the busy guard; returns the OpOutput or null. */
  private async runRaw(op: () => Promise<OpOutput>): Promise<OpOutput | null> {
    if (this.busy()) {
      return null;
    }
    this.busy.set(true);
    try {
      return await op();
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: describe(err) }));
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  private async afterMutation(): Promise<void> {
    void this.repos.refreshBadge(this.repoPath());
    await this.reload();
  }

  private async reload(): Promise<void> {
    const repoPath = this.repoPath();
    const [ordered, current] = await Promise.all([
      // Local-only list: branch management never operates on remote-only names.
      this.commands.git
        .branches(repoPath, undefined, false)
        .catch((): OrderedBranches => ({ branches: [], recentCount: 0 })),
      this.commands.git.currentBranch(repoPath).catch(() => ''),
    ]);
    this.branches.set(ordered.branches);
    this.recentCount.set(ordered.recentCount);
    this.current.set(current);
    // Prune stale checks: deleted branches vanish, the current branch (after a
    // checkout or rename) is never bulk-deletable.
    this.selected.update(
      (set) => new Set([...set].filter((b) => b !== current && ordered.branches.includes(b))),
    );
    // Paging self-heals on shrink: ui-filter-table clamps on read.
    if (this.base() === '') {
      this.base.set(current);
    }
  }

  private repoPath(): string {
    return this.repos.repoByName(this.repoName())?.path ?? '';
  }

  private appendLog(line: string): void {
    const at = this.streamedGit().length;
    this.extraLog.update((lines) => [...lines, { at, line }]);
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
