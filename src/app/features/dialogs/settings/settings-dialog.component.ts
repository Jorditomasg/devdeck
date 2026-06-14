/**
 * Application settings dialog — v1 `SettingsDialog` (inventory-gui §22).
 *
 * Rows (v1 §22): Language / Workspace / Behavior / Java. Save persists the
 * changed values; Cancel discards.
 *
 * Deviations from v1, all documented:
 * - **Language switches LIVE** on Save via `TranslationService.setLanguage`
 *   (v2 signal-based i18n re-renders everything) — the v1
 *   `language_restart_*` notice is obsolete and intentionally not shown.
 * - **Desktop-shortcut creation (§22 row 4) is omitted**: the IPC contract
 *   (ipc-contract.md §2) exposes no shortcut command — the v1 COM/ctypes and
 *   `.desktop` writers were Python-side. Re-add once a `create_shortcut`
 *   command lands in the contract.
 * - **Config-dir opener is omitted** for the same reason: no contract
 *   command resolves/opens `dirs::config_dir()/devdeck`, and the
 *   opener plugin alone cannot discover that path client-side.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import {
  TranslationService,
  type LanguageCode,
} from '../../../core/i18n/translation.service';
import { SettingsStore } from '../../../core/state/settings.store';
import {
  ButtonComponent,
  DialogShellComponent,
  FormRowComponent,
  SearchableSelectComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import { JavaManagerDialogComponent } from './java-manager-dialog.component';

/** Languages shipped in v2, in display order. */
const LANGUAGE_CODES: readonly LanguageCode[] = ['en', 'es'];

@Component({
  selector: 'app-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DialogShellComponent,
    FormRowComponent,
    SearchableSelectComponent,
    TPipe,
  ],
  styleUrl: './settings-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.settings.title' | t"
      width="580px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      <div class="settings">
        <!-- 1. Language (§22 row 1) -->
        <ui-form-row [label]="'dialog.settings.language_title' | t" labelWidth="155px">
          <ui-searchable-select
            class="settings__lang"
            [options]="languageNames()"
            [value]="languageName()"
            [searchPlaceholder]="'placeholder.search' | t"
            [noResultsText]="'placeholder.no_results' | t"
            (selectionChange)="onLanguagePick($event)"
          />
        </ui-form-row>
        <p class="settings__hint">{{ 'dialog.settings.language_desc' | t }}</p>
        <div class="settings__divider"></div>

        <!-- 2. Workspace (§22 row 2) -->
        <ui-form-row [label]="'dialog.settings.workspace_title' | t" labelWidth="155px">
          <ui-button variant="blue" (clicked)="openGroups()">
            {{ 'btn.manage_groups' | t }}
          </ui-button>
        </ui-form-row>
        <div class="settings__divider"></div>

        <!-- 3. Behavior (§22 row 3) -->
        <ui-form-row [label]="'dialog.settings.behavior_title' | t" labelWidth="155px">
          <label class="settings__check">
            <input
              type="checkbox"
              [checked]="minimizeToTray()"
              (change)="minimizeToTray.set(!minimizeToTray())"
            />
            {{ 'dialog.settings.minimize_to_tray' | t }}
          </label>
        </ui-form-row>
        <div class="settings__divider"></div>

        <!-- 4. Java (§22 row 5; row 4 shortcut omitted — see class JSDoc) -->
        <ui-form-row [label]="'dialog.settings.java_title' | t" labelWidth="155px">
          <div class="settings__java">
            <ui-button variant="purple" (clicked)="openJavaManager()">
              {{ 'btn.manage_java' | t }}
            </ui-button>
            <span class="settings__java-count">{{ javaCountLabel() }}</span>
          </div>
        </ui-form-row>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" size="lg" (clicked)="closeSelf()">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="success" size="lg" [loading]="saving()" (clicked)="save()">
          {{ 'btn.save_changes' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class SettingsDialogComponent extends DialogBase {
  private readonly settings = inject(SettingsStore);
  private readonly i18n = inject(TranslationService);

  /** Draft language (applied + persisted on Save). */
  protected readonly language = signal<LanguageCode>(this.i18n.language());
  /** Draft minimize-to-tray flag (persisted on Save). */
  protected readonly minimizeToTray = signal(this.settings.minimizeToTray());
  protected readonly saving = signal(false);

  /** Display names resolved through the catalog (v1 display-name list). */
  protected readonly languageNames = computed<readonly string[]>(() =>
    LANGUAGE_CODES.map((code) => this.i18n.t(`dialog.settings.language_${code}`)),
  );

  protected readonly languageName = computed(() =>
    this.i18n.t(`dialog.settings.language_${this.language()}`),
  );

  /** `java_none_configured` / `java_n_configured(count)` (§22 row 5). */
  protected readonly javaCountLabel = computed(() => {
    const count = Object.keys(this.settings.javaVersions()).length;
    return count === 0
      ? this.i18n.t('dialog.settings.java_none_configured')
      : this.i18n.t('dialog.settings.java_n_configured', { count });
  });

  /**
   * Match the picked DISPLAY NAME back to its code by index — never by
   * translated text: `languageNames()` is built positionally from
   * `LANGUAGE_CODES`, and comparing translated strings breaks as soon as two
   * languages share a display name or the catalog changes.
   */
  protected onLanguagePick(name: string): void {
    const index = this.languageNames().indexOf(name);
    const code = LANGUAGE_CODES[index];
    if (code !== undefined) {
      this.language.set(code);
    }
  }

  /** Workspace-groups shortcut — stacks the groups dialog on top (§22 row 2). */
  protected openGroups(): void {
    this.dialogs.openWorkspaceGroups();
  }

  /** Java registry manager — stacks on top; persists itself on Close (§22). */
  protected openJavaManager(): void {
    this.dialogs.open(JavaManagerDialogComponent);
  }

  protected async save(): Promise<void> {
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      if (this.language() !== this.i18n.language()) {
        // Live switch + persist (v2 — no restart notice needed, see JSDoc).
        await this.i18n.setLanguage(this.language());
      }
      if (this.minimizeToTray() !== this.settings.minimizeToTray()) {
        await this.settings.setMinimizeToTray(this.minimizeToTray());
      }
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
