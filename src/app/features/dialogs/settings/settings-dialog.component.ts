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
  type OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { getVersion } from '@tauri-apps/api/app';

import { TPipe } from '../../../core/i18n/t.pipe';
import {
  TranslationService,
  type LanguageCode,
} from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { ShellInfo } from '../../../core/ipc/tauri.types';
import { SettingsStore } from '../../../core/state/settings.store';
import {
  PALETTES,
  PATTERNS,
  type Palette,
  type Pattern,
  ThemeService,
} from '../../../core/state/theme.service';
import { UpdatesStore } from '../../../core/state/updates.store';
import {
  ButtonComponent,
  DialogShellComponent,
  FormRowComponent,
  IconComponent,
  SearchableSelectComponent,
} from '../../../ui';
import { DialogBase } from '../dialog-base';
import { ChangelogDialogComponent } from '../changelog/changelog-dialog.component';
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
    IconComponent,
    SearchableSelectComponent,
    TPipe,
  ],
  styleUrl: './settings-dialog.component.scss',
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.settings.title' | t"
      (closed)="closeSelf()"
    >
      <div class="settings">
        <!-- 1. Language (§22 row 1) -->
        <ui-form-row icon="globe" [label]="'dialog.settings.language_title' | t" labelWidth="155px">
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

        <!-- 1b. Appearance — palette + pattern (draft; applied on Save) -->
        <ui-form-row icon="palette" [label]="'dialog.settings.appearance_title' | t" labelWidth="155px">
          <div class="settings__appearance">
            <label class="settings__appearance-field">
              <span>{{ 'dialog.settings.appearance_palette' | t }}</span>
              <ui-searchable-select
                [options]="paletteNames()"
                [value]="paletteName()"
                [searchPlaceholder]="'placeholder.search' | t"
                [noResultsText]="'placeholder.no_results' | t"
                (selectionChange)="onPalettePick($event)"
              />
            </label>
            <label class="settings__appearance-field">
              <span>{{ 'dialog.settings.appearance_pattern' | t }}</span>
              <ui-searchable-select
                [options]="patternNames()"
                [value]="patternName()"
                [searchPlaceholder]="'placeholder.search' | t"
                [noResultsText]="'placeholder.no_results' | t"
                (selectionChange)="onPatternPick($event)"
              />
            </label>
          </div>
        </ui-form-row>
        <p class="settings__hint">{{ 'dialog.settings.appearance_desc' | t }}</p>
        <div class="settings__divider"></div>

        <!-- 2. Workspace (§22 row 2) -->
        <ui-form-row icon="folder" [label]="'dialog.settings.workspace_title' | t" labelWidth="155px">
          <ui-button variant="blue" (clicked)="openGroups()">
            <ui-icon name="folder" [size]="14" /> {{ 'btn.manage_groups' | t }}
          </ui-button>
        </ui-form-row>
        <div class="settings__divider"></div>

        <!-- 3. Behavior (§22 row 3) -->
        <ui-form-row icon="app-window" [label]="'dialog.settings.behavior_title' | t" labelWidth="155px">
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

        <!-- 3b. Terminal — shell for new PTY terminals -->
        <ui-form-row icon="terminal" [label]="'dialog.settings.terminal_title' | t" labelWidth="155px">
          <div class="settings__terminal">
            <label class="settings__radio">
              <input
                type="radio"
                name="shell"
                [checked]="!customMode() && terminalShellDraft() === ''"
                (change)="pickShell('')"
              />
              {{ 'dialog.settings.terminal_default' | t }}
            </label>
            @for (sh of shells(); track sh.command) {
              <label class="settings__radio">
                <input
                  type="radio"
                  name="shell"
                  [checked]="!customMode() && terminalShellDraft() === sh.command"
                  (change)="pickShell(sh.command)"
                />
                {{ sh.label }} <span class="settings__radio-cmd">{{ sh.command }}</span>
              </label>
            }
            <label class="settings__radio">
              <input
                type="radio"
                name="shell"
                [checked]="customMode()"
                (change)="enableCustom()"
              />
              {{ 'dialog.settings.terminal_custom' | t }}
            </label>
            @if (customMode()) {
              <input
                #customInput
                class="settings__custom"
                type="text"
                [value]="terminalShellDraft()"
                [placeholder]="'dialog.settings.terminal_custom_ph' | t"
                (input)="terminalShellDraft.set(customInput.value)"
              />
            }
          </div>
        </ui-form-row>
        <p class="settings__hint">{{ 'dialog.settings.terminal_desc' | t }}</p>
        <div class="settings__divider"></div>

        <!-- 4. Java (§22 row 5; row 4 shortcut omitted — see class JSDoc) -->
        <ui-form-row icon="coffee" [label]="'dialog.settings.java_title' | t" labelWidth="155px">
          <div class="settings__java">
            <ui-button variant="purple" (clicked)="openJavaManager()">
              <ui-icon name="coffee" [size]="14" /> {{ 'btn.manage_java' | t }}
            </ui-button>
            <span class="settings__java-count">{{ javaCountLabel() }}</span>
          </div>
        </ui-form-row>
        <div class="settings__divider"></div>

        <!-- 5. Updates / About -->
        <ui-form-row icon="rotate-ccw" [label]="'dialog.settings.updates_title' | t" labelWidth="155px">
          <div class="settings__updates">
            <ui-button variant="blue" [loading]="checking()" (clicked)="checkUpdates()">
              {{ 'dialog.settings.check_updates' | t }}
            </ui-button>
            <ui-button variant="neutral" (clicked)="openChangelog()">
              {{ 'dialog.settings.view_changelog' | t }}
            </ui-button>
          </div>
        </ui-form-row>
        <p class="settings__hint">
          {{ 'dialog.settings.current_version' | t: { version: version() ?? '—' } }}
        </p>
        @if (updateInfo()?.available) {
          <div class="settings__update-banner">
            <span>
              {{ 'dialog.settings.update_available' | t: { version: updateInfo()!.version ?? '' } }}
            </span>
            <ui-button variant="success" [loading]="installing()" (clicked)="installUpdate()">
              {{ 'dialog.settings.update_now' | t }}
            </ui-button>
          </div>
        }
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" size="lg" (clicked)="closeSelf()">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="success" size="lg" [loading]="saving()" (clicked)="save()">
          <ui-icon name="save" [size]="15" /> {{ 'btn.save_changes' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class SettingsDialogComponent extends DialogBase implements OnInit {
  /** Window kind for opening this as a child dialog window (minify-safe). */
  static readonly dialogKind = 'settings';

  private readonly settings = inject(SettingsStore);
  private readonly theme = inject(ThemeService);
  private readonly i18n = inject(TranslationService);
  private readonly updates = inject(UpdatesStore);
  private readonly commands = inject(IpcCommands);

  /** Manual update-check spinner. */
  protected readonly checking = signal(false);
  /** Running app version (loaded on init from the Tauri runtime). */
  protected readonly version = signal<string | null>(null);
  /** Latest update-check result (populated by startup check + manual check). */
  protected readonly updateInfo = this.updates.info;
  protected readonly installing = this.updates.installing;

  /** Shells detected on this machine (loaded on init). */
  protected readonly shells = signal<readonly ShellInfo[]>([]);
  /** Draft shell command (`''` = per-platform default). Persisted on Save. */
  protected readonly terminalShellDraft = signal(this.settings.terminalShell());
  /** True when "Custom" is picked: the draft is a free-typed command. */
  protected readonly customMode = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      this.version.set(await getVersion());
    } catch {
      this.version.set(null);
    }
    // This dialog is its own webview window with its own UpdatesStore, so the
    // main window's startup check never reaches it. Re-run it silently here so
    // the update banner (version + "Update now") shows without the user having
    // to click "Check for updates". Reactive — the banner updates when it lands.
    void this.updates.checkSilently();
    // Load detected shells, THEN decide if the saved value is a custom command
    // (non-empty and not one of the detected shells).
    const shells = await this.commands.terminal.listShells().catch(() => [] as ShellInfo[]);
    this.shells.set(shells);
    const saved = this.terminalShellDraft();
    this.customMode.set(saved !== '' && !shells.some((s) => s.command === saved));
  }

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

  // Appearance — DRAFT only; applied + persisted on Save (like the other rows).
  // Cancel discards because nothing was applied live.
  protected readonly paletteDraft = signal<Palette>(this.theme.palette());
  protected readonly patternDraft = signal<Pattern>(this.theme.pattern());

  protected readonly paletteNames = computed<readonly string[]>(() =>
    PALETTES.map((p) => this.i18n.t(`dialog.settings.palette_${p}`)),
  );
  protected readonly patternNames = computed<readonly string[]>(() =>
    PATTERNS.map((p) => this.i18n.t(`dialog.settings.pattern_${p}`)),
  );
  protected readonly paletteName = computed(() =>
    this.i18n.t(`dialog.settings.palette_${this.paletteDraft()}`),
  );
  protected readonly patternName = computed(() =>
    this.i18n.t(`dialog.settings.pattern_${this.patternDraft()}`),
  );

  /** Map picked display name back to its value by index (never by text). */
  protected onPalettePick(name: string): void {
    const value = PALETTES[this.paletteNames().indexOf(name)];
    if (value !== undefined) {
      this.paletteDraft.set(value);
    }
  }

  protected onPatternPick(name: string): void {
    const value = PATTERNS[this.patternNames().indexOf(name)];
    if (value !== undefined) {
      this.patternDraft.set(value);
    }
  }

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

  /** Pick a detected shell (or the default, `command === ''`). */
  protected pickShell(command: string): void {
    this.customMode.set(false);
    this.terminalShellDraft.set(command);
  }

  /** Switch to a free-typed custom command (keeps any current draft text). */
  protected enableCustom(): void {
    this.customMode.set(true);
  }

  /** Workspace-groups shortcut — stacks the groups dialog on top (§22 row 2). */
  protected openGroups(): void {
    this.dialogs.openWorkspaceGroups();
  }

  /** Java registry manager — stacks on top; persists itself on Close (§22). */
  protected openJavaManager(): void {
    this.dialogs.open(JavaManagerDialogComponent);
  }

  /** Manual update check; reports "up to date" when nothing newer is found. */
  protected async checkUpdates(): Promise<void> {
    if (this.checking()) {
      return;
    }
    this.checking.set(true);
    try {
      await this.updates.check();
      if (!this.updates.available()) {
        await this.dialogs.info(
          this.i18n.t('dialog.settings.updates_title'),
          this.i18n.t('dialog.settings.up_to_date'),
        );
      }
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.checking.set(false);
    }
  }

  /** Download + install the available update (the app restarts on success). */
  protected async installUpdate(): Promise<void> {
    try {
      await this.updates.install();
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    }
  }

  /** Stack the full changelog viewer on top. */
  protected openChangelog(): void {
    this.dialogs.open(ChangelogDialogComponent);
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
      const shell = this.terminalShellDraft().trim();
      if (shell !== this.settings.terminalShell()) {
        await this.settings.setTerminalShell(shell || null);
      }
      if (this.paletteDraft() !== this.theme.palette()) {
        this.theme.setPalette(this.paletteDraft());
      }
      if (this.patternDraft() !== this.theme.pattern()) {
        this.theme.setPattern(this.patternDraft());
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
