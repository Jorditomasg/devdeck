/**
 * Full changelog viewer — renders the parsed `get_changelog` history.
 * Pure presentational over `UpdatesStore.loadChangelog()`; stacks on top of
 * the settings dialog.
 */
import {
  ChangeDetectionStrategy,
  Component,
  type OnInit,
  inject,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { UpdatesStore } from '../../../core/state/updates.store';
import type { ChangelogRelease } from '../../../core/ipc/tauri.types';
import { DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';

/** Section key → i18n label, in display order. */
interface ChangelogGroup {
  readonly key: 'added' | 'changed' | 'fixed' | 'removed';
  readonly label: string;
}

@Component({
  selector: 'app-changelog-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogShellComponent, TPipe],
  styleUrl: './changelog-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.changelog.title' | t"
      (closed)="closeSelf()"
    >
      <div class="changelog">
        @if (releases(); as list) {
          @for (rel of list; track rel.version) {
            <section class="changelog__release">
              <h3 class="changelog__version">
                {{ rel.version }}
                @if (rel.date) {
                  <span class="changelog__date">— {{ rel.date }}</span>
                }
              </h3>
              @for (group of groups; track group.key) {
                @if (rel[group.key].length) {
                  <h4 class="changelog__section">{{ group.label | t }}</h4>
                  <ul class="changelog__items">
                    @for (item of rel[group.key]; track item) {
                      <li>{{ item }}</li>
                    }
                  </ul>
                }
              }
            </section>
          }
        } @else {
          <p class="changelog__empty">{{ 'dialog.changelog.unavailable' | t }}</p>
        }
      </div>
    </ui-dialog-shell>
  `,
})
export class ChangelogDialogComponent extends DialogBase implements OnInit {
  /** Window kind for opening this as a child dialog window (minify-safe). */
  static readonly dialogKind = 'changelog';

  private readonly updates = inject(UpdatesStore);

  protected readonly releases = signal<readonly ChangelogRelease[] | null>(null);

  protected readonly groups: readonly ChangelogGroup[] = [
    { key: 'added', label: 'dialog.changelog.added' },
    { key: 'changed', label: 'dialog.changelog.changed' },
    { key: 'fixed', label: 'dialog.changelog.fixed' },
    { key: 'removed', label: 'dialog.changelog.removed' },
  ];

  async ngOnInit(): Promise<void> {
    try {
      this.releases.set(await this.updates.loadChangelog());
    } catch {
      this.releases.set([]);
    }
  }
}
