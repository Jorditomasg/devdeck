/**
 * Single-line text prompt — replaces v1 `_AskNameDialog`
 * (gui/dialogs/repo_config_manager.py, inventory-gui §23): a prompt label +
 * pre-selected entry, Accept/Cancel, Enter=accept, ESC=cancel.
 *
 * Promise-based: resolves the entered string, or `null` (the registered
 * fallback) on Cancel / ESC / ✕. Open via:
 *
 * ```ts
 * const name = await dialogs.openForResult<string | null>(
 *   PromptDialogComponent,
 *   { title, prompt, initial: 'old-name' },
 *   null,
 * );
 * ```
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { ButtonComponent, DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';

@Component({
  selector: 'app-prompt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  styleUrl: './prompt-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="title()"
      width="380px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf(null)"
    >
      <label class="prompt__label" for="prompt-input">{{ prompt() }}</label>
      <input
        #entry
        id="prompt-input"
        class="prompt__input"
        type="text"
        [value]="value()"
        [placeholder]="placeholder()"
        (input)="value.set(entry.value)"
        (keydown.enter)="accept()"
      />

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf(null)">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="blue" [disabled]="value().trim() === ''" (clicked)="accept()">
          {{ 'btn.accept' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class PromptDialogComponent extends DialogBase {
  /** Already-translated title. */
  readonly title = input('');
  /** Already-translated prompt label. */
  readonly prompt = input('');
  /** Pre-filled value (v1 pre-selected the entry text). */
  readonly initial = input('');
  readonly placeholder = input('');

  protected readonly value = signal('');

  private readonly entry = viewChild.required<ElementRef<HTMLInputElement>>('entry');

  constructor() {
    super();
    afterNextRender(() => {
      this.value.set(this.initial());
      const el = this.entry().nativeElement;
      el.value = this.initial();
      el.focus();
      el.select(); // v1: entry text pre-selected
    });
  }

  protected accept(): void {
    const value = this.value().trim();
    if (value !== '') {
      this.closeSelf(value);
    }
  }
}
