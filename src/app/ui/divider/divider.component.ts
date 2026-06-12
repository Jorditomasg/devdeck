import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * 1px separator line — replaces the v1 `backgrounds.divider` frames
 * (topbar/global-panel separators §2-3, SearchableCombo recents divider §32,
 * settings section separators §22).
 */
@Component({
  selector: 'ui-divider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './divider.component.scss',
  host: {
    role: 'separator',
    '[class.divider--vertical]': "orientation() === 'vertical'",
    '[attr.aria-orientation]': 'orientation()',
  },
  template: '',
})
export class DividerComponent {
  readonly orientation = input<'horizontal' | 'vertical'>('horizontal');
}
