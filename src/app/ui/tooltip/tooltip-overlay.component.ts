import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

/**
 * Tooltip panel rendered by `TooltipDirective` — visual port of the v1
 * `ToolTip` toplevel (inventory-gui §31): 1px border + inner bg in the theme
 * tooltip colors, md font, wrap width from `--tooltip-wrap` (250px),
 * left-justified.
 *
 * Not meant to be used directly in templates — the directive creates it,
 * appends it to `<body>` and drives `text`/position imperatively.
 */
@Component({
  selector: 'ui-tooltip-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tooltip-overlay.component.scss',
  host: {
    role: 'tooltip',
    '[style.left.px]': 'x()',
    '[style.top.px]': 'y()',
    '[style.visibility]': "measured() ? 'visible' : 'hidden'",
  },
  template: `{{ text() }}`,
})
export class TooltipOverlayComponent {
  /** Driven by TooltipDirective — imperative API, not template inputs. */
  readonly text = signal('');
  readonly x = signal(0);
  readonly y = signal(0);
  /** Kept hidden until the directive has measured and clamped the position. */
  readonly measured = signal(false);
}
