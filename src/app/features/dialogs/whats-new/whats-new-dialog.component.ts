/**
 * Post-update "What's new" popup. Shown once after the app updates to a new
 * version (triggered from the main-window bootstrap via
 * `whats_new_on_startup`). Renders the changelog entry for the now-running
 * version — structured sections, so line breaks are correct without any
 * raw-markdown rendering — plus a "don't show again" opt-out.
 */
import {
  ChangeDetectionStrategy,
  Component,
  type OnInit,
  inject,
  input,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { IpcCommands } from '../../../core/ipc/commands';
import type { ChangelogRelease } from '../../../core/ipc/tauri.types';
import { UpdatesStore } from '../../../core/state/updates.store';
import { ButtonComponent, DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';

/** Section key → i18n label, in display order (mirrors the changelog viewer). */
interface ChangelogGroup {
  readonly key: 'added' | 'changed' | 'fixed' | 'removed';
  readonly label: string;
}

@Component({
  selector: 'app-whats-new-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  styleUrl: './whats-new-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.whats_new.title' | t: { version: version() }"
      (closed)="dismiss()"
    >
      <div class="whats-new">
        @if (release(); as rel) {
          @for (group of groups; track group.key) {
            @if (rel[group.key].length) {
              <h4 class="whats-new__section">{{ group.label | t }}</h4>
              <ul class="whats-new__items">
                @for (item of rel[group.key]; track item) {
                  <li>{{ item }}</li>
                }
              </ul>
            }
          }
        } @else {
          <p class="whats-new__empty">{{ 'dialog.whats_new.unavailable' | t }}</p>
        }
      </div>

      <div uiDialogFooter>
        <label class="whats-new__check">
          <input
            type="checkbox"
            [checked]="dontShowAgain()"
            (change)="dontShowAgain.set(!dontShowAgain())"
          />
          {{ 'dialog.whats_new.dont_show_again' | t }}
        </label>
        <ui-button variant="success" size="lg" (clicked)="dismiss()">
          {{ 'btn.close' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class WhatsNewDialogComponent extends DialogBase implements OnInit {
  /** Window kind for opening this as a child dialog window (minify-safe). */
  static readonly dialogKind = 'whats-new';

  /** Version whose changes to show (the now-running version). */
  readonly version = input.required<string>();

  private readonly updates = inject(UpdatesStore);
  private readonly commands = inject(IpcCommands);

  protected readonly release = signal<ChangelogRelease | null>(null);
  protected readonly dontShowAgain = signal(false);

  protected readonly groups: readonly ChangelogGroup[] = [
    { key: 'added', label: 'dialog.changelog.added' },
    { key: 'changed', label: 'dialog.changelog.changed' },
    { key: 'fixed', label: 'dialog.changelog.fixed' },
    { key: 'removed', label: 'dialog.changelog.removed' },
  ];

  async ngOnInit(): Promise<void> {
    try {
      const history = await this.updates.loadChangelog();
      this.release.set(history.find((r) => r.version === this.version()) ?? null);
    } catch {
      this.release.set(null);
    }
  }

  /** Close, persisting the opt-out if checked. The version is already marked
   *  seen by `whats_new_on_startup`, so closing alone never re-shows it. */
  protected dismiss(): void {
    if (this.dontShowAgain()) {
      void this.commands.updates.disableWhatsNew();
    }
    this.closeSelf();
  }
}
