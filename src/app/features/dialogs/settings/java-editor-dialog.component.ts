/**
 * Java version editor — v1 `JavaVersionEditorDialog` (inventory-gui §22):
 * name + JAVA_HOME path with a native directory browser.
 *
 * Promise-based: resolves `{ name, path }` on Save, `null` (fallback) on
 * Cancel/ESC/✕. Open via `dialogs.openForResult(JavaEditorDialogComponent,
 * { initialName, initialPath }, null)`.
 *
 * Deviation from v1: the `<path>/bin/java` existence probe (§22
 * `java_exe_warn_*`) needs filesystem access the contract does not expose —
 * validation stops at "name required" / "path required"; Rust-side
 * `build_java_env` skips invalid JAVA_HOMEs at launch time anyway.
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
import {
  ButtonComponent,
  DialogShellComponent,
  FormRowComponent,
  IconButtonComponent,
  IconComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import { NativePickers } from '../shared/native-pickers';

/** Result resolved by the editor (Save). */
export interface JavaVersionEntry {
  readonly name: string;
  readonly path: string;
}

@Component({
  selector: 'app-java-editor-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DialogShellComponent,
    FormRowComponent,
    IconButtonComponent,
    IconComponent,
    TPipe,
  ],
  styleUrl: './java-editor-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="title()"
      (closed)="closeSelf(null)"
    >
      <div class="java-editor">
        <h3 class="java-editor__header">{{ 'dialog.settings.java_config_header' | t }}</h3>

        <ui-form-row [label]="'dialog.settings.java_field_name' | t">
          <input
            #nameInput
            class="java-editor__input"
            type="text"
            [placeholder]="'dialog.settings.java_name_placeholder' | t"
            [value]="name()"
            (input)="name.set(nameInput.value)"
          />
        </ui-form-row>

        <ui-form-row [label]="'dialog.settings.java_field_path' | t">
          <div class="java-editor__path-row">
            <input
              #pathInput
              class="java-editor__input"
              type="text"
              [placeholder]="'dialog.settings.java_path_placeholder' | t"
              [value]="path()"
              (input)="path.set(pathInput.value)"
            />
            <ui-icon-button
              [title]="'dialog.settings.java_dir_title' | t"
              (clicked)="browse()"
              ><ui-icon name="folder" /></ui-icon-button
            >
          </div>
        </ui-form-row>

        @if (error()) {
          <p class="java-editor__error">{{ error() }}</p>
        }
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf(null)">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="success" (clicked)="save()">
          {{ 'btn.save' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class JavaEditorDialogComponent extends DialogBase {
  /** Window kind for opening this as a child dialog window (minify-safe). */
  static readonly dialogKind = 'java-editor';

  /** Pre-filled name (edit mode); empty = new entry. */
  readonly initialName = input('');
  /** Pre-filled JAVA_HOME path (edit mode). */
  readonly initialPath = input('');

  private readonly i18n = inject(TranslationService);
  private readonly pickers = inject(NativePickers);

  protected readonly name = signal('');
  protected readonly path = signal('');
  protected readonly error = signal('');

  /** `java_new_title` / `java_edit_title` per mode (§22). */
  protected readonly title = computed(() =>
    this.i18n.t(
      this.initialName() === ''
        ? 'dialog.settings.java_new_title'
        : 'dialog.settings.java_edit_title',
    ),
  );

  constructor() {
    super();
    // Inputs are bound after construction — seed the editable copies once.
    afterNextRender(() => {
      this.name.set(this.initialName());
      this.path.set(this.initialPath());
    });
  }

  protected async browse(): Promise<void> {
    const dir = await this.pickers.pickDirectory(
      this.i18n.t('dialog.settings.java_dir_title'),
    );
    if (dir !== null) {
      this.path.set(dir);
      this.error.set('');
    }
  }

  protected save(): void {
    const name = this.name().trim();
    const path = this.path().trim();
    if (name === '') {
      this.error.set(this.i18n.t('dialog.settings.java_name_required'));
      return;
    }
    if (path === '') {
      this.error.set(this.i18n.t('dialog.settings.java_path_required'));
      return;
    }
    this.closeSelf({ name, path } satisfies JavaVersionEntry);
  }
}
