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
import {
  ButtonComponent,
  ContextMenuService,
  DialogShellComponent,
  FilterTableComponent,
  IconComponent,
  TableHeadDirective,
  TableRowDirective,
  type MenuEntry,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import {
  JavaEditorDialogComponent,
  type JavaVersionEntry,
} from './java-editor-dialog.component';

@Component({
  selector: 'app-java-manager-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DialogShellComponent,
    FilterTableComponent,
    IconComponent,
    TableHeadDirective,
    TableRowDirective,
    TPipe,
  ],
  styleUrl: './java-manager-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'btn.manage_java' | t"
      (closed)="closeSelf()"
    >
      <div class="java-mgr">
        <!-- Content actions live with the content; the footer only closes. -->
        <div class="java-mgr__toolbar">
          <ui-button variant="purple" size="sm" [loading]="detecting()" (clicked)="autodetect()">
            <ui-icon name="search" [size]="14" /> {{ 'btn.autodetect_java' | t }}
          </ui-button>
          <ui-button variant="neutral" size="sm" (clicked)="add()">
            <ui-icon name="plus" [size]="14" /> {{ 'btn.add_java' | t }}
          </ui-button>
        </div>

        @if (entries().length === 0) {
          <p class="java-mgr__empty">{{ 'dialog.settings.java_no_versions' | t }}</p>
        } @else {
          <ui-filter-table
            [items]="entries()"
            [searchable]="false"
            [trackBy]="entryTrack"
            [pageSize]="pageSize"
            [prevLabel]="'pagination.prev' | t"
            [nextLabel]="'pagination.next' | t"
          >
            <tr *uiTableHead>
              <th>{{ 'dialog.settings.java_col_version' | t }}</th>
              <th>{{ 'dialog.settings.java_col_path' | t }}</th>
              <th class="java-mgr__actions-head">{{ 'dialog.settings.java_col_actions' | t }}</th>
            </tr>
            <!-- Right-click offers the same actions as the buttons. -->
            <tr *uiTableRow="let entry" (contextmenu)="onRowMenu($event, entry)">
              <td>
                <span class="java-mgr__name">
                  <ui-icon name="coffee" [size]="14" /> {{ entry.name }}
                </span>
              </td>
              <td><span class="java-mgr__path" [title]="entry.path">{{ entry.path }}</span></td>
              <td>
                <div class="java-mgr__actions">
                  <ui-button variant="warning" size="sm" (clicked)="edit(entry)">
                    <ui-icon name="pencil" [size]="14" /> {{ 'btn.edit' | t }}
                  </ui-button>
                  <ui-button variant="danger-deep" size="sm" (clicked)="remove(entry.name)">
                    <ui-icon name="trash" [size]="14" /> {{ 'btn.delete' | t }}
                  </ui-button>
                </div>
              </td>
            </tr>
          </ui-filter-table>
        }
      </div>

      <div uiDialogFooter>
        <ui-button variant="success" [loading]="saving()" (clicked)="saveAndClose()">
          {{ 'btn.close' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class JavaManagerDialogComponent extends DialogBase {
  /** Window kind for opening this as a child dialog window (minify-safe). */
  static readonly dialogKind = 'java-manager';

  private readonly settings = inject(SettingsStore);
  private readonly i18n = inject(TranslationService);
  private readonly menu = inject(ContextMenuService);

  /** Draft registry: label → JAVA_HOME (persisted on Close). */
  protected readonly draft = signal<Readonly<Record<string, string>>>({
    ...this.settings.javaVersions(),
  });
  protected readonly detecting = signal(false);
  protected readonly saving = signal(false);

  protected readonly entries = computed<readonly JavaVersionEntry[]>(() =>
    Object.entries(this.draft()).map(([name, path]) => ({ name, path })),
  );

  protected readonly pageSize = 10;
  protected readonly entryTrack = (e: JavaVersionEntry): string => e.name;

  /** Right-click on a version row — same actions as the buttons. */
  protected async onRowMenu(event: MouseEvent, entry: JavaVersionEntry): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const items: MenuEntry[] = [
      { id: 'edit', label: t('btn.edit'), icon: 'pencil' },
      { id: 'remove', label: t('btn.delete'), icon: 'trash', danger: true, separator: true },
    ];
    switch (await this.menu.openFromEvent(event, items)) {
      case 'edit': return this.edit(entry);
      case 'remove': return this.remove(entry.name);
    }
  }

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
