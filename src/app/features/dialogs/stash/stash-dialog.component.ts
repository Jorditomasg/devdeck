/**
 * Stash-management dialog — add (with optional name + untracked), list, and
 * per-entry Apply / Pop / Drop. Mutations refresh the git badge and re-list;
 * progress streams via `service://log-line` (`stream: "git"`).
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
import type { OpOutput, StashEntry } from '../../../core/ipc/tauri.types';
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
  TableHeadDirective,
  TableRowDirective,
  TooltipDirective,
  type MenuEntry,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import { stashEntryLabel } from './stash.logic';

/** Rows shown per page in the stash table. */
const PAGE_SIZE = 15;

@Component({
  selector: 'app-stash-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './stash-dialog.component.scss',
  imports: [
    ButtonComponent,
    DialogLogComponent,
    DialogShellComponent,
    FilterTableComponent,
    IconButtonComponent,
    IconComponent,
    TableHeadDirective,
    TableRowDirective,
    TooltipDirective,
    TPipe,
  ],
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.stash.title' | t: { name: repoName() }"
      (closed)="closeSelf()"
    >
      <div class="stash">
        <div class="stash__panel">
          <section class="stash__section">
            <h3 class="stash__section-title">{{ 'dialog.stash.add_section' | t }}</h3>
            <div class="stash__row">
              <input
                #nameInput
                class="stash__input"
                type="text"
                [placeholder]="'dialog.stash.name_placeholder' | t"
                [value]="name()"
                [disabled]="busy()"
                (input)="name.set(nameInput.value)"
              />
              <label class="stash__check">
                <input
                  type="checkbox"
                  [checked]="includeUntracked()"
                  [disabled]="busy()"
                  (change)="includeUntracked.set(!includeUntracked())"
                />
                {{ 'dialog.stash.include_untracked' | t }}
              </label>
              <ui-button
                variant="blue"
                [loading]="busy()"
                [disabled]="hasChanges() === false"
                [uiTooltip]="hasChanges() === false ? ('git.no_changes' | t) : ''"
                (clicked)="add()"
              >
                {{ (busy() ? 'dialog.stash.btn_adding' : 'dialog.stash.btn_add') | t }}
              </ui-button>
            </div>
          </section>

          @if (entries().length === 0) {
            <p class="stash__empty">{{ 'dialog.stash.empty' | t }}</p>
          } @else {
            <ui-filter-table
              [items]="entries()"
              [haystack]="stashHaystack"
              [trackBy]="stashTrack"
              [pageSize]="pageSize"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              [prevLabel]="'pagination.prev' | t"
              [nextLabel]="'pagination.next' | t"
              (filteredChange)="visibleEntries.set($event)"
            >
              <tr *uiTableHead>
                <th class="stash__select-head">
                  <input
                    type="checkbox"
                    [checked]="allVisibleSelected()"
                    [indeterminate]="selected().size > 0 && !allVisibleSelected()"
                    [disabled]="busy()"
                    (change)="toggleSelectAll()"
                  />
                </th>
                <th>{{ 'dialog.stash.col_stash' | t }}</th>
                <th class="stash__actions-head">{{ 'dialog.stash.col_actions' | t }}</th>
              </tr>
              <!-- Right-click offers the same actions as the buttons. -->
              <tr *uiTableRow="let entry" (contextmenu)="onRowMenu($event, entry)">
                <td class="stash__select">
                  <input
                    type="checkbox"
                    [checked]="selected().has(entry.index)"
                    [disabled]="busy()"
                    (change)="toggleSelect(entry.index)"
                  />
                </td>
                <td><span class="stash__name">{{ label(entry) }}</span></td>
                <td>
                  <div class="stash__actions">
                    <ui-icon-button
                      size="sm"
                      variant="purple-alt"
                      [uiTooltip]="'dialog.stash.tip_files' | t"
                      (clicked)="viewFiles(entry)"
                    ><ui-icon name="file-text" [size]="14" /></ui-icon-button>
                    <ui-icon-button
                      size="sm"
                      variant="success"
                      [uiTooltip]="'dialog.stash.tip_apply' | t"
                      [disabled]="busy()"
                      (clicked)="apply(entry)"
                    ><ui-icon name="arrow-down" [size]="14" /></ui-icon-button>
                    <ui-icon-button
                      size="sm"
                      variant="blue"
                      [uiTooltip]="'dialog.stash.tip_pop' | t"
                      [disabled]="busy()"
                      (clicked)="pop(entry)"
                    ><ui-icon name="arrow-down-to-line" [size]="14" /></ui-icon-button>
                    <ui-icon-button
                      size="sm"
                      variant="danger-deep"
                      [uiTooltip]="'dialog.stash.tip_drop' | t"
                      [disabled]="busy()"
                      (clicked)="drop(entry)"
                    ><ui-icon name="trash" [size]="14" /></ui-icon-button>
                  </div>
                </td>
              </tr>
            </ui-filter-table>
            <div class="stash__bulk">
              <ui-button
                variant="danger-deep"
                [loading]="busy()"
                [disabled]="selected().size === 0"
                (clicked)="dropSelected()"
              >
                {{ 'dialog.stash.btn_drop_selected' | t: { count: selected().size } }}
              </ui-button>
            </div>
          }
        </div>

        <!-- Live git log, inline below the content — detachable + clearable. -->
        <ui-dialog-log
          [label]="'dialog.stash.log_label' | t"
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
export class StashDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly services = inject(ServicesStore);
  private readonly i18n = inject(TranslationService);
  private readonly menu = inject(ContextMenuService);

  protected readonly name = signal('');
  protected readonly includeUntracked = signal(true); // default ON (design)
  protected readonly entries = signal<readonly StashEntry[]>([]);
  protected readonly busy = signal(false);
  /** Working tree state — `null` until known; `false` disables Add. */
  protected readonly hasChanges = signal<boolean | null>(null);
  /** Indices checked for bulk drop — cleared on every reload (indices shift). */
  protected readonly selected = signal<ReadonlySet<number>>(new Set());
  /** What the table currently shows (post-filter) — the select-all scope. */
  protected readonly visibleEntries = signal<readonly StashEntry[]>([]);

  protected readonly allVisibleSelected = computed(() => {
    const visible = this.visibleEntries();
    const selected = this.selected();
    return visible.length > 0 && visible.every((e) => selected.has(e.index));
  });

  /** ui-filter-table haystack: searchable text = ref + message + branch. */
  protected readonly stashHaystack = (e: StashEntry): string =>
    `${stashEntryLabel(e)} ${e.branch ?? ''}`;
  protected readonly stashTrack = (e: StashEntry): number => e.index;
  /** Local result notices, appended below the streamed git lines (like merge). */
  private readonly extraLog = signal<readonly string[]>([]);
  /** Length of the repo's git log when the dialog opened — show only newer lines. */
  private logBaseline = 0;

  protected readonly pageSize = PAGE_SIZE;

  /** Dialog log = git-stream lines since the dialog opened + local notices. */
  protected readonly logLines = computed<readonly string[]>(() => {
    const streamed = this.services
      .logsFor(this.repoName())()
      .slice(this.logBaseline)
      .filter((l) => l.stream === 'git')
      .map((l) => l.line);
    return [...streamed, ...this.extraLog()];
  });

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

  /** Detach the live log into its own OS window (reuses `open_log_window`). */
  protected detachLog(): void {
    void this.commands
      .openLogWindow(this.repoName(), this.i18n.t('dialog.stash.title', { name: this.repoName() }))
      .catch((err: unknown) => console.error('open log window failed', err));
  }

  /** Clear the dialog's view of the log (non-destructive: baseline bump). */
  protected clearLog(): void {
    this.logBaseline = this.services.logsFor(this.repoName())().length;
    this.extraLog.set([]);
  }

  protected label(entry: StashEntry): string {
    return stashEntryLabel(entry);
  }

  protected async add(): Promise<void> {
    const message = this.name().trim() || null;
    const ok = await this.run(
      () => this.commands.git.stashPush(this.repoPath(), message, this.includeUntracked()),
      'dialog.stash.done_added',
    );
    if (ok) {
      this.name.set(''); // keep the typed name on failure so it can be retried
    }
  }

  /** Detached git window on the Stashes tab with this entry selected. */
  /** Right-click on a stash row — same actions as the buttons. */
  protected async onRowMenu(event: MouseEvent, entry: StashEntry): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const busy = this.busy();
    const items: MenuEntry[] = [
      { id: 'files', label: t('dialog.stash.btn_files'), icon: 'file-text' },
      { id: 'apply', label: t('dialog.stash.btn_apply'), icon: 'arrow-down', disabled: busy },
      { id: 'pop', label: t('dialog.stash.btn_pop'), icon: 'arrow-down-to-line', disabled: busy },
      {
        id: 'drop',
        label: t('dialog.stash.btn_drop'),
        icon: 'trash',
        danger: true,
        disabled: busy,
        separator: true,
      },
    ];

    switch (await this.menu.openFromEvent(event, items)) {
      case 'files': return this.viewFiles(entry);
      case 'apply': return this.apply(entry);
      case 'pop': return this.pop(entry);
      case 'drop': return this.drop(entry);
    }
  }

  protected viewFiles(entry: StashEntry): void {
    void this.commands.git
      .openWindow(this.repoName(), `${this.repoName()} — ${this.i18n.t('git.title_stashes')}`, {
        tab: 'stashes',
        stash: entry.index,
      })
      .catch((err: unknown) => console.error('open git window failed', err));
  }

  protected async apply(entry: StashEntry): Promise<void> {
    await this.run(
      () => this.commands.git.stashApply(this.repoPath(), entry.index),
      'dialog.stash.done_applied',
    );
  }

  protected async pop(entry: StashEntry): Promise<void> {
    await this.run(
      () => this.commands.git.stashPop(this.repoPath(), entry.index),
      'dialog.stash.done_popped',
    );
  }

  /** Check/uncheck every VISIBLE row (hidden-by-filter rows keep their state). */
  protected toggleSelectAll(): void {
    const visible = this.visibleEntries().map((e) => e.index);
    const all = this.allVisibleSelected();
    this.selected.update((set) => {
      const next = new Set(set);
      for (const index of visible) {
        if (all) {
          next.delete(index);
        } else {
          next.add(index);
        }
      }
      return next;
    });
  }

  protected toggleSelect(index: number): void {
    this.selected.update((set) => {
      const next = new Set(set);
      if (!next.delete(index)) {
        next.add(index);
      }
      return next;
    });
  }

  /** Drop every checked stash, highest index first so lower refs stay valid. */
  protected async dropSelected(): Promise<void> {
    const indices = [...this.selected()].sort((a, b) => b - a);
    if (indices.length === 0 || this.busy()) {
      return;
    }
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.stash.drop_confirm_title'),
      this.i18n.t('dialog.stash.drop_selected_confirm_msg', { count: indices.length }),
    );
    if (!confirmed) {
      return;
    }
    this.busy.set(true);
    try {
      for (const index of indices) {
        const result = await this.commands.git.stashDrop(this.repoPath(), index);
        this.appendLog(
          result.ok
            ? this.i18n.t('dialog.stash.done_dropped')
            : this.i18n.t('dialog.stash.failed', { msg: result.message }),
        );
      }
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.stash.failed', { msg: describe(err) }));
    } finally {
      void this.repos.refreshBadge(this.repoPath());
      await this.reload();
      this.busy.set(false);
    }
  }

  protected async drop(entry: StashEntry): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.stash.drop_confirm_title'),
      this.i18n.t('dialog.stash.drop_confirm_msg', { ref: `stash@{${entry.index}}` }),
    );
    if (!confirmed) {
      return;
    }
    await this.run(
      () => this.commands.git.stashDrop(this.repoPath(), entry.index),
      'dialog.stash.done_dropped',
    );
  }

  /**
   * Run a mutation, log its outcome, refresh the badge, and re-list. Resolves
   * `true` when the operation succeeded (`ok`), `false` otherwise.
   */
  private async run(op: () => Promise<OpOutput>, okKey: string): Promise<boolean> {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    try {
      const result = await op();
      this.appendLog(
        result.ok
          ? this.i18n.t(okKey)
          : this.i18n.t('dialog.stash.failed', { msg: result.message }),
      );
      void this.repos.refreshBadge(this.repoPath());
      await this.reload();
      return result.ok;
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.stash.failed', { msg: describe(err) }));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private async reload(): Promise<void> {
    const list = await this.commands.git.stashList(this.repoPath()).catch(() => [] as StashEntry[]);
    this.entries.set(list);
    this.selected.set(new Set()); // indices shift after any mutation

    // Paging self-heals on shrink: ui-filter-table clamps on read.
    // Working-tree state gates the Add button (nothing to stash → disabled).
    // Every mutation (add/apply/pop) changes it, so re-query alongside.
    void this.commands.git
      .changesList(this.repoPath())
      .then((changes) => this.hasChanges.set(changes.length > 0))
      .catch(() => this.hasChanges.set(null)); // unknown → keep Add enabled
  }

  private repoPath(): string {
    return this.repos.repoByName(this.repoName())?.path ?? '';
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
