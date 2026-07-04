/**
 * Working-tree changes view (design doc
 * docs/superpowers/specs/2026-07-03-git-changes-window-design.md) — the
 * third git-window mode (`?git=<repo>&tab=changes`, changes-badge entry).
 *
 * Left: staged / changes groups with per-row safe actions (stage, unstage,
 * discard-with-confirm). Right: working diff of the selected file, or the
 * EDITABLE CodeMirror with Guardar + Ctrl+S. Container: owns all IPC and
 * translates every string. Every action refreshes list + diff + card badge.
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { TranslationService } from '../../../core/i18n/translation.service';
import { TPipe } from '../../../core/i18n/t.pipe';
import { IpcCommands } from '../../../core/ipc/commands';
import { IpcEvents } from '../../../core/ipc/events';
import { TauriBridge } from '../../../core/ipc/tauri-bridge';
import type { GitChangeEntry, OpOutput } from '../../../core/ipc/tauri.types';
import { openDialogWindowForResult } from '../../dialogs/dialog-window.bridge';
import {
  ButtonComponent,
  ContextMenuService,
  DiffViewComponent,
  IconComponent,
  SpinnerComponent,
  type MenuEntry,
} from '../../../ui';
// Direct imports ON PURPOSE (not via the ui barrel): keeps CodeMirror out of
// the initial bundle — see the note in ui/index.ts.
import { CodeEditComponent } from '../../../ui/code-edit/code-edit.component';
import { canEdit, changeKey, groupChanges, isUntracked } from './changes-view.logic';

type PaneMode = 'diff' | 'edit';

@Component({
  selector: 'git-changes-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, CodeEditComponent, DiffViewComponent, IconComponent, SpinnerComponent, TPipe],
  styleUrl: './changes-view.component.scss',
  template: `
    @if (error()) {
      <div class="chg__error">
        <ui-icon name="alert-triangle" [size]="14" /> {{ error() }}
      </div>
    }

    <div class="chg__layout">
      <aside class="chg__files">
        @if (loading() && entries().length === 0) {
          <div class="chg__center"><ui-spinner /></div>
        } @else if (entries().length === 0) {
          <div class="chg__center chg__muted">{{ 'git.no_changes' | t }}</div>
        } @else {
          @if (groups().staged.length > 0) {
            <h3 class="chg__group">
              {{ 'git.changes_staged' | t }} ({{ groups().staged.length }})
            </h3>
            <ul class="chg__list">
              @for (entry of groups().staged; track key(entry)) {
                <li
                  class="chg__file"
                  [class.chg__file--selected]="key(entry) === selectedKey()"
                  (click)="onSelect(entry)"
                  (contextmenu)="onFileMenu($event, entry)"
                >
                  <span class="chg__status chg__status--{{ entry.status }}">{{
                    entry.status
                  }}</span>
                  <span class="chg__path" [title]="entry.path">
                    @if (entry.oldPath) {
                      <span class="chg__old">{{ entry.oldPath }} → </span>
                    }{{ entry.path }}
                  </span>
                  <button
                    class="chg__action"
                    type="button"
                    [title]="'git.unstage' | t"
                    (click)="onUnstage(entry, $event)"
                  >
                    <ui-icon name="minus" [size]="13" />
                  </button>
                </li>
              }
            </ul>
          }
          <h3 class="chg__group">
            {{ 'git.changes_unstaged' | t }} ({{ groups().unstaged.length }})
          </h3>
          <ul class="chg__list">
            @for (entry of groups().unstaged; track key(entry)) {
              <li
                class="chg__file"
                [class.chg__file--selected]="key(entry) === selectedKey()"
                (click)="onSelect(entry)"
                (contextmenu)="onFileMenu($event, entry)"
              >
                <span class="chg__status chg__status--{{ entry.status }}">{{
                  entry.status
                }}</span>
                <span class="chg__path" [title]="entry.path">{{ entry.path }}</span>
                <button
                  class="chg__action"
                  type="button"
                  [title]="'git.discard' | t"
                  (click)="onDiscard(entry, $event)"
                >
                  <ui-icon name="rotate-ccw" [size]="13" />
                </button>
                <button
                  class="chg__action"
                  type="button"
                  [title]="'git.stage' | t"
                  (click)="onStage(entry, $event)"
                >
                  <ui-icon name="plus" [size]="13" />
                </button>
              </li>
            }
          </ul>
        }
      </aside>

      <div class="chg__viewer">
        @if (detailLoading()) {
          <div class="chg__center"><ui-spinner /></div>
        } @else if (!selected()) {
          <div class="chg__center chg__muted">{{ 'git.select_file' | t }}</div>
        } @else {
          <div class="chg__bar">
            <span class="chg__name" [title]="selected()!.path">{{ selected()!.path }}</span>
            <span class="chg__spacer"></span>
            @if (paneMode() === 'diff' && editable()) {
              <ui-button variant="log-action" size="sm" (clicked)="onEdit()">
                <ui-icon name="pencil" [size]="14" /> {{ 'git.edit_file' | t }}
              </ui-button>
            }
            @if (paneMode() === 'edit') {
              @if (!isUntrackedSelected()) {
                <ui-button variant="log-action" size="sm" (clicked)="onBackToDiff()">
                  {{ 'git.back_to_diff' | t }}
                </ui-button>
              }
              <ui-button
                variant="purple-alt"
                size="sm"
                [disabled]="!dirty() || saving()"
                (clicked)="onSave()"
              >
                <ui-icon name="save" [size]="14" /> {{ 'git.save' | t }}
              </ui-button>
            }
          </div>
          @if (notice()) {
            <div class="chg__center chg__muted">{{ notice() }}</div>
          } @else if (paneMode() === 'diff') {
            <ui-diff-view
              class="chg__pane"
              [diff]="diffText()"
              [emptyText]="'git.empty_diff' | t"
            />
          } @else {
            <ui-code-edit
              class="chg__pane"
              [content]="editorContent()"
              [fileName]="selected()!.path"
              (contentChanged)="onDraftChanged($event)"
              (saveRequested)="onSave()"
            />
          }
        }
      </div>
    </div>
  `,
})
export class ChangesViewComponent implements OnInit {
  private readonly i18n = inject(TranslationService);
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);
  private readonly bridge = inject(TauriBridge);
  private readonly menu = inject(ContextMenuService);

  /** Absolute repo path (resolved by the git-window shell). */
  readonly repoPath = input.required<string>();

  protected readonly entries = signal<readonly GitChangeEntry[]>([]);
  protected readonly groups = computed(() => groupChanges(this.entries()));
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  protected readonly selected = signal<GitChangeEntry | null>(null);
  protected readonly selectedKey = computed(() => {
    const entry = this.selected();
    return entry ? changeKey(entry) : '';
  });
  protected readonly editable = computed(() => {
    const entry = this.selected();
    return !!entry && canEdit(entry) && !this.notice();
  });
  protected readonly isUntrackedSelected = computed(() => {
    const entry = this.selected();
    return !!entry && isUntracked(entry);
  });

  protected readonly paneMode = signal<PaneMode>('diff');
  protected readonly detailLoading = signal(false);
  protected readonly diffText = signal('');
  protected readonly notice = signal('');

  /** Text last loaded from (or saved to) disk — the dirty baseline. */
  private readonly loadedText = signal('');
  /** Live editor draft (kept across re-renders; NOT echoed to the editor). */
  private draft = '';
  /** What the editor host renders; only moves on load/file-switch/save. */
  protected readonly editorContent = signal('');
  protected readonly dirty = signal(false);
  protected readonly saving = signal(false);

  protected key(entry: GitChangeEntry): string {
    return changeKey(entry);
  }

  async ngOnInit(): Promise<void> {
    await this.reloadList();
    // Preselect the first file so the window opens showing something.
    const first = this.groups().unstaged[0] ?? this.groups().staged[0];
    if (first) {
      void this.onSelect(first);
    }
  }

  // -- list + selection ---------------------------------------------------------

  private async reloadList(): Promise<void> {
    this.loading.set(true);
    try {
      this.entries.set(await this.commands.git.changesList(this.repoPath()));
      this.error.set('');
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    } finally {
      this.loading.set(false);
    }
    // Selection may have vanished (staged away, discarded, saved-clean…).
    const selected = this.selected();
    if (selected && !this.entries().some((e) => changeKey(e) === changeKey(selected))) {
      this.selected.set(null);
      this.paneMode.set('diff');
      this.dirty.set(false);
    }
  }

  protected async onSelect(entry: GitChangeEntry): Promise<void> {
    if (this.dirty() && !(await this.confirmDropDraft())) {
      return;
    }
    this.selected.set(entry);
    this.dirty.set(false);
    this.draft = '';
    if (isUntracked(entry) && canEdit(entry)) {
      // No diff exists for untracked files — jump straight to the editor.
      await this.openEditor(entry);
      return;
    }
    this.paneMode.set('diff');
    await this.loadDiff(entry);
  }

  private async loadDiff(entry: GitChangeEntry): Promise<void> {
    this.detailLoading.set(true);
    this.notice.set('');
    try {
      const diff = await this.commands.git.workingDiff(
        this.repoPath(),
        entry.path,
        entry.staged,
      );
      if (diff.binary) {
        this.notice.set(this.i18n.t('git.binary_file'));
        this.diffText.set('');
      } else if (diff.tooLarge) {
        this.notice.set(this.i18n.t('git.diff_too_large'));
        this.diffText.set('');
      } else {
        this.diffText.set(diff.content ?? '');
      }
      this.error.set('');
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    } finally {
      this.detailLoading.set(false);
    }
  }

  // -- editor -------------------------------------------------------------------

  protected async onEdit(): Promise<void> {
    const entry = this.selected();
    if (entry) {
      await this.openEditor(entry);
    }
  }

  private async openEditor(entry: GitChangeEntry): Promise<void> {
    this.detailLoading.set(true);
    this.notice.set('');
    this.paneMode.set('edit');
    try {
      const file = await this.commands.git.readWorkingFile(this.repoPath(), entry.path);
      if (file.binary) {
        this.notice.set(this.i18n.t('git.binary_file'));
      } else if (file.tooLarge) {
        this.notice.set(this.i18n.t('git.too_large', { size: String(file.size) }));
      } else {
        const text = file.content ?? '';
        this.loadedText.set(text);
        this.draft = text;
        this.editorContent.set(text);
        this.dirty.set(false);
      }
      this.error.set('');
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
      this.paneMode.set('diff');
    } finally {
      this.detailLoading.set(false);
    }
  }

  protected onDraftChanged(text: string): void {
    this.draft = text;
    this.dirty.set(text !== this.loadedText());
  }

  protected async onBackToDiff(): Promise<void> {
    const entry = this.selected();
    if (!entry || (this.dirty() && !(await this.confirmDropDraft()))) {
      return;
    }
    this.dirty.set(false);
    this.paneMode.set('diff');
    await this.loadDiff(entry);
  }

  protected async onSave(): Promise<void> {
    const entry = this.selected();
    if (!entry || !this.dirty() || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      await this.commands.git.writeWorkingFile(this.repoPath(), entry.path, this.draft);
      this.loadedText.set(this.draft);
      this.dirty.set(false);
      this.error.set('');
      await this.afterMutation(/* keepSelection */ true);
    } catch (err: unknown) {
      // Draft is kept — nothing is lost on a failed save.
      this.error.set(this.messageOf(err));
    } finally {
      this.saving.set(false);
    }
  }

  // -- safe actions ---------------------------------------------------------------

  protected async onStage(entry: GitChangeEntry, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    await this.runAction(this.commands.git.stageFile(this.repoPath(), entry.path));
  }

  protected async onUnstage(entry: GitChangeEntry, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    await this.runAction(this.commands.git.unstageFile(this.repoPath(), entry.path));
  }

  protected async onDiscard(entry: GitChangeEntry, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    await this.discardWithConfirm(entry);
  }

  private async discardWithConfirm(entry: GitChangeEntry): Promise<void> {
    const confirmed = await this.confirm(
      this.i18n.t('git.discard_confirm_title'),
      this.i18n.t('git.discard_confirm_msg', { path: entry.path }),
    );
    if (!confirmed) {
      return;
    }
    await this.runAction(
      this.commands.git.discardFile(this.repoPath(), entry.path, isUntracked(entry)),
    );
  }

  /** Right-click on a file row — same actions as the hover icons, plus copy
   * path and edit (the icons are invisible until hover; the menu is the
   * discoverable path). */
  protected async onFileMenu(event: MouseEvent, entry: GitChangeEntry): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const items: MenuEntry[] = entry.staged
      ? [
          { id: 'unstage', label: t('git.unstage'), icon: 'minus' },
          { id: 'copy-path', label: t('menu.copy_path'), icon: 'copy', separator: true },
        ]
      : [
          { id: 'stage', label: t('git.stage'), icon: 'plus' },
          ...(canEdit(entry)
            ? [{ id: 'edit', label: t('git.edit_file'), icon: 'pencil' } as const]
            : []),
          { id: 'discard', label: t('git.discard'), icon: 'rotate-ccw', danger: true, separator: true },
          { id: 'copy-path', label: t('menu.copy_path'), icon: 'copy', separator: true },
        ];

    switch (await this.menu.openFromEvent(event, items)) {
      case 'stage':
        return this.runAction(this.commands.git.stageFile(this.repoPath(), entry.path));
      case 'unstage':
        return this.runAction(this.commands.git.unstageFile(this.repoPath(), entry.path));
      case 'discard':
        return this.discardWithConfirm(entry);
      case 'edit':
        await this.onSelect(entry);
        if (this.paneMode() !== 'edit' && this.editable()) {
          await this.openEditor(entry);
        }
        return;
      case 'copy-path':
        return void navigator.clipboard.writeText(entry.path).catch(() => undefined);
    }
  }

  private async runAction(op: Promise<OpOutput>): Promise<void> {
    try {
      const result = await op;
      this.error.set(result.ok ? '' : result.message);
    } catch (err: unknown) {
      this.error.set(this.messageOf(err));
    }
    await this.afterMutation(false);
  }

  /** Shared refresh after any mutation: list + current diff + card badge. */
  private async afterMutation(keepSelection: boolean): Promise<void> {
    await this.reloadList();
    const entry = this.selected();
    if (entry && (keepSelection || this.paneMode() === 'diff')) {
      if (this.paneMode() === 'diff') {
        await this.loadDiff(entry);
      }
    }
    // Fire-and-forget: the badge arrives via `git://badge`.
    void this.commands.git.refreshBadge(this.repoPath()).catch(() => undefined);
  }

  // -- dialogs --------------------------------------------------------------------

  /** Unsaved draft guard when leaving the editor (select/back). */
  private confirmDropDraft(): Promise<boolean> {
    return this.confirm(
      this.i18n.t('git.unsaved_title'),
      this.i18n.t('git.unsaved_msg'),
    );
  }

  /** Confirm messagebox as a child window parented to THIS git window. */
  private confirm(title: string, message: string): Promise<boolean> {
    return openDialogWindowForResult<boolean>(
      this.commands,
      this.events,
      'messagebox',
      title,
      { kind: 'confirm', title, message },
      false,
      this.bridge.currentWindowLabel(),
    );
  }

  private messageOf(err: unknown): string {
    const maybe = err as { message?: unknown } | null;
    return typeof maybe?.message === 'string' ? maybe.message : String(err);
  }
}
