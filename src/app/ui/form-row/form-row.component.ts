import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { IconComponent, type IconName } from '../icon/icon.component';

/**
 * Label + control row — the recurring v1 dialog/panel layout (clone §15,
 * settings §22, merge §20, expand-panel rows §7): a fixed-width muted label
 * on the left, the control(s) stretching to the right. An optional leading
 * `icon` renders an inline SVG before the label (settings section headers).
 *
 * ```html
 * <ui-form-row icon="globe" [label]="t('dialog.settings.language_title')">
 *   <select … ></select>
 * </ui-form-row>
 * ```
 */
@Component({
  selector: 'ui-form-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  styleUrl: './form-row.component.scss',
  template: `
    <span class="row__label" [style.width]="labelWidth()">
      @if (icon(); as ic) {
        <ui-icon [name]="ic" [size]="15" />
      }
      {{ label() }}
    </span>
    <div class="row__control"><ng-content /></div>
  `,
})
export class FormRowComponent {
  /** Row label (already translated). */
  readonly label = input('');
  /** Optional leading icon (settings section headers). */
  readonly icon = input<IconName | ''>('');
  /** CSS width reserved for the label column (aligns stacked rows). */
  readonly labelWidth = input('110px');
}
