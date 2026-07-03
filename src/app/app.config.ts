import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';

import { TranslationService } from './core/i18n/translation.service';
import { IpcCommands } from './core/ipc/commands';
import { ProfilesStore } from './core/state/profiles.store';
import { ReposStore } from './core/state/repos.store';
import { ServicesStore } from './core/state/services.store';
import { SettingsStore } from './core/state/settings.store';
import { ThemeService } from './core/state/theme.service';
import { UpdatesStore } from './core/state/updates.store';
import { DIALOGS } from './features/dialogs/dialog-stack';
import { DialogService } from './features/dialogs/dialog.service';

/**
 * Application-wide providers.
 *
 * Zoneless change detection is the baseline of this app: all state lives in
 * signals (see `core/state/`), templates read signals, and zone.js is NOT
 * shipped (no polyfills entry in angular.json). Keep the provider explicit
 * even though zoneless is the framework default since v21 — it documents
 * intent and guards against accidental zone reintroduction.
 *
 * The app initializer wires the core layer (architecture-v2.md §4):
 * 1. event subscriptions FIRST (no Rust event may be missed),
 * 2. then the config mirror (`SettingsStore.init` → `get_app_config`),
 * 3. then i18n (needs the persisted language),
 * 4. finally `frontend_ready` so Rust shows the initially-hidden window
 *    after first paint (white-flash fix, architecture-v2.md §7.9).
 *
 * Each step is guarded INDIVIDUALLY (log, continue) and `frontend_ready`
 * fires from a `finally`: the window starts hidden (`tauri.conf.json`
 * `visible: false`), so skipping it would leave the app invisible forever.
 * The app must come up even when the backend misbehaves (v1 resilience
 * contract), and `ng serve` without a Tauri host must still render.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    // Alias injected by DialogBase — composition-root edge that keeps
    // dialog-base.ts out of the dialog.service ESM cycle (see DIALOGS doc).
    { provide: DIALOGS, useExisting: DialogService },
    provideAppInitializer(async () => {
      const repos = inject(ReposStore);
      const services = inject(ServicesStore);
      const profiles = inject(ProfilesStore);
      const settings = inject(SettingsStore);
      const theme = inject(ThemeService);
      const i18n = inject(TranslationService);
      const updates = inject(UpdatesStore);
      const commands = inject(IpcCommands);
      const dialogs = inject(DialogService);
      // Detached log/terminal/dialog windows and the tray panel run the same
      // SPA bootstrap; the update check + changelog are main-window-only.
      const search = new URLSearchParams(window.location.search);
      const isMainWindow =
        !search.has('log') &&
        !search.has('terminal') &&
        !search.has('dialog') &&
        !search.has('git') &&
        !search.has('panel');
      const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
        try {
          await run();
        } catch (err: unknown) {
          console.error(`bootstrap step '${name}' failed (continuing)`, err);
        }
      };
      try {
        // FIRST: apply the persisted palette/pattern before the window is shown
        // (frontend_ready, below) so there is no flash of the default theme.
        await step('theme', () => Promise.resolve(theme.init()));
        await step('event subscriptions + hydration', () =>
          Promise.all([repos.init(), services.init(), profiles.init()]),
        );
        await step('config mirror', () => settings.init());
        await step('i18n', () => i18n.init());
        if (isMainWindow) {
          // Register the progress listener now; run the check in the
          // background (checkSilently swallows offline / no-release errors) so
          // it never delays showing the window.
          await step('updates listener', () => updates.listenProgress());
          void updates.checkSilently();
        }
      } finally {
        // MUST always fire — Rust shows the hidden window only on this call.
        await commands
          .frontendReady()
          .catch((err: unknown) => console.error('frontend_ready failed', err));
      }
      if (isMainWindow) {
        // After the window is shown: if the app was just updated, pop the
        // "What's new" dialog (fire-and-forget — never blocks bootstrap).
        void commands.updates
          .whatsNewOnStartup()
          .then((version) => {
            if (version) {
              dialogs.openKind('whats-new', { version });
            }
          })
          .catch((err: unknown) => console.error('whats-new check failed', err));
      }
    }),
  ],
};
