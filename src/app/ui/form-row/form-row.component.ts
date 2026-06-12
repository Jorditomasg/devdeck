import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Label + control row — the recurring v1 dialog/panel layout (clone §15,
 * settings §22, merge §20, expand-panel rows §7): a fixed-width muted label
 * on the left, the control(s) stretching to the right.
 *
 * ```html
 * <ui-form-row [label]="t('dialog.clone.url')">
 *   <input … />
 * </ui-form-row>
 * ```
 */
@Component({
  selector: 'ui-form-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './form-row.component.scss',
  template: `
    <span class="row__label" [style.width]="labelWidth()">{{ label() }}</span>
    <div class="row__control"><ng-content /></div>
  `,
})
export class FormRowComponent {
  /** Row label (already translated). */
  readonly label = input('');
  /** CSS width reserved for the label column (aligns stacked rows). */
  readonly labelWidth = input('110px');
}
