import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * The 16 v1 button variants, mirrored 1:1 from `$btn-variants` in
 * `styles/_tokens.scss` (config/ui_theme.yml `buttons.*` — inventory-gui §29).
 */
export const BUTTON_VARIANTS = [
  'success',
  'start',
  'danger',
  'danger-alt',
  'danger-deep',
  'warning',
  'blue',
  'blue-active',
  'neutral',
  'neutral-alt',
  'purple',
  'purple-alt',
  'purple-global',
  'log-action',
  'toggle-expand',
  'profile-accent',
] as const;

export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

/** Heights map to --geo-btn-height-{sm,md,lg} (24/28/34px — inventory-gui §29). */
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * Standard push button — replaces every `ctk.CTkButton` styled via
 * `theme.btn_style(variant, height, …)` (inventory-gui §29 "API surface").
 *
 * Pure presentational: text/icon arrive via content projection (i18n happens
 * in containers). Emits `clicked` only when enabled and not loading — the
 * inner native `<button>` enforces this, unlike a bare host `(click)`.
 *
 * Usage:
 * ```html
 * <ui-button variant="start" size="md" (clicked)="start()">
 *   <span uiButtonIcon>▶</span> {{ t('btn.start') }}
 * </ui-button>
 * ```
 */
@Component({
  selector: 'ui-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './button.component.scss',
  template: `
    <button
      type="button"
      class="btn btn--{{ variant() }} btn--{{ size() }}"
      [class.btn--loading]="loading()"
      [disabled]="disabled() || loading()"
      (click)="clicked.emit($event)"
    >
      @if (loading()) {
        <span class="btn__spinner" aria-hidden="true"></span>
      }
      <span class="btn__content"><ng-content /></span>
    </button>
  `,
})
export class ButtonComponent {
  /** One of the 16 token variants (inventory-gui §29). */
  readonly variant = input<ButtonVariant>('neutral');
  /** sm=24px (log actions), md=28px (standard), lg=34px (topbar/profile). */
  readonly size = input<ButtonSize>('md');
  readonly disabled = input(false);
  /** Replaces the icon/label with a spinner and disables interaction. */
  readonly loading = input(false);
  /** Fired on user click — never while disabled or loading. */
  readonly clicked = output<MouseEvent>();
}
