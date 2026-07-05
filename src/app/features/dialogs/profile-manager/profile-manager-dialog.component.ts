/**
 * Profile manager — v1 `ProfileDialog` (inventory-gui §21).
 *
 * Save-current (name + overwrite confirm + include-config-files), saved-list
 * with Load / Delete / Export, file import with the v1 collision rules
 * (identical → stop; differing → auto-rename `name1`, `name2`, …), and the
 * §21 change preview that routes through {@link ImportOptionsDialogComponent}
 * whenever the profile differs from the live workspace capture.
 *
 * Profiles are PER WORKSPACE GROUP (§26): the active group resolves to the
 * `group` argument of every profile command (`Default` ⇒ omitted = the root
 * profiles dir, ipc-contract §2.7).
 *
 * Deviations from v1 (documented):
 * - "no name" / "no selection" guards render as inline errors instead of
 *   `show_warning` interruptions (task rules; messages reuse the v1 keys).
 * - After an options-wizard apply the wizard already reported completion, so
 *   no second `loaded_*` info box is shown (v1 stacked both).
 */
import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { ProfileDocument } from '../../../core/ipc/tauri.types';
import { ProfilesStore } from '../../../core/state/profiles.store';
import { ReposStore } from '../../../core/state/repos.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { RepoActionsService } from '../../workspace/state/repo-actions.service';
import { WorkspaceStore } from '../../workspace/state/workspace.store';
import {
  ButtonComponent,
  ContextMenuService,
  DialogShellComponent,
  FilterTableComponent,
  IconComponent,
  TableHeadDirective,
  TableRowDirective,
  type MenuEntry,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import { NativePickers } from '../shared/native-pickers';
import {
  ExportOptionsDialogComponent,
  type ExportOptionsResult,
} from './export-options-dialog.component';
import {
  ImportOptionsDialogComponent,
  type ImportApplyResult,
} from './import-options-dialog.component';
import {
  buildChangePlan,
  hasChanges,
  profilesEquivalent,
  uniqueImportedName,
  type ChangePlan,
} from './profile-manager.logic';

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }] as const;

@Component({
  selector: 'app-profile-manager-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DialogShellComponent,
    FilterTableComponent,
    IconComponent,
    TableHeadDirective,
    TableRowDirective,
    TPipe,
  ],
  styleUrl: './profile-manager-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.profile.title' | t"
      (closed)="closeSelf()"
    >
      <div class="profiles">
        <h3 class="profiles__heading">{{ 'dialog.profile.section_title' | t }}</h3>

        <!-- Save section (§21 :67-95) -->
        <p class="profiles__label">{{ 'dialog.profile.save_current' | t }}</p>
        <div class="profiles__save-row">
          <input
            #nameInput
            class="profiles__input"
            type="text"
            [placeholder]="'dialog.profile.name_placeholder' | t"
            [value]="name()"
            (input)="name.set(nameInput.value)"
            (keydown.enter)="save()"
          />
          <ui-button variant="success" [loading]="busy() === 'save'" (clicked)="save()">
            <ui-icon name="save" [size]="14" /> {{ 'dialog.profile.btn_save' | t }}
          </ui-button>
        </div>
        <label class="profiles__check">
          <input
            type="checkbox"
            [checked]="includeConfigFiles()"
            (change)="includeConfigFiles.set(!includeConfigFiles())"
          />
          {{ 'dialog.profile.include_config_files' | t }}
        </label>

        @if (inlineError() !== '') {
          <p class="profiles__error">{{ inlineError() }}</p>
        }

        <!-- Saved profiles table (§21 :97-132; hidden when empty). Selecting
             a row pre-fills the save entry (overwrite flow) — actions act on
             their own row directly. -->
        @if (profileNames().length > 0) {
          <p class="profiles__label">{{ 'dialog.profile.saved_list_title' | t }}</p>
          <ui-filter-table
            [items]="profileNames()"
            [searchable]="false"
            [pageSize]="pageSize"
            [prevLabel]="'pagination.prev' | t"
            [nextLabel]="'pagination.next' | t"
          >
            <tr *uiTableHead>
              <th>{{ 'dialog.profile.col_profile' | t }}</th>
              <th class="profiles__actions-head">{{ 'dialog.profile.col_actions' | t }}</th>
            </tr>
            <!-- Right-click offers the same actions as the buttons. -->
            <tr
              *uiTableRow="let profile"
              class="profiles__tr"
              [class.profiles__tr--selected]="profile === selected()"
              (click)="select(profile)"
              (contextmenu)="onRowMenu($event, profile)"
            >
              <td><span class="profiles__name">{{ profile }}</span></td>
              <td>
                <div class="profiles__actions">
                  <ui-button
                    variant="blue"
                    size="sm"
                    [loading]="busy() === 'load' && profile === selected()"
                    (clicked)="select(profile); load()"
                  >
                    <ui-icon name="folder" [size]="14" /> {{ 'dialog.profile.btn_load' | t }}
                  </ui-button>
                  <ui-button
                    variant="warning"
                    size="sm"
                    [loading]="busy() === 'export' && profile === selected()"
                    (clicked)="select(profile); exportProfile()"
                  >
                    <ui-icon name="upload" [size]="14" /> {{ 'dialog.profile.btn_export' | t }}
                  </ui-button>
                  <ui-button
                    variant="danger-deep"
                    size="sm"
                    [loading]="busy() === 'delete' && profile === selected()"
                    (clicked)="select(profile); deleteProfile()"
                  >
                    <ui-icon name="trash" [size]="14" /> {{ 'dialog.profile.btn_delete' | t }}
                  </ui-button>
                </div>
              </td>
            </tr>
          </ui-filter-table>
        }

        <!-- Import section (§21 :134-146) -->
        <p class="profiles__label">{{ 'dialog.profile.import_external' | t }}</p>
        <ui-button
          class="profiles__import-btn"
          variant="purple"
          [loading]="busy() === 'import'"
          (clicked)="importProfile()"
        >
          <ui-icon name="download" [size]="14" /> {{ 'dialog.profile.btn_import' | t }}
        </ui-button>

        <p class="profiles__help">{{ 'dialog.profile.help_text' | t }}</p>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">
          {{ 'btn.close' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class ProfileManagerDialogComponent extends DialogBase {
  private readonly commands = inject(IpcCommands);
  private readonly profiles = inject(ProfilesStore);
  private readonly repos = inject(ReposStore);
  private readonly settings = inject(SettingsStore);
  private readonly workspace = inject(WorkspaceStore);
  private readonly actions = inject(RepoActionsService);
  private readonly pickers = inject(NativePickers);
  private readonly i18n = inject(TranslationService);
  private readonly menu = inject(ContextMenuService);

  protected readonly name = signal('');
  protected readonly includeConfigFiles = signal(true); // v1 default ON
  protected readonly selected = signal('');
  protected readonly inlineError = signal('');
  protected readonly busy = signal<'save' | 'load' | 'delete' | 'export' | 'import' | null>(
    null,
  );

  protected readonly profileNames = this.profiles.profiles;
  protected readonly pageSize = 10;

  /** Active-group profile scope: `Default` ⇒ root dir (`group` omitted, §2.7). */
  private readonly group = computed<string | undefined>(() => {
    const name = this.settings.activeGroup()?.name;
    return name === undefined || name === 'Default' ? undefined : name;
  });

  /** Workspace root: clone destination + env-apply target. */
  private readonly workspaceDir = computed(
    () => this.settings.activeGroup()?.paths[0] ?? '',
  );

  constructor() {
    super();
    afterNextRender(() => void this.profiles.refresh(this.group()));
  }

  /** Select a row; pre-fills the save entry for easy overwrite (v1 §21). */
  protected select(profile: string): void {
    this.selected.set(profile);
    this.name.set(profile);
    this.inlineError.set('');
  }

  /** Right-click on a profile row — same actions as the buttons below. */
  protected async onRowMenu(event: MouseEvent, profile: string): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const busy = this.busy() !== null;
    const items: MenuEntry[] = [
      { id: 'load', label: t('dialog.profile.btn_load'), icon: 'folder', disabled: busy },
      { id: 'export', label: t('dialog.profile.btn_export'), icon: 'upload', disabled: busy },
      {
        id: 'delete',
        label: t('dialog.profile.btn_delete'),
        icon: 'trash',
        danger: true,
        disabled: busy,
        separator: true,
      },
    ];
    const picked = await this.menu.openFromEvent(event, items);
    if (picked === null) {
      return;
    }
    // The buttons operate on "the selected profile" — select the row first.
    this.select(profile);
    switch (picked) {
      case 'load': return this.load();
      case 'export': return this.exportProfile();
      case 'delete': return this.deleteProfile();
    }
  }

  // -- save (§21 :148-180) --------------------------------------------------------

  protected async save(): Promise<void> {
    if (this.busy() !== null) {
      return;
    }
    const name = this.name().trim();
    if (name === '') {
      this.inlineError.set(this.i18n.t('dialog.profile.error_no_name'));
      return;
    }
    this.inlineError.set('');
    if (this.profileNames().includes(name)) {
      const overwrite = await this.dialogs.confirm(
        this.i18n.t('dialog.profile.overwrite_title'),
        this.i18n.t('dialog.profile.overwrite_msg', { name }),
      );
      if (!overwrite) {
        return;
      }
    }
    this.busy.set('save');
    try {
      await this.profiles.save({
        name,
        group: this.group(),
        doc: this.workspace.buildProfileDocument(),
        includeConfigFiles: this.includeConfigFiles(),
      });
      this.selected.set(name);
      await this.dialogs.info(
        this.i18n.t('dialog.profile.saved_title'),
        this.i18n.t('dialog.profile.saved_msg', { name }),
      );
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.busy.set(null);
    }
  }

  // -- load (§21 :182-194 + change preview :220-278) -------------------------------

  protected async load(): Promise<void> {
    if (this.busy() !== null || !this.guardSelection()) {
      return;
    }
    const name = this.selected();
    this.busy.set('load');
    try {
      // Direct command: the dirty baseline is adopted only AFTER a completed
      // apply (a cancelled wizard must not shift it — v1 cancel = no-op).
      const doc = await this.commands.profiles.loadProfile(name, this.group());
      if (!doc) {
        await this.dialogs.error(
          this.i18n.t('misc.error_title'),
          this.i18n.t('dialog.profile.error_load_failed', { name }),
        );
        return;
      }
      await this.applyWithPreview(doc, null, name);
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.busy.set(null);
    }
  }

  // -- delete (§21 :307-321) --------------------------------------------------------

  protected async deleteProfile(): Promise<void> {
    if (this.busy() !== null || !this.guardSelection()) {
      return;
    }
    const name = this.selected();
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.profile.confirm_delete_title'),
      this.i18n.t('dialog.profile.confirm_delete_msg', { name }),
    );
    if (!confirmed) {
      return;
    }
    this.busy.set('delete');
    try {
      await this.profiles.delete(name, this.group());
      this.selected.set('');
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.busy.set(null);
    }
  }

  // -- export (§21 :323-345) ----------------------------------------------------------

  protected async exportProfile(): Promise<void> {
    if (this.busy() !== null || !this.guardSelection()) {
      return;
    }
    const name = this.selected();
    this.busy.set('export');
    try {
      // Direct command (not ProfilesStore.load): exporting must not adopt
      // the profile as the dirty-detection baseline.
      const doc = await this.commands.profiles.loadProfile(name, this.group());
      if (!doc) {
        await this.dialogs.error(
          this.i18n.t('misc.error_title'),
          this.i18n.t('dialog.profile.error_load_failed', { name }),
        );
        return;
      }
      const result = await this.dialogs.openForResult<ExportOptionsResult | null>(
        ExportOptionsDialogComponent,
        { doc, defaultName: name },
        null,
      );
      if (result === null) {
        return; // cancelled
      }
      await this.profiles.exportToFile(result.doc, result.dest);
      await this.dialogs.info(
        this.i18n.t('dialog.profile.exported_title'),
        this.i18n.t('dialog.profile.exported_msg', { path: result.dest }),
      );
    } catch {
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        this.i18n.t('dialog.profile.error_export_failed'),
      );
    } finally {
      this.busy.set(null);
    }
  }

  // -- import (§21 :134-146, :347-384) ----------------------------------------------

  protected async importProfile(): Promise<void> {
    if (this.busy() !== null) {
      return;
    }
    const src = await this.pickers.pickOpenFile(
      this.i18n.t('dialog.profile.import_dialog_title'),
      JSON_FILTER,
    );
    if (src === null) {
      return;
    }
    this.busy.set('import');
    try {
      let doc: ProfileDocument;
      try {
        doc = await this.profiles.importFromFile(src);
      } catch {
        await this.dialogs.error(
          this.i18n.t('misc.error_title'),
          this.i18n.t('dialog.profile.error_invalid_file'),
        );
        return;
      }
      const base = doc.name?.trim() || fileStem(src);
      let staged = base;
      if (this.profileNames().includes(base)) {
        const existing = await this.commands.profiles.loadProfile(base, this.group());
        if (existing && profilesEquivalent(existing, doc)) {
          // Identical content (ignoring name/created metadata): stop (§21).
          await this.dialogs.info(
            this.i18n.t('dialog.profile.no_changes_title'),
            this.i18n.t('dialog.profile.no_changes_identical', { name: base }),
          );
          return;
        }
        staged = uniqueImportedName(this.profileNames(), base);
      }
      // Importing adds the profile to the library RIGHT AWAY — applying it to
      // the workspace (the preview wizard below) is a separate, optional step.
      // Previously the profile was only persisted if the apply flow completed,
      // so a cancelled/failed apply left nothing saved ("as if no profile").
      await this.persistStaged(doc, staged);
      await this.applyWithPreview(doc, staged);
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.busy.set(null);
    }
  }

  // -- change preview + apply (§21 `_build_changes_text` / `_apply_basic_config`) ----

  /**
   * Diff against the live capture: no differences ⇒ direct apply; otherwise
   * route through the options wizard. `stagedName` ≠ null marks the import
   * path (the profile is already persisted by the caller; on a completed flow
   * we re-save with the Java-mapped doc); `adoptName` ≠ null marks the load
   * path (the named profile becomes the dirty-detection baseline AFTER a
   * completed apply).
   */
  private async applyWithPreview(
    doc: ProfileDocument,
    stagedName: string | null,
    adoptName: string | null = null,
  ): Promise<void> {
    const plan = buildChangePlan(doc, this.workspace.buildProfileDocument());

    if (!hasChanges(plan)) {
      await this.persistStaged(doc, stagedName);
      await this.actions.applyProfile(doc, { sideEffects: true });
      await this.adoptBaseline(adoptName);
      await this.dialogs.info(
        this.i18n.t('dialog.profile.loaded_title'),
        this.i18n.t('dialog.profile.loaded_msg'),
      );
      this.closeSelf();
      return;
    }

    const missing = await this.commands.profiles
      .getMissingRepos(this.workspaceDir(), doc)
      .catch(() => []);
    const result = await this.dialogs.openForResult<ImportApplyResult | null>(
      ImportOptionsDialogComponent,
      {
        doc,
        missing,
        changeLines: this.changeLines(plan),
        workspaceDir: this.workspaceDir(),
        localJava: Object.keys(this.settings.javaVersions()),
      },
      null,
    );
    if (result === null) {
      return; // cancelled — stay on the manager
    }
    await this.persistStaged(result.doc, stagedName);
    if (result.didClone) {
      // Rescan picks up the cloned repos before the card-state apply (§21).
      const paths = this.settings.activeGroup()?.paths ?? [];
      await this.repos.scan(paths).catch(() => undefined);
    }
    await this.actions.applyProfile(result.doc, { sideEffects: true });
    await this.adoptBaseline(adoptName);
    this.closeSelf();
  }

  /** Adopt the named profile as the dirty baseline (load path, post-apply). */
  private async adoptBaseline(adoptName: string | null): Promise<void> {
    if (adoptName !== null) {
      await this.profiles.load(adoptName, this.group()).catch(() => null);
      // Persist as the group's last profile (§26 startup re-apply source).
      await this.settings
        .setLastProfile(this.group() ?? null, adoptName)
        .catch(() => undefined);
    }
  }

  /** Save the staged imported profile (import path only; v1 pending save). */
  private async persistStaged(
    doc: ProfileDocument,
    stagedName: string | null,
  ): Promise<void> {
    if (stagedName === null) {
      return;
    }
    // `includeConfigFiles: false` — the imported document already embeds its
    // file snapshots; re-capturing from disk would corrupt them.
    await this.profiles.save({
      name: stagedName,
      group: this.group(),
      doc,
      includeConfigFiles: false,
    });
    this.selected.set(stagedName);
  }

  /** Translated §21 preview lines (branch / profile / overwrite summary). */
  private changeLines(plan: ChangePlan): readonly string[] {
    const lines: string[] = [];
    for (const change of plan.branchChanges) {
      lines.push(
        `${change.repo} — ${this.i18n.t('dialog.profile.change_branch', {
          from_val: change.from || '—',
          to_val: change.to,
        })}`,
      );
    }
    for (const change of plan.profileChanges) {
      lines.push(
        `${change.repo} — ${this.i18n.t('dialog.profile.change_profile', {
          from_val: change.from || this.i18n.t('label.no_selection'),
          to_val: change.to || this.i18n.t('label.no_selection'),
        })}`,
      );
    }
    if (plan.overwriteCount > 0) {
      lines.push(
        this.i18n.t('dialog.profile.changes_overwrite_files', {
          count: plan.overwriteCount,
        }),
      );
    }
    return lines;
  }

  /** Inline no-selection guard (v1 `show_warning(error_no_selection)`). */
  private guardSelection(): boolean {
    if (this.selected() === '') {
      this.inlineError.set(this.i18n.t('dialog.profile.error_no_selection'));
      return false;
    }
    this.inlineError.set('');
    return true;
  }
}

/** Filename without directory and extension (import fallback name). */
function fileStem(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
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
