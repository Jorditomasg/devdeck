/**
 * `| t` template pipe — `{{ 'btn.start' | t }}` /
 * `{{ 'label.java_recommended' | t : { version: '17' } }}`.
 *
 * WHY `pure: false` (the idiomatic zoneless choice, justified):
 * A pure pipe memoizes on its input arguments, so a language switch would
 * NOT re-invoke `transform` — stale strings forever. Marking it impure means
 * `transform` runs on every change-detection pass OF THAT VIEW, and because
 * `TranslationService.t()` reads the `language`/catalog signals inside the
 * template's reactive context, the signal dependency is registered on first
 * render: in zoneless mode a language change is exactly what schedules that
 * view's next CD pass. Net effect: re-render happens ONLY when a consumed
 * signal changes (no zone.js polling), and the per-pass cost is a cheap map
 * lookup + interpolation. The alternative (pure pipe + forcing component
 * re-creation on language change) was rejected — v1 required an app restart
 * for language changes; v2 upgrades this to live switching for free.
 */
import { Pipe, type PipeTransform } from '@angular/core';

import { TranslationService, type TranslateParams } from './translation.service';

@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  constructor(private readonly i18n: TranslationService) {}

  /** Translate `key`, optionally interpolating `{placeholder}` params. */
  transform(key: string, params?: TranslateParams): string {
    return this.i18n.t(key, params);
  }
}
