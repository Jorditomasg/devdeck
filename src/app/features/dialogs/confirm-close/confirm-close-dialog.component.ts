/**
 * Confirm-close guard — v1 `ConfirmCloseDialog` (inventory-gui §17).
 *
 * Shown by the app close path when ≥1 service is running/starting. Resolves
 * `true` (close everything) only via the explicit confirm button; Cancel,
 * ESC and ✕ resolve the `false` fallback.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { ButtonComponent, DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';

@Component({
  selector: 'app-confirm-close-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  styles: `
    .confirm-close__msg {
      margin: 0;
      color: var(--color-text-primary);
      font-size: var(--font-size-base);
      line-height: 1.55;
      white-space: pre-line;
    }
  `,
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.confirm_close.title' | t"
      width="420px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf(false)"
    >
      <p class="confirm-close__msg">{{ message() }}</p>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf(false)">
          {{ 'dialog.confirm_close.btn_cancel' | t }}
        </ui-button>
        <ui-button variant="danger" (clicked)="closeSelf(true)">
          {{ 'dialog.confirm_close.btn_confirm' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class ConfirmCloseDialogComponent extends DialogBase {
  /** Count of running/starting services (drives the _one/_many message). */
  readonly runningCount = input(1);

  private readonly i18n = inject(TranslationService);

  /** v1 plural pair: `message_one` for exactly 1, `message_many` otherwise. */
  protected readonly message = computed(() =>
    this.i18n.tn('dialog.confirm_close.message', this.runningCount()),
  );
}
