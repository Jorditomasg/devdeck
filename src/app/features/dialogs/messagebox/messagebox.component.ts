/**
 * Themed messagebox — replaces v1 `gui/dialogs/messagebox.py` (inventory-gui
 * §14): `show_info` / `show_warning` / `show_error` / `ask_yes_no`.
 *
 * v1 visual language kept: 5px colored accent bar, icon glyph per kind
 * (ℹ/⚠/✕/?), right-aligned buttons. Promise resolution happens through
 * `DialogService.close(id, result)` — OK resolves `true`, Yes `true`,
 * No / ESC / ✕ resolve the `false` fallback.
 *
 * v2 fix over v1: button labels were hardcoded "OK"/"Yes"/"No" in v1 (§14
 * flagged it); here they use `btn.ok` / `btn.yes` / `btn.no`.
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import {
  ButtonComponent,
  DialogShellComponent,
  IconComponent,
  type IconName,
} from '../../../ui';
import { DialogBase } from '../dialog-base';

/** v1 messagebox kinds (§14 table). */
export type MessageboxKind = 'info' | 'warning' | 'error' | 'confirm';

const ICONS: Record<MessageboxKind, IconName> = {
  info: 'info',
  warning: 'alert-triangle',
  error: 'x-circle',
  confirm: 'help-circle',
};

@Component({
  selector: 'app-messagebox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, IconComponent, TPipe],
  styleUrl: './messagebox.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="title()"
      (closed)="closeSelf()"
    >
      <div class="msg msg--{{ kind() }}">
        <span class="msg__icon" aria-hidden="true"><ui-icon [name]="icon" [size]="28" /></span>
        <p class="msg__text">{{ message() }}</p>
      </div>

      <div uiDialogFooter>
        @if (kind() === 'confirm') {
          <ui-button variant="neutral" (clicked)="closeSelf(false)">
            {{ 'btn.no' | t }}
          </ui-button>
          <ui-button variant="blue" (clicked)="closeSelf(true)">
            {{ 'btn.yes' | t }}
          </ui-button>
        } @else {
          <ui-button [variant]="okVariant" (clicked)="closeSelf(true)">
            {{ 'btn.ok' | t }}
          </ui-button>
        }
      </div>
    </ui-dialog-shell>
  `,
})
export class MessageboxComponent extends DialogBase {
  readonly kind = input<MessageboxKind>('info');
  /** Already-translated title (callers pass `t(...)` output). */
  readonly title = input('');
  /** Already-translated message body. */
  readonly message = input('');

  protected get icon(): IconName {
    return ICONS[this.kind()];
  }

  /** OK button variant per v1 §14 (info→blue, warning→warning, error→danger). */
  protected get okVariant(): 'blue' | 'warning' | 'danger' {
    const kind = this.kind();
    return kind === 'warning' ? 'warning' : kind === 'error' ? 'danger' : 'blue';
  }
}
