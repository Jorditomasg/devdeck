import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ButtonVariant } from '../button/button.component';

/**
 * Square compact icon button — replaces the narrow fixed-width CTkButtons of
 * the card header action row (▶ Start w32, ⬛ Stop w32, 🔄 Restart w32,
 * 📁 Open w28, ▼/▲ expand w28 — inventory-gui §6) and the dialog header
 * controls.
 *
 * Same 16 token variants as `ui-button`; width equals height for a perfect
 * square. Glyph arrives via content projection.
 *
 * ```html
 * <ui-icon-button variant="danger" [title]="t('tooltip.stop_btn')"
 *                 (clicked)="stop()">⬛</ui-icon-button>
 * ```
 */
@Component({
  selector: 'ui-icon-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './icon-button.component.scss',
  template: `
    <button
      type="button"
      class="icon-btn icon-btn--{{ variant() }} icon-btn--{{ size() }}"
      [disabled]="disabled()"
      [attr.title]="title() || null"
      [attr.aria-label]="title() || null"
      (click)="clicked.emit($event)"
    >
      <ng-content />
    </button>
  `,
})
export class IconButtonComponent {
  readonly variant = input<ButtonVariant>('neutral');
  /** sm=24px, md=28px, lg=34px square — same token heights as ui-button. */
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly disabled = input(false);
  /** Native title (lightweight hover hint); use uiTooltip for the rich one. */
  readonly title = input('');
  readonly clicked = output<MouseEvent>();
}
