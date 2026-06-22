/**
 * Generic single-line text prompt — the v2 replacement for a `simpledialog`
 * ask-string. Resolves the entered text on OK, or `null` on Cancel/ESC/✕
 * (the registered fallback). Used for renames (branch, repo-config names): the
 * pre-filled text is focused and selected, matching v1's pre-selected entry.
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
  template: `
    <ui-dialog-shell
      [dialogTitle]="title()"
      (closed)="closeSelf()"
    >
      <div class="prompt">
        <p class="prompt__message">{{ message() }}</p>
        <input
          #field
          class="prompt__input"
          type="text"
          [value]="value()"
          [placeholder]="placeholder()"
          (input)="value.set(field.value)"
          (keydown.enter)="confirm()"
        />
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="blue" [disabled]="value().trim() === ''" (clicked)="confirm()">
          {{ 'btn.accept' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class PromptDialogComponent extends DialogBase {
  readonly title = input('');
  readonly message = input('');
  readonly placeholder = input('');
  readonly initialValue = input('');

  protected readonly value = signal('');

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  constructor() {
    super();
    afterNextRender(() => {
      this.value.set(this.initialValue());
      const el = this.field().nativeElement;
      el.value = this.initialValue();
      el.focus();
      el.select(); // v1: entry text pre-selected for quick rename
    });
  }

  protected confirm(): void {
    const text = this.value().trim();
    if (text === '') {
      return;
    }
    this.closeSelf(text);
  }
}
