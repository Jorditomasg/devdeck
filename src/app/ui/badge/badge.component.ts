import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Badge tones, mapped to the v1 header hint colors (inventory-gui §6, §33):
 * - `accent`  → 📥 pull-behind count + 📝 changes count (git working state)
 * - `warning` → danger-env / deps-missing (warning yellow highlight)
 * - `error`   → ⚠️ merge-conflict count (status error red)
 * - `muted`   → grey hint fragments (⎇ branch / ⚙ profile / $ cmd)
 * - `solid`   → repo type pill: white bold text on a custom bg color
 *               (`ui_config.color`), radius --geo-corner-badge, height 18px
 */
export type BadgeTone = 'accent' | 'warning' | 'error' | 'muted' | 'solid';

/**
 * Small pill / inline hint for git counts and warnings — replaces the v1
 * header badge labels (`_pull_count_label`, `_changes_count_label`,
 * `_conflict_count_label`, `_danger_env_badge`, type badge — inventory-gui §6).
 *
 * Content (icon + count/text, already i18n'd) is projected. Clickable badges
 * (pull → pull, changes → list files) are the container's concern: wrap or
 * bind (click) on the host and set `interactive` for hover affordance.
 *
 * `pulse` adds a subtle attention animation (e.g. new conflicts detected).
 */
@Component({
  selector: 'ui-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './badge.component.scss',
  host: {
    class: 'badge',
    '[class.badge--accent]': "tone() === 'accent'",
    '[class.badge--warning]': "tone() === 'warning'",
    '[class.badge--error]': "tone() === 'error'",
    '[class.badge--muted]': "tone() === 'muted'",
    '[class.badge--solid]': "tone() === 'solid'",
    '[class.badge--mono]': 'mono()',
    '[class.badge--pulse]': 'pulse()',
    '[class.badge--interactive]': 'interactive()',
    '[style.background-color]': "tone() === 'solid' ? bg() : null",
    '[attr.title]': 'title() || null',
  },
  template: `<ng-content />`,
})
export class BadgeComponent {
  readonly tone = input<BadgeTone>('muted');
  /** Custom background for `solid` tone (repo type `ui_config.color`). */
  readonly bg = input('var(--color-section)');
  /** Mono font (deps-missing / hint fragments use xs mono in v1). */
  readonly mono = input(false);
  /** Subtle pulse animation to draw attention. */
  readonly pulse = input(false);
  /** Hover affordance for clickable badges (pull / changes / conflicts). */
  readonly interactive = input(false);
  /** Native title hint; use uiTooltip for the rich tooltip. */
  readonly title = input('');
}
