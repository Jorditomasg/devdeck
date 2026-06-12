import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Indeterminate activity spinner — used where v1 showed transient busy text
 * (e.g. "Scanning…" statusbar §4, install/clone progress §12/§15) while a
 * backend operation runs.
 *
 * Colors via `currentColor` so it inherits the surrounding text/accent color;
 * set an explicit color on the host when needed.
 */
@Component({
  selector: 'ui-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './spinner.component.scss',
  template: `
    <span
      class="spinner spinner--{{ size() }}"
      role="progressbar"
      [attr.aria-label]="label() || null"
    ></span>
  `,
})
export class SpinnerComponent {
  /** sm=12px, md=16px, lg=24px. */
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  /** Accessible label (already translated). */
  readonly label = input('');
}
