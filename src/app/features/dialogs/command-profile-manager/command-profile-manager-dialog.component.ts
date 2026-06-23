/**
 * Command Profile Manager — per-repo named start-command profiles.
 *
 * Trimmed clone of `repo-config-manager-dialog`: no module selector,
 * no danger-toggle, no auto-import. Editor is a single-line `<input>` for the
 * full command line. Profiles live in `AppConfig.command_profiles[repo]`.
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
import { ButtonComponent, DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  styleUrl: './command-profile-manager-dialog.component.scss',
  template: `
    <ui-dialog-shell
      #shell
      [dialogTitle]="title()"
      (closed)="requestClose()"
    >
      <div class="profmgr">
        <!-- Left panel: profile list -->
        <div class="profmgr__left">
          <p class="profmgr__heading">{{ 'dialog.command_profiles.window_title' | t : { name: repoName() } }}</p>

          <div class="profmgr__list">
            @for (name of names(); track name) {
              <button
                type="button"
                class="profmgr__row"
                [class.selected]="name === selected()"
                (click)="selectName(name)"
              >
                {{ name }}
              </button>
            } @empty {
              <p class="profmgr__empty">{{ 'dialog.env_manager.empty_list' | t }}</p>
            }
          </div>

          <div class="profmgr__btn-col">
            <ui-button variant="blue" size="sm" (clicked)="newConfig()">
              {{ 'dialog.env_manager.btn_new' | t }}
            </ui-button>
          </div>
        </div>

        <!-- Right panel: editor -->
        <div class="profmgr__right">
          <div class="profmgr__toolbar">
            <span class="profmgr__editing">{{ editingTitle() }}</span>
            <span class="profmgr__spacer"></span>
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
          </div>

          <input
            type="text"
            class="profmgr__editor"
            spellcheck="false"
            [disabled]="selected() === ''"
            [placeholder]="'dialog.command_profiles.placeholder' | t"
            [value]="editorText()"
            (input)="editorText.set($any($event.target).value)"
          />

          <div class="profmgr__save-row">
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
export class CommandProfileManagerDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly i18n = inject(TranslationService);
  private readonly shell = viewChild.required<DialogShellComponent>('shell');

  protected readonly profiles = signal<Readonly<Record<string, string>>>({});
  protected readonly selected = signal('');
  protected readonly editorText = signal('');
  protected readonly saving = signal(false);

  protected readonly names = computed(() =>
    Object.keys(this.profiles()).sort((a, b) => a.localeCompare(b)),
  );

  protected readonly title = computed(() =>
    this.i18n.t('dialog.command_profiles.window_title', { name: this.repoName() }),
  );

  protected readonly editingTitle = computed(() =>
    this.selected() === ''
      ? this.i18n.t('dialog.command_profiles.select_hint')
      : this.i18n.t('dialog.command_profiles.editing', { name: this.selected() }),
  );

  /** Editor text differs from the stored value (unsaved tracking). */
  protected readonly dirty = computed(
    () =>
      this.selected() !== '' &&
      this.editorText() !== (this.profiles()[this.selected()] ?? ''),
  );

  constructor() {
    super();
    // Inputs are bound after construction (NgComponentOutlet) — init deferred.
    afterNextRender(() => void this.load());
  }

  // -- selection -----------------------------------------------------------------

  protected async selectName(name: string): Promise<void> {
    if (name === this.selected() || !(await this.checkUnsavedChanges())) {
      return;
    }
    this.selected.set(name);
    this.editorText.set(this.profiles()[name] ?? '');
  }

  // -- mutations -----------------------------------------------------------------

  protected async save(): Promise<void> {
    const name = this.selected();
    if (name === '' || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      await this.persist({ ...this.profiles(), [name]: this.editorText() });
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async newConfig(): Promise<void> {
    const name = await this.askName(
      'dialog.command_profiles.new_title',
      'dialog.command_profiles.new_prompt',
      '',
    );
    if (name === null || !(await this.guardDuplicate(name))) {
      return;
    }
    await this.persist({ ...this.profiles(), [name]: '' });
    this.selected.set(name);
    this.editorText.set('');
  }

  protected async rename(): Promise<void> {
    const from = this.selected();
    if (from === '') {
      return;
    }
    const to = await this.askName(
      'dialog.command_profiles.rename_title',
      'dialog.command_profiles.rename_prompt',
      from,
    );
    if (to === null || to === from || !(await this.guardDuplicate(to))) {
      return;
    }
    const next: Record<string, string> = { ...this.profiles() };
    next[to] = next[from] ?? '';
    delete next[from];
    await this.persist(next);
    this.selected.set(to);
  }

  protected async duplicate(): Promise<void> {
    const from = this.selected();
    if (from === '') {
      return;
    }
    const to = await this.askName(
      'dialog.command_profiles.duplicate_title',
      'dialog.command_profiles.duplicate_prompt',
      `${from}${this.i18n.t('misc.copy_suffix')}`,
    );
    if (to === null || !(await this.guardDuplicate(to))) {
      return;
    }
    await this.persist({ ...this.profiles(), [to]: this.profiles()[from] ?? '' });
    this.selected.set(to);
    this.editorText.set(this.profiles()[to] ?? '');
  }

  protected async deleteConfig(): Promise<void> {
    const name = this.selected();
    if (name === '') {
      return;
    }
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.command_profiles.delete_title'),
      this.i18n.t('dialog.command_profiles.delete_msg', { name }),
    );
    if (!confirmed) {
      return;
    }
    const next: Record<string, string> = { ...this.profiles() };
    delete next[name];
    await this.persist(next);
    this.selected.set('');
    this.editorText.set('');
  }

  /** Close (✕/ESC/Close): unsaved-check first. */
  protected async requestClose(): Promise<void> {
    if (this.dirty()) {
      this.shell().knock();
    }
    if (!(await this.checkUnsavedChanges())) {
      return;
    }
    this.closeSelf();
  }

  // -- internals -----------------------------------------------------------------

  private async load(): Promise<void> {
    try {
      this.profiles.set(await this.commands.config.getCommandProfiles(this.repoName()));
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    }
  }

  private async persist(next: Readonly<Record<string, string>>): Promise<void> {
    await this.commands.config.saveCommandProfiles(this.repoName(), next);
    this.profiles.set(next);
  }

  /**
   * Unsaved-changes guard: offers to SAVE the edited profile before
   * switching away/closing; declining discards. Always proceeds.
   */
  private async checkUnsavedChanges(): Promise<boolean> {
    if (!this.dirty()) {
      return true;
    }
    const saveIt = await this.dialogs.confirm(
      this.i18n.t('dialog.command_profiles.unsaved_title'),
      this.i18n.t('dialog.command_profiles.unsaved_msg', { name: this.selected() }),
    );
    if (saveIt) {
      await this.persist({
        ...this.profiles(),
        [this.selected()]: this.editorText(),
      });
    } else {
      this.editorText.set(this.profiles()[this.selected()] ?? '');
    }
    return true;
  }

  /** Generic prompt window. `null` = cancelled. */
  private askName(
    titleKey: string,
    promptKey: string,
    initial: string,
  ): Promise<string | null> {
    return this.dialogs.prompt(this.i18n.t(titleKey), this.i18n.t(promptKey), {
      initialValue: initial,
    });
  }

  /** Name-collision guard: `false` + error dialog when taken. */
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
