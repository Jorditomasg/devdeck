/**
 * Save-overwrite confirm — replaces the plain-text messagebox that used to ask
 * "overwrite profile X?" with a flat blob of change lines. Renders the
 * structured {@link RepoOverwriteDiff} as a scrollable list: per repo a status
 * badge (changed / new / removed) and, for changed repos, each overwritten
 * field with its before→after value. Resolves `true` only via the confirm
 * button; Cancel / ESC / ✕ resolve the `false` fallback.
 *
 * `null` values (empty/unset) render as a dash. An empty diff (name collision
 * but identical content) still shows — it re-saves as is.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import type { OverwriteField, RepoOverwriteDiff } from '../../../core/state/profiles.store';
import { ButtonComponent, DialogShellComponent, IconComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';
import { FIELD_LABEL_KEYS } from './profile-manager.logic';

@Component({
  selector: 'app-overwrite-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, IconComponent, TPipe],
  styles: `
    .ow {
      display: flex;
      flex-direction: column;
      gap: 14px;
      height: 100%;
      min-height: 0;
    }
    .ow__head {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .ow__head-icon {
      color: var(--color-text-warning-badge);
      flex: none;
      margin-top: 2px;
    }
    .ow__title {
      margin: 0;
      font-size: var(--font-size-base);
      font-weight: 600;
      color: var(--color-text-primary);
      line-height: 1.4;
    }
    .ow__pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .ow__pill {
      font-size: 12px;
      font-weight: 600;
      padding: 2px 9px;
      border-radius: 999px;
      border: 1px solid currentColor;
      line-height: 1.6;
    }
    .ow__pill--changed { color: var(--color-text-warning-badge); }
    .ow__pill--added { color: var(--color-status-running); }
    .ow__pill--removed { color: var(--color-status-error); }

    .ow__none {
      margin: 0;
      color: var(--color-text-secondary);
      font-size: var(--font-size-base);
    }

    /* Scrollable list owns the overflow so the dialog itself never scrolls. */
    .ow__list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
    }
    .ow__repo {
      background: var(--color-section-alt);
      border: 1px solid var(--color-border-subtle);
      border-left: 3px solid var(--color-border-subtle);
      border-radius: 8px;
      padding: 9px 12px;
    }
    .ow__repo--changed { border-left-color: var(--color-text-warning-badge); }
    .ow__repo--added { border-left-color: var(--color-status-running); }
    .ow__repo--removed { border-left-color: var(--color-status-error); }

    .ow__repo-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ow__badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 6px;
      flex: none;
      color: #fff;
    }
    .ow__badge--changed { background: var(--color-text-warning-badge); }
    .ow__badge--added { background: var(--color-status-running); }
    .ow__badge--removed { background: var(--color-status-error); }
    .ow__repo-name {
      font-weight: 600;
      color: var(--color-text-primary);
      overflow-wrap: anywhere;
    }
    .ow__tag {
      margin-left: auto;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--color-text-secondary);
    }

    .ow__fields {
      display: grid;
      grid-template-columns: minmax(0, auto) 1fr;
      gap: 4px 14px;
      margin-top: 8px;
      padding-left: 28px;
      font-size: 13px;
    }
    .ow__field-label {
      color: var(--color-text-secondary);
      white-space: nowrap;
    }
    .ow__field-vals {
      display: flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .ow__val {
      overflow-wrap: anywhere;
    }
    .ow__val--from { color: var(--color-text-muted); }
    .ow__val--to { color: var(--color-text-primary); font-weight: 600; }
    .ow__arrow { color: var(--color-text-muted); flex: none; }
  `,
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.profile.overwrite_title' | t"
      (closed)="closeSelf(false)"
    >
      <div class="ow">
        <header class="ow__head">
          <ui-icon class="ow__head-icon" name="alert-triangle" [size]="22" />
          <div>
            <p class="ow__title">
              {{ 'dialog.profile.overwrite_heading' | t: { name: name() } }}
            </p>
            <div class="ow__pills">
              @if (changedCount() > 0) {
                <span class="ow__pill ow__pill--changed">
                  {{ changedCount() }} {{ 'dialog.profile.overwrite_changed' | t }}
                </span>
              }
              @if (addedCount() > 0) {
                <span class="ow__pill ow__pill--added">
                  {{ addedCount() }} {{ 'dialog.profile.overwrite_added' | t }}
                </span>
              }
              @if (removedCount() > 0) {
                <span class="ow__pill ow__pill--removed">
                  {{ removedCount() }} {{ 'dialog.profile.overwrite_removed' | t }}
                </span>
              }
            </div>
          </div>
        </header>

        @if (diff().length === 0) {
          <p class="ow__none">{{ 'dialog.profile.overwrite_none' | t }}</p>
        } @else {
          <ul class="ow__list">
            @for (row of diff(); track row.repo) {
              <li class="ow__repo ow__repo--{{ row.status }}">
                <div class="ow__repo-head">
                  <span class="ow__badge ow__badge--{{ row.status }}" aria-hidden="true">
                    @switch (row.status) {
                      @case ('added') { <ui-icon name="plus" [size]="13" /> }
                      @case ('removed') { <ui-icon name="minus" [size]="13" /> }
                      @default { <ui-icon name="pencil" [size]="12" /> }
                    }
                  </span>
                  <span class="ow__repo-name">{{ row.repo }}</span>
                  @if (row.status === 'added') {
                    <span class="ow__tag">{{ 'dialog.profile.overwrite_added' | t }}</span>
                  } @else if (row.status === 'removed') {
                    <span class="ow__tag">{{ 'dialog.profile.overwrite_removed' | t }}</span>
                  }
                </div>

                @if (row.fields.length > 0) {
                  <div class="ow__fields">
                    @for (f of row.fields; track f.field) {
                      <span class="ow__field-label">{{ labelKey(f.field) | t }}</span>
                      <span class="ow__field-vals">
                        <span class="ow__val ow__val--from">{{ f.from ?? '—' }}</span>
                        <span class="ow__arrow" aria-hidden="true">→</span>
                        <span class="ow__val ow__val--to">{{ f.to ?? '—' }}</span>
                      </span>
                    }
                  </div>
                }
              </li>
            }
          </ul>
        }
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf(false)">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="blue" (clicked)="closeSelf(true)">
          {{ 'dialog.profile.overwrite_title' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class OverwriteConfirmDialogComponent extends DialogBase {
  /** Profile name being overwritten (shown in the heading). */
  readonly name = input('');
  /** Per-repo diff of the stored profile vs the live capture. */
  readonly diff = input<readonly RepoOverwriteDiff[]>([]);

  protected readonly changedCount = computed(
    () => this.diff().filter((d) => d.status === 'changed').length,
  );
  protected readonly addedCount = computed(
    () => this.diff().filter((d) => d.status === 'added').length,
  );
  protected readonly removedCount = computed(
    () => this.diff().filter((d) => d.status === 'removed').length,
  );

  /** i18n key for a field label (rendered through the `| t` pipe). */
  protected labelKey(field: OverwriteField): string {
    return FIELD_LABEL_KEYS[field];
  }
}
