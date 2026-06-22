/**
 * Repo Config Manager — v1 `RepoConfigManagerDialog` (inventory-gui §23).
 *
 * Manages the named environment/app configurations of one config key
 * (`"repo::module"`, §10 / ipc-contract §1.5): left panel lists the saved
 * configs (dangerous ones prefixed `⚠ ` in warning yellow — the danger set
 * later propagates to the card combo border / header badge via
 * `RepoInfo.dangerFlags`), right panel edits the selected one with
 * rename / duplicate / delete / danger-toggle / save.
 *
 * Deviations from v1 (documented):
 * - v1 opened one dialog PER config key (launched from a specific combo);
 *   the v2 contract opens per REPO — a module selector appears when the repo
 *   has several env-file modules (same pattern as the docker dialog's
 *   compose-file selector).
 * - No `on_close` callback: the result is persisted config state; the card
 *   reloads its combo options when it next reads them (see integration notes).
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
import { ReposStore } from '../../../core/state/repos.store';
import {
  ButtonComponent,
  DialogShellComponent,
  SearchableSelectComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import {
  basenameOf,
  envNameFromFile,
  newConfigEntries,
  renameDangerName,
  toggleDangerName,
} from './repo-config.logic';

@Component({
  selector: 'app-repo-config-manager-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, SearchableSelectComponent, TPipe],
  styleUrl: './repo-config-manager-dialog.component.scss',
  template: `
    <ui-dialog-shell
      #shell
      [dialogTitle]="title()"
      (closed)="requestClose()"
    >
      <div class="envmgr">
        <!-- Left panel: config list (§23) -->
        <div class="envmgr__left">
          <p class="envmgr__heading">{{ 'dialog.env_manager.title' | t }}</p>

          @if (moduleKeys().length > 1) {
            <div class="envmgr__module-row">
              <span class="envmgr__module-label">{{
                'dialog.env_manager.module_label' | t
              }}</span>
              <ui-searchable-select
                class="envmgr__module-combo"
                [options]="moduleKeys()"
                [value]="moduleKey()"
                [searchPlaceholder]="'placeholder.search' | t"
                [noResultsText]="'placeholder.no_results' | t"
                (selectionChange)="onModulePick($event)"
              />
            </div>
          }

          <div class="envmgr__list">
            @for (name of names(); track name) {
              <button
                type="button"
                class="envmgr__row"
                [class.selected]="name === selected()"
                [class.danger]="isDanger(name)"
                (click)="select(name)"
              >
                @if (isDanger(name)) {
                  <span class="envmgr__danger-mark">⚠</span>
                }
                {{ name }}
              </button>
            } @empty {
              <p class="envmgr__empty">{{ 'dialog.env_manager.empty_list' | t }}</p>
            }
          </div>

          <div class="envmgr__btn-col">
            <ui-button variant="blue" size="sm" (clicked)="newConfig()">
              {{ 'dialog.env_manager.btn_new' | t }}
            </ui-button>
            <ui-button
              variant="purple-alt"
              size="sm"
              [loading]="importing()"
              (clicked)="autoImport()"
            >
              {{ 'dialog.env_manager.btn_auto_import' | t }}
            </ui-button>
          </div>
        </div>

        <!-- Right panel: editor (§23) -->
        <div class="envmgr__right">
          <div class="envmgr__toolbar">
            <span class="envmgr__editing">{{ editingTitle() }}</span>
            <span class="envmgr__spacer"></span>
            <ui-button
              variant="neutral"
              size="sm"
              [disabled]="selected() === ''"
              (clicked)="rename()"
            >
              {{ 'dialog.env_manager.btn_rename' | t }}
            </ui-button>
            <ui-button
              variant="neutral"
              size="sm"
              [disabled]="selected() === ''"
              (clicked)="duplicate()"
            >
              {{ 'dialog.env_manager.btn_duplicate' | t }}
            </ui-button>
            <ui-button
              variant="danger"
              size="sm"
              [disabled]="selected() === ''"
              (clicked)="deleteConfig()"
            >
              {{ 'dialog.env_manager.btn_delete' | t }}
            </ui-button>
            <button
              type="button"
              class="envmgr__danger-toggle"
              [class.active]="selectedIsDanger()"
              [disabled]="selected() === ''"
              [title]="dangerTooltip()"
              (click)="toggleDanger()"
            >
              ⚠
            </button>
          </div>

          <textarea
            #editor
            class="envmgr__editor"
            spellcheck="false"
            [disabled]="selected() === ''"
            [value]="editorText()"
            (input)="editorText.set(editor.value)"
          ></textarea>

          <div class="envmgr__save-row">
            <ui-button
              variant="success"
              [loading]="saving()"
              [disabled]="selected() === ''"
              (clicked)="save()"
            >
              {{ 'dialog.env_manager.btn_save' | t }}
            </ui-button>
          </div>
        </div>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="requestClose()">
          {{ 'btn.close' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class RepoConfigManagerDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly i18n = inject(TranslationService);
  private readonly shell = viewChild.required<DialogShellComponent>('shell');

  protected readonly moduleKey = signal('');
  protected readonly environments = signal<Readonly<Record<string, string>>>({});
  protected readonly dangerNames = signal<readonly string[]>([]);
  protected readonly selected = signal('');
  protected readonly editorText = signal('');
  protected readonly saving = signal(false);
  protected readonly importing = signal(false);

  protected readonly moduleKeys = computed<readonly string[]>(
    () => this.repo()?.modules.map((m) => m.key) ?? [],
  );

  /** v1 config-key convention (§10): `repo::module`, bare name without modules. */
  protected readonly configKey = computed(() =>
    this.moduleKey() !== ''
      ? `${this.repoName()}::${this.moduleKey()}`
      : this.repoName(),
  );

  protected readonly names = computed(() =>
    Object.keys(this.environments()).sort((a, b) => a.localeCompare(b)),
  );

  protected readonly title = computed(() =>
    this.i18n.t('dialog.env_manager.window_title', { name: this.configKey() }),
  );

  protected readonly editingTitle = computed(() =>
    this.selected() === ''
      ? this.i18n.t('dialog.env_manager.select_hint')
      : this.i18n.t('dialog.env_manager.editing', { name: this.selected() }),
  );

  protected readonly selectedIsDanger = computed(
    () => this.selected() !== '' && this.dangerNames().includes(this.selected()),
  );

  protected readonly dangerTooltip = computed(() =>
    this.i18n.t(
      this.selectedIsDanger() ? 'tooltip.mark_danger_on' : 'tooltip.mark_danger_off',
    ),
  );

  /** Editor text differs from the stored value (§23 unsaved tracking). */
  protected readonly dirty = computed(
    () =>
      this.selected() !== '' &&
      this.editorText() !== (this.environments()[this.selected()] ?? ''),
  );

  constructor() {
    super();
    // Inputs are bound after construction (NgComponentOutlet) — init deferred.
    afterNextRender(() => void this.init());
  }

  // -- selection (§23) ----------------------------------------------------------

  protected async select(name: string): Promise<void> {
    if (name === this.selected() || !(await this.checkUnsavedChanges())) {
      return;
    }
    this.selected.set(name);
    this.editorText.set(this.environments()[name] ?? '');
  }

  protected async onModulePick(key: string): Promise<void> {
    if (key === this.moduleKey() || !(await this.checkUnsavedChanges())) {
      return;
    }
    this.moduleKey.set(key);
    this.selected.set('');
    this.editorText.set('');
    await this.load();
  }

  protected isDanger(name: string): boolean {
    return this.dangerNames().includes(name);
  }

  // -- mutations (§23) ----------------------------------------------------------

  protected async save(): Promise<void> {
    const name = this.selected();
    if (name === '' || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      await this.persist({ ...this.environments(), [name]: this.editorText() });
      await this.dialogs.info(
        this.i18n.t('dialog.env_manager.saved_title'),
        this.i18n.t('dialog.env_manager.saved_msg', { name }),
      );
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async newConfig(): Promise<void> {
    const name = await this.askName(
      'dialog.env_manager.new_title',
      'dialog.env_manager.new_prompt',
      '',
    );
    if (name === null || !(await this.guardDuplicate(name))) {
      return;
    }
    await this.persist({ ...this.environments(), [name]: '' });
    this.selected.set(name);
    this.editorText.set('');
  }

  protected async rename(): Promise<void> {
    const from = this.selected();
    if (from === '') {
      return;
    }
    const to = await this.askName(
      'dialog.env_manager.rename_title',
      'dialog.env_manager.rename_prompt',
      from,
    );
    if (to === null || to === from || !(await this.guardDuplicate(to))) {
      return;
    }
    const next: Record<string, string> = { ...this.environments() };
    next[to] = next[from] ?? '';
    delete next[from];
    await this.persist(next);
    await this.persistDanger(renameDangerName(this.dangerNames(), from, to));
    this.selected.set(to);
  }

  protected async duplicate(): Promise<void> {
    const from = this.selected();
    if (from === '') {
      return;
    }
    const to = await this.askName(
      'dialog.env_manager.duplicate_title',
      'dialog.env_manager.duplicate_prompt',
      `${from}${this.i18n.t('misc.copy_suffix')}`,
    );
    if (to === null || !(await this.guardDuplicate(to))) {
      return;
    }
    await this.persist({ ...this.environments(), [to]: this.environments()[from] ?? '' });
    this.selected.set(to);
    this.editorText.set(this.environments()[to] ?? '');
  }

  protected async deleteConfig(): Promise<void> {
    const name = this.selected();
    if (name === '') {
      return;
    }
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.env_manager.delete_title'),
      this.i18n.t('dialog.env_manager.delete_msg', { name }),
    );
    if (!confirmed) {
      return;
    }
    const next: Record<string, string> = { ...this.environments() };
    delete next[name];
    await this.persist(next);
    if (this.dangerNames().includes(name)) {
      await this.persistDanger(toggleDangerName(this.dangerNames(), name));
    }
    this.selected.set('');
    this.editorText.set('');
  }

  /** Danger toggle (§23): flips the per-key danger set, restyles the list. */
  protected async toggleDanger(): Promise<void> {
    const name = this.selected();
    if (name === '') {
      return;
    }
    await this.persistDanger(toggleDangerName(this.dangerNames(), name));
  }

  /**
   * Auto-import (§23): parse the module's existing env files into named
   * configs via the repo `env_patterns`; only NEW names are added.
   */
  protected async autoImport(): Promise<void> {
    if (this.importing()) {
      return;
    }
    const repo = this.repo();
    const module = repo?.modules.find((m) => m.key === this.moduleKey());
    const files = module?.envFiles ?? [];
    if (!repo || files.length === 0) {
      await this.dialogs.info(
        this.i18n.t('dialog.env_manager.auto_import_title'),
        this.i18n.t('dialog.env_manager.auto_import_no_files'),
      );
      return;
    }
    this.importing.set(true);
    try {
      const candidates: Record<string, string> = {};
      for (const file of files) {
        const content = await this.commands.config.readConfigFile(file).catch(() => '');
        if (content !== '') {
          candidates[envNameFromFile(basenameOf(file), repo.envPatterns)] = content;
        }
      }
      if (Object.keys(candidates).length === 0) {
        await this.dialogs.info(
          this.i18n.t('dialog.env_manager.auto_import_title'),
          this.i18n.t('dialog.env_manager.auto_import_no_files'),
        );
        return;
      }
      const added = newConfigEntries(candidates, this.names());
      const count = Object.keys(added).length;
      if (count === 0) {
        await this.dialogs.info(
          this.i18n.t('dialog.env_manager.auto_import_title'),
          this.i18n.t('dialog.env_manager.auto_import_exists'),
        );
        return;
      }
      await this.persist({ ...this.environments(), ...added });
      await this.dialogs.info(
        this.i18n.t('dialog.env_manager.auto_import_title'),
        this.i18n.t('dialog.env_manager.auto_import_success', { added: count }),
      );
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.importing.set(false);
    }
  }

  /** Close (✕/ESC/Close): unsaved-check first (v1 §23 close behavior). */
  protected async requestClose(): Promise<void> {
    if (this.dirty()) {
      this.shell().knock();
    }
    if (!(await this.checkUnsavedChanges())) {
      return;
    }
    this.closeSelf();
  }

  // -- internals ------------------------------------------------------------------

  private repo() {
    return this.repos.repoByName(this.repoName());
  }

  private async init(): Promise<void> {
    this.moduleKey.set(this.moduleKeys()[0] ?? '');
    await this.load();
  }

  private async load(): Promise<void> {
    const key = this.configKey();
    try {
      const [environments, config] = await Promise.all([
        this.commands.config.getSavedEnvironments(key),
        this.commands.config.getAppConfig(),
      ]);
      this.environments.set(environments);
      this.dangerNames.set(config.repo_config_danger?.[key] ?? []);
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    }
  }

  private async persist(environments: Readonly<Record<string, string>>): Promise<void> {
    await this.commands.config.saveSavedEnvironments(this.configKey(), environments);
    this.environments.set(environments);
  }

  private async persistDanger(names: readonly string[]): Promise<void> {
    await this.commands.config.setDangerFlags(this.configKey(), names);
    this.dangerNames.set(names);
  }

  /**
   * Unsaved-changes guard (§23): offers to SAVE the edited config before
   * switching away/closing; declining discards. Always proceeds (v1 parity).
   */
  private async checkUnsavedChanges(): Promise<boolean> {
    if (!this.dirty()) {
      return true;
    }
    const saveIt = await this.dialogs.confirm(
      this.i18n.t('dialog.env_manager.unsaved_title'),
      this.i18n.t('dialog.env_manager.unsaved_msg', { name: this.selected() }),
    );
    if (saveIt) {
      await this.persist({
        ...this.environments(),
        [this.selected()]: this.editorText(),
      });
    } else {
      this.editorText.set(this.environments()[this.selected()] ?? '');
    }
    return true;
  }

  /** `_AskNameDialog` replacement (generic prompt window, §23). `null` = cancelled. */
  private askName(
    titleKey: string,
    promptKey: string,
    initial: string,
  ): Promise<string | null> {
    return this.dialogs.prompt(this.i18n.t(titleKey), this.i18n.t(promptKey), {
      initialValue: initial,
    });
  }

  /** Name-collision guard: `false` + themed error when taken (§23). */
  private async guardDuplicate(name: string): Promise<boolean> {
    if (!this.names().includes(name)) {
      return true;
    }
    await this.dialogs.error(
      this.i18n.t('misc.error_title'),
      this.i18n.t('dialog.env_manager.error_duplicate'),
    );
    return false;
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
