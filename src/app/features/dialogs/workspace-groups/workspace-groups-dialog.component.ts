/**
 * Workspace groups CRUD — v1 `WorkspaceGroupsDialog` (inventory-gui §24).
 *
 * Left column: group list + add/delete. Right column: rename, active-group
 * switch (v2 — in v1 switching lived in the topbar; the contract routes it
 * here too), path list + add (native dir picker) / remove. Save validates
 * empty-path groups, persists groups + active group through `SettingsStore`
 * and closes.
 *
 * Deviations from v1 (documented):
 * - v1 auto-saved the WHOLE group list the moment a path was added (§24
 *   "Add path") — even half-edited groups. v2 keeps every edit local until
 *   Save; ESC/✕ discard. Less surprising, and the empty-paths validation
 *   actually guards every persisted state.
 * - Deleting a group asks for confirmation (v1 deleted silently); the
 *   last-group refusal is kept.
 * - No `on_groups_changed` callback: the workspace feature reacts to the
 *   `SettingsStore.workspaceGroups()` / `activeGroup()` signals instead.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import type { WorkspaceGroup } from '../../../core/ipc/tauri.types';
import { SettingsStore } from '../../../core/state/settings.store';
import { ButtonComponent, DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';
import { NativePickers } from '../shared/native-pickers';
import {
  addGroupPath,
  effectiveActiveName,
  emptyPathGroupNames,
  removeGroupPath,
  renameGroup,
  uniqueGroupName,
} from './workspace-groups.logic';

@Component({
  selector: 'app-workspace-groups-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  styleUrl: './workspace-groups-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.workspace_groups.title' | t"
      (closed)="closeSelf()"
    >
      <div class="groups">
        <!-- Left column: group list (§24) -->
        <div class="groups__left">
          <p class="groups__label">{{ 'dialog.workspace_groups.groups_label' | t }}</p>
          <div class="groups__list">
            @for (group of groups(); track group.name; let i = $index) {
              <button
                type="button"
                class="groups__row"
                [class.selected]="i === selectedIndex()"
                (click)="select(i)"
              >
                {{ group.name }}
                @if (group.name === activeName()) {
                  <span class="groups__active-badge">{{
                    'dialog.workspace_groups.active_badge' | t
                  }}</span>
                }
              </button>
            }
          </div>
          <div class="groups__btn-row">
            <ui-button variant="blue" size="sm" (clicked)="addGroup()">
              {{ 'btn.add_group' | t }}
            </ui-button>
            <ui-button variant="danger" size="sm" (clicked)="deleteGroup()">
              {{ 'btn.delete_group' | t }}
            </ui-button>
          </div>
        </div>

        <!-- Right column: selected group editor (§24) -->
        <div class="groups__right">
          <p class="groups__label">{{ 'dialog.workspace_groups.name_label' | t }}</p>
          <div class="groups__name-row">
            <input
              #nameInput
              class="groups__input"
              type="text"
              [placeholder]="'dialog.workspace_groups.name_placeholder' | t"
              [value]="name()"
              (input)="name.set(nameInput.value)"
            />
            <ui-button variant="neutral" size="sm" (clicked)="rename()">
              {{ 'btn.rename' | t }}
            </ui-button>
          </div>

          <ui-button
            class="groups__set-active"
            variant="blue"
            size="sm"
            [disabled]="selectedIsActive()"
            (clicked)="setActive()"
          >
            {{ 'dialog.workspace_groups.btn_set_active' | t }}
          </ui-button>

          <p class="groups__label">{{ 'dialog.workspace_groups.paths_label' | t }}</p>
          <div class="groups__list groups__list--paths">
            @for (path of selectedPaths(); track path) {
              <button
                type="button"
                class="groups__row"
                [class.selected]="path === selectedPath()"
                [title]="path"
                (click)="selectedPath.set(path)"
              >
                {{ path }}
              </button>
            }
          </div>
          <div class="groups__btn-row">
            <ui-button variant="blue" size="sm" (clicked)="addPath()">
              {{ 'btn.add_path' | t }}
            </ui-button>
            <ui-button
              variant="danger"
              size="sm"
              [disabled]="selectedPath() === ''"
              (clicked)="removePath()"
            >
              {{ 'btn.remove_path' | t }}
            </ui-button>
          </div>
        </div>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="success" [loading]="saving()" (clicked)="save()">
          {{ 'btn.save' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class WorkspaceGroupsDialogComponent extends DialogBase {
  private readonly settings = inject(SettingsStore);
  private readonly i18n = inject(TranslationService);
  private readonly pickers = inject(NativePickers);

  /** Local working copy — persisted only on Save (see class JSDoc). */
  protected readonly groups = signal<readonly WorkspaceGroup[]>(
    this.settings.workspaceGroups().map((g) => ({ ...g, paths: [...g.paths] })),
  );
  /** Draft active-group name (persisted on Save when changed). */
  protected readonly activeName = signal(this.settings.activeGroup()?.name ?? '');
  protected readonly selectedIndex = signal(
    Math.max(
      0,
      this.settings
        .workspaceGroups()
        .findIndex((g) => g.name === this.settings.activeGroup()?.name),
    ),
  );
  /** Rename-entry draft (pre-filled with the selected group's name, §24). */
  protected readonly name = signal(
    this.settings.workspaceGroups()[this.selectedIndex()]?.name ?? '',
  );
  protected readonly selectedPath = signal('');
  protected readonly saving = signal(false);

  protected readonly selectedPaths = computed<readonly string[]>(
    () => this.groups()[this.selectedIndex()]?.paths ?? [],
  );

  protected readonly selectedIsActive = computed(
    () => this.groups()[this.selectedIndex()]?.name === this.activeName(),
  );

  protected select(index: number): void {
    this.selectedIndex.set(index);
    this.name.set(this.groups()[index]?.name ?? '');
    this.selectedPath.set('');
  }

  /** Insert `new_group_name` auto-suffixed on collision, and select it (§24). */
  protected addGroup(): void {
    const base = this.i18n.t('dialog.workspace_groups.new_group_name');
    const name = uniqueGroupName(this.groups(), base);
    this.groups.update((g) => [...g, { name, paths: [] }]);
    this.select(this.groups().length - 1);
  }

  protected async deleteGroup(): Promise<void> {
    const groups = this.groups();
    const group = groups[this.selectedIndex()];
    if (!group) {
      return;
    }
    if (groups.length <= 1) {
      // v1 refused to delete the last remaining group (§24).
      await this.dialogs.warning(
        this.i18n.t('misc.warning_title'),
        this.i18n.t('dialog.workspace_groups.error_last_group'),
      );
      return;
    }
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.workspace_groups.confirm_delete_title'),
      this.i18n.t('dialog.workspace_groups.confirm_delete_msg', {
        name: group.name,
      }),
    );
    if (!confirmed) {
      return;
    }
    this.groups.update((g) => g.filter((_, i) => i !== this.selectedIndex()));
    this.select(Math.max(0, this.selectedIndex() - 1)); // reselect a neighbor
  }

  /** In-place rename; empty/duplicate names are silently ignored (v1 §24). */
  protected rename(): void {
    const renamed = renameGroup(this.groups(), this.selectedIndex(), this.name());
    if (renamed === null) {
      return;
    }
    const oldName = this.groups()[this.selectedIndex()]?.name;
    this.groups.set(renamed);
    if (this.activeName() === oldName) {
      this.activeName.set(renamed[this.selectedIndex()]?.name ?? '');
    }
  }

  /** Mark the selected group as the active one (persisted on Save). */
  protected setActive(): void {
    const group = this.groups()[this.selectedIndex()];
    if (group) {
      this.activeName.set(group.name);
    }
  }

  protected async addPath(): Promise<void> {
    const dir = await this.pickers.pickDirectory(
      this.i18n.t('dialog.workspace_groups.browse_title'),
    );
    if (dir === null) {
      return;
    }
    this.groups.update((g) => addGroupPath(g, this.selectedIndex(), dir));
  }

  protected removePath(): void {
    const path = this.selectedPath();
    if (path === '') {
      return;
    }
    this.groups.update((g) => removeGroupPath(g, this.selectedIndex(), path));
    this.selectedPath.set('');
  }

  /** Validate, persist groups + active group, close (§24 Save). */
  protected async save(): Promise<void> {
    if (this.saving()) {
      return;
    }
    const groups = this.groups();
    const empty = emptyPathGroupNames(groups);
    if (empty.length > 0) {
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        this.i18n.t('dialog.workspace_groups.error_empty_paths', {
          names: empty.join(', '),
        }),
      );
      return;
    }
    this.saving.set(true);
    try {
      await this.settings.saveWorkspaceGroups(groups);
      const active = effectiveActiveName(groups, this.activeName());
      if (active !== '' && active !== this.settings.activeGroup()?.name) {
        await this.settings.setActiveGroup(active);
      }
      this.closeSelf();
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.saving.set(false);
    }
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
