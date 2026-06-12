/**
 * Java versions manager — v1 `JavaVersionsManagerDialog` (inventory-gui §22):
 * scrollable `☕ name + path` list with edit/delete per row, auto-detect,
 * manual add, and a Close button that persists the registry.
 *
 * Persistence semantics: the dialog edits a DRAFT copy of `java_versions`;
 * the explicit **Close button persists** it via
 * `SettingsStore.saveJavaVersions` (contract `save_java_versions`, whole-map
 * replace). ESC/✕ discard the draft — the v1 manager only reported the map
 * through `on_done` on its Close button too.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { ButtonComponent, DialogShellComponent, IconButtonComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';
import {
  JavaEditorDialogComponent,
  type JavaVersionEntry,
} from './java-editor-dialog.component';

@Component({
  selector: 'app-java-manager-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, IconButtonComponent, TPipe],
  styleUrl: './java-manager-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'btn.manage_java' | t"
      width="560px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      <div class="java-mgr">
        @if (entries().length === 0) {
          <p class="java-mgr__empty">{{ 'dialog.settings.java_no_versions' | t }}</p>
        } @else {
          <div class="java-mgr__list">
            @for (entry of entries(); track entry.name) {
              <div class="java-mgr__row">
                <span class="java-mgr__name">☕ {{ entry.name }}</span>
                <span class="java-mgr__path" [title]="entry.path">{{ entry.path }}</span>
                <ui-icon-button
                  variant="warning"
                  size="sm"
                  [title]="'dialog.settings.java_edit_title' | t"
                  (clicked)="edit(entry)"
                  >✏</ui-icon-button
                >
                <ui-icon-button
                  variant="danger-deep"
                  size="sm"
                  [title]="'dialog.settings.java_delete_title' | t"
                  (clicked)="remove(entry.name)"
                  >🗑</ui-icon-button
                >
              </div>
            }
          </div>
        }
      </div>

      <div uiDialogFooter>
        <ui-button variant="purple" [loading]="detecting()" (clicked)="autodetect()">
          {{ 'btn.autodetect_java' | t }}
        </ui-button>
        <ui-button variant="neutral" (clicked)="add()">
          {{ 'btn.add_java' | t }}
        </ui-button>
        <ui-button variant="success" [loading]="saving()" (clicked)="saveAndClose()">
          {{ 'btn.close' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class JavaManagerDialogComponent extends DialogBase {
  private readonly settings = inject(SettingsStore);
  private readonly i18n = inject(TranslationService);

  /** Draft registry: label → JAVA_HOME (persisted on Close). */
  protected readonly draft = signal<Readonly<Record<string, string>>>({
    ...this.settings.javaVersions(),
  });
  protected readonly detecting = signal(false);
  protected readonly saving = signal(false);

  protected readonly entries = computed<readonly JavaVersionEntry[]>(() =>
    Object.entries(this.draft()).map(([name, path]) => ({ name, path })),
  );

  /** v1 auto-detect: merge new JDKs, skipping duplicate names AND paths (§22). */
  protected async autodetect(): Promise<void> {
    if (this.detecting()) {
      return;
    }
    this.detecting.set(true);
    try {
      const found = await this.settings.detectJdks();
      const current = this.draft();
      const knownPaths = new Set(Object.values(current));
      const additions = Object.entries(found).filter(
        ([name, path]) => !(name in current) && !knownPaths.has(path),
      );
      if (additions.length > 0) {
        this.draft.set({ ...current, ...Object.fromEntries(additions) });
        await this.dialogs.info(
          this.i18n.t('dialog.settings.java_detected_title'),
          this.i18n.t('dialog.settings.java_detected_msg', {
            added_count: additions.length,
          }),
        );
        return;
      }
      // None found → offer the manual add path (v1 §22).
      const manual = await this.dialogs.confirm(
        this.i18n.t('dialog.settings.java_not_found_title'),
        this.i18n.t('dialog.settings.java_not_found_msg'),
      );
      if (manual) {
        await this.add();
      }
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.detecting.set(false);
    }
  }

  protected async add(): Promise<void> {
    const entry = await this.dialogs.openForResult<JavaVersionEntry | null>(
      JavaEditorDialogComponent,
      {},
      null,
    );
    if (!entry) {
      return;
    }
    if (entry.name in this.draft()) {
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        this.i18n.t('dialog.settings.java_duplicate', { name: entry.name }),
      );
      return;
    }
    this.draft.update((d) => ({ ...d, [entry.name]: entry.path }));
  }

  protected async edit(entry: JavaVersionEntry): Promise<void> {
    const edited = await this.dialogs.openForResult<JavaVersionEntry | null>(
      JavaEditorDialogComponent,
      { initialName: entry.name, initialPath: entry.path },
      null,
    );
    if (!edited) {
      return;
    }
    if (edited.name !== entry.name && edited.name in this.draft()) {
      await this.dialogs.error(
        this.i18n.t('misc.error_title'),
        this.i18n.t('dialog.settings.java_duplicate', { name: edited.name }),
      );
      return;
    }
    this.draft.update((d) => {
      const next = { ...d };
      delete next[entry.name]; // rename moves the key
      next[edited.name] = edited.path;
      return next;
    });
  }

  protected async remove(name: string): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.settings.java_delete_title'),
      this.i18n.t('dialog.settings.java_delete_msg', { name }),
    );
    if (!confirmed) {
      return;
    }
    this.draft.update((d) => {
      const next = { ...d };
      delete next[name];
      return next;
    });
  }

  /** Persist the draft registry, then close (v1 `on_done` semantics). */
  protected async saveAndClose(): Promise<void> {
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      await this.settings.saveJavaVersions(this.draft());
      this.closeSelf();
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.saving.set(false);
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
