/**
 * Raw config-file editor — v1 `ConfigEditorDialog` (inventory-gui §16).
 *
 * - Header shows the full file path (mono, muted); title gets a ` *` dirty
 *   marker (v1 `<<Modified>>` tracking).
 * - Monospace editor with CSS-counter-style line numbers (scroll-synced
 *   gutter — textareas cannot carry CSS counters themselves).
 * - Save validates the content client-side (see `config-validation.ts` for
 *   the documented heuristic choice — the contract has no validate command);
 *   problems prompt a "save anyway?" confirm instead of blocking.
 * - Save writes with trailing newlines stripped (v1 parity), reports
 *   `dialog.config_editor.saved_*` and closes; Reload re-reads from disk.
 * - Unsaved-changes guard on close/cancel/ESC: shell "knock" + confirm;
 *   declining keeps the dialog open (v1 §16).
 */
import {
  ChangeDetectionStrategy,
  Component,
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
import { detectFormat, validateConfigContent } from './config-validation';

@Component({
  selector: 'app-config-editor-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  styleUrl: './config-editor-dialog.component.scss',
  template: `
    <ui-dialog-shell
      #shell
      [dialogTitle]="title()"
      width="700px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="requestClose()"
    >
      <div class="editor">
        <p class="editor__path" [title]="filePath()">{{ filePath() }}</p>

        @if (loadError()) {
          <p class="editor__error">{{ loadError() }}</p>
        } @else {
          <div class="editor__surface">
            <pre class="editor__gutter" #gutter aria-hidden="true">{{ gutterText() }}</pre>
            <textarea
              #area
              class="editor__area"
              spellcheck="false"
              [value]="content()"
              (input)="onEdit(area.value)"
              (scroll)="gutter.scrollTop = area.scrollTop"
            ></textarea>
          </div>
        }
      </div>

      <div uiDialogFooter>
        <ui-button variant="warning" [disabled]="busy()" (clicked)="reload()">
          {{ 'btn.reload' | t }}
        </ui-button>
        <ui-button variant="neutral" [disabled]="busy()" (clicked)="requestClose()">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button
          variant="success"
          [loading]="busy()"
          [disabled]="loadError() !== ''"
          (clicked)="save()"
        >
          {{ 'btn.save' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class ConfigEditorDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();
  readonly filePath = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly i18n = inject(TranslationService);
  private readonly shell = viewChild.required<DialogShellComponent>('shell');

  protected readonly content = signal('');
  protected readonly busy = signal(false);
  protected readonly loadError = signal('');
  private readonly savedContent = signal('');
  private loaded = false;

  protected readonly dirty = computed(
    () => this.loaded && this.content() !== this.savedContent(),
  );

  /** `Editor: {basename}` + ` *` while dirty (v1 §16 title behavior). */
  protected readonly title = computed(() => {
    const basename = this.filePath().split(/[\\/]/).pop() ?? this.filePath();
    const base = this.i18n.t('dialog.config_editor.title', { name: basename });
    return this.dirty() ? `${base} *` : base;
  });

  /** Line-number gutter: "1\n2\n…" matching the content's line count. */
  protected readonly gutterText = computed(() => {
    const count = Math.max(1, this.content().split('\n').length);
    return Array.from({ length: count }, (_, i) => String(i + 1)).join('\n');
  });

  constructor() {
    super();
    void this.load();
  }

  protected onEdit(value: string): void {
    this.content.set(value);
  }

  protected async reload(): Promise<void> {
    await this.load();
  }

  protected async save(): Promise<void> {
    if (this.busy()) {
      return;
    }
    const content = this.content().replace(/[\r\n]+$/, ''); // v1: trailing newline stripped
    const basename = this.filePath().split(/[\\/]/).pop() ?? '';
    const problems = validateConfigContent(detectFormat(basename), content);
    if (problems.length > 0) {
      const proceed = await this.dialogs.confirm(
        this.i18n.t('dialog.config_editor.invalid_title'),
        this.i18n.t('dialog.config_editor.invalid_msg', {
          errors: problems.join('\n'),
        }),
      );
      if (!proceed) {
        return;
      }
    }
    this.busy.set(true);
    try {
      await this.commands.config.writeConfigFile(this.filePath(), content);
      this.savedContent.set(this.content());
      await this.dialogs.info(
        this.i18n.t('dialog.config_editor.saved_title'),
        this.i18n.t('dialog.config_editor.saved_msg'),
      );
      this.closeSelf();
    } catch (err: unknown) {
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        `${this.i18n.t('dialog.config_editor.error_save')}\n${describe(err)}`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  /** Close/cancel/ESC route here: dirty → knock + confirm (v1 §16). */
  protected async requestClose(): Promise<void> {
    if (!this.dirty()) {
      this.closeSelf();
      return;
    }
    this.shell().knock();
    const discard = await this.dialogs.confirm(
      this.i18n.t('dialog.config_editor.unsaved_title'),
      this.i18n.t('dialog.config_editor.unsaved_msg'),
    );
    if (discard) {
      this.closeSelf();
    }
  }

  private async load(): Promise<void> {
    try {
      const text = await this.commands.config.readConfigFile(this.filePath());
      this.content.set(text);
      this.savedContent.set(text);
      this.loadError.set('');
      this.loaded = true;
    } catch (err: unknown) {
      this.loadError.set(describe(err));
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
