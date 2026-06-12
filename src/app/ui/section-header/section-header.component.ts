import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Section title with trailing rule — the recurring v1 grouping pattern
 * (settings sections §22, log header `label.log_section` §8, global panel
 * title §3). Optional right-aligned actions slot (e.g. the log panel's
 * detach/clear buttons).
 *
 * ```html
 * <ui-section-header [label]="t('label.log_section')">
 *   <ui-button variant="log-action" size="sm" …>{{ t('btn.clear_log') }}</ui-button>
 * </ui-section-header>
 * ```
 */
@Component({
  selector: 'ui-section-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './section-header.component.scss',
  template: `
    <span class="section__label">{{ label() }}</span>
    <span class="section__rule"></span>
    <div class="section__actions"><ng-content /></div>
  `,
})
export class SectionHeaderComponent {
  /** Section title (already translated). */
  readonly label = input('');
}
