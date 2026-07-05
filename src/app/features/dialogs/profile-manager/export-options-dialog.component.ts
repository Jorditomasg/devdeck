/**
 * Export options dialog — selective profile export.
 *
 * A per-repo matrix: pick which repos to export and, per repo, which config
 * categories to include (start command / environment selection / saved
 * environments). `git_url`/`type`/`java_version` are always exported (repo
 * identity); `config_files` never is. The destination path is chosen via the
 * native save picker, opened directly when the user confirms.
 *
 * Promise-based: resolves {@link ExportOptionsResult} on confirm, `null` on
 * cancel. The PARENT (ProfileManager) owns the actual write + success dialog.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import type { ProfileDocument } from '../../../core/ipc/tauri.types';
import { ButtonComponent, DialogShellComponent, IconComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';
import { NativePickers } from '../shared/native-pickers';
import {
  filterProfileDocument,
  hasSavedEnvironments,
  type RepoExportSelection,
} from './profile-manager.logic';

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }] as const;

/** Category flags a checkbox can toggle. */
type Category = 'starts' | 'environment' | 'savedEnvs';

/** Resolved on confirm (`null` = cancelled). */
export interface ExportOptionsResult {
  /** The filtered document to write. */
  readonly doc: ProfileDocument;
  /** Chosen destination path. */
  readonly dest: string;
}

@Component({
  selector: 'app-export-options-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, IconComponent, TPipe],
  styleUrl: './export-options-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.export.title' | t: { name: defaultName() }"
      (closed)="closeSelf(null)"
    >
      <div class="export">
        <div class="export__toolbar">
          <span class="export__toolbar-title">{{ 'dialog.export.repos_title' | t }}</span>
          <span class="export__toolbar-actions">
            <ui-button variant="neutral" size="sm" (clicked)="setAll(true)">
              {{ 'dialog.export.select_all' | t }}
            </ui-button>
            <ui-button variant="neutral" size="sm" (clicked)="setAll(false)">
              {{ 'dialog.export.select_none' | t }}
            </ui-button>
          </span>
        </div>

        <div class="export__list">
          @for (name of repoNames(); track name) {
            <div class="export__repo" [class.export__repo--off]="!sel()[name].included">
              <label class="export__repo-head">
                <input
                  type="checkbox"
                  [checked]="sel()[name].included"
                  (change)="toggleRepo(name)"
                />
                <span class="export__repo-name">{{ name }}</span>
              </label>
              <div class="export__cats">
                <label class="export__cat">
                  <input
                    type="checkbox"
                    [checked]="sel()[name].starts"
                    [disabled]="!sel()[name].included"
                    (change)="toggleCat(name, 'starts')"
                  />
                  {{ 'dialog.export.cat_starts' | t }}
                </label>
                <label class="export__cat">
                  <input
                    type="checkbox"
                    [checked]="sel()[name].environment"
                    [disabled]="!sel()[name].included"
                    (change)="toggleCat(name, 'environment')"
                  />
                  {{ 'dialog.export.cat_environment' | t }}
                </label>
                <label
                  class="export__cat"
                  [class.export__cat--na]="!hasEnvs(name)"
                  [title]="hasEnvs(name) ? '' : ('dialog.export.no_saved_envs' | t)"
                >
                  <input
                    type="checkbox"
                    [checked]="sel()[name].savedEnvs"
                    [disabled]="!sel()[name].included || !hasEnvs(name)"
                    (change)="toggleCat(name, 'savedEnvs')"
                  />
                  {{ 'dialog.export.cat_saved_envs' | t }}
                </label>
              </div>
            </div>
          }
        </div>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" size="lg" (clicked)="closeSelf(null)">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button
          variant="success"
          size="lg"
          [disabled]="!canExport()"
          (clicked)="confirm()"
        >
          <ui-icon name="upload" [size]="14" />
          {{ 'dialog.export.btn_export' | t: { count: includedCount() } }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class ExportOptionsDialogComponent extends DialogBase {
  /** Window kind for opening this as a child dialog window (minify-safe). */
  static readonly dialogKind = 'export-options';

  /** The persisted profile document being exported. */
  readonly doc = input.required<ProfileDocument>();
  /** Profile name — the default export file stem. */
  readonly defaultName = input<string>('');

  private readonly pickers = inject(NativePickers);
  private readonly i18n = inject(TranslationService);

  /** Selection state, seeded from the document (all in; saved-envs if present). */
  protected readonly sel = linkedSignal<Record<string, RepoExportSelection>>(() => {
    const out: Record<string, RepoExportSelection> = {};
    for (const [name, rp] of Object.entries(this.doc().repos)) {
      out[name] = {
        included: true,
        starts: true,
        environment: true,
        savedEnvs: hasSavedEnvironments(rp),
      };
    }
    return out;
  });

  protected readonly repoNames = computed(() =>
    Object.keys(this.doc().repos).sort((a, b) => a.localeCompare(b)),
  );
  protected readonly includedCount = computed(
    () => Object.values(this.sel()).filter((s) => s.included).length,
  );
  protected readonly canExport = computed(() => this.includedCount() > 0);

  protected hasEnvs(name: string): boolean {
    return hasSavedEnvironments(this.doc().repos[name]);
  }

  protected toggleRepo(name: string): void {
    this.sel.update((s) => ({
      ...s,
      [name]: { ...s[name], included: !s[name].included },
    }));
  }

  protected toggleCat(name: string, cat: Category): void {
    this.sel.update((s) => ({
      ...s,
      [name]: { ...s[name], [cat]: !s[name][cat] },
    }));
  }

  protected setAll(included: boolean): void {
    this.sel.update((s) =>
      Object.fromEntries(
        Object.entries(s).map(([name, v]) => [name, { ...v, included }]),
      ),
    );
  }

  /** Pick a destination via the native save dialog, then resolve. */
  protected async confirm(): Promise<void> {
    if (!this.canExport()) {
      return;
    }
    const dest = await this.pickers.pickSaveFile(
      this.i18n.t('dialog.profile.export_dialog_title'),
      `${this.defaultName()}.json`,
      JSON_FILTER,
    );
    if (dest === null) {
      return; // cancelled the save dialog — keep the options open
    }
    this.closeSelf({
      doc: filterProfileDocument(this.doc(), this.sel()),
      dest,
    });
  }
}
