import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  signal,
} from '@angular/core';

import { gravatarUrl, hueOf, initialsOf } from './avatar.logic';

/**
 * Commit-author avatar (git suite phase 1): tries Gravatar (`d=404`) and
 * falls back to initials on a deterministic per-email hue when the email has
 * no Gravatar or the machine is offline. Pure presentational — receives
 * plain `email`/`name` inputs, no core imports.
 */
@Component({
  selector: 'ui-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './avatar.component.scss',
  host: {
    class: 'avatar',
    '[style.--avatar-size.px]': 'size()',
    '[style.--avatar-hue]': 'hue()',
    '[attr.title]': 'name() || null',
  },
  template: `
    @if (url() && !failed()) {
      <img class="avatar__img" [src]="url()" [alt]="name()" (error)="failed.set(true)" />
    } @else {
      <span class="avatar__initials">{{ initials() }}</span>
    }
  `,
})
export class AvatarComponent {
  readonly email = input('');
  readonly name = input('');
  /** Rendered size in px (the Gravatar request asks 64 and downscales). */
  readonly size = input(28);

  protected readonly url = signal('');
  protected readonly failed = signal(false);
  protected readonly initials = computed(() => initialsOf(this.name()) || '?');
  protected readonly hue = computed(() => hueOf(this.email().trim().toLowerCase()));

  constructor() {
    effect(() => {
      const email = this.email().trim();
      this.failed.set(false);
      this.url.set('');
      if (!email) {
        return;
      }
      void gravatarUrl(email).then((href) => this.url.set(href));
    });
  }
}
