/**
 * Workspace page container — the full §1 vertical layout (inventory-gui.md):
 * topbar / divider / global panel / scrollable card list / global log /
 * status bar. Owns the scan orchestration (initial + rescan + group change,
 * §4 `_build_cards` semantics) and the close protocol.
 *
 * Close protocol (ipc-contract.md §2.1): while services run, Rust prevents
 * the window close and emits `app://close-requested` (`IpcEvents.
 * onAppCloseRequested`); this page shows the confirm dialog (§17) and
 * answers with `IpcCommands.appExit({ force })`.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
} from '@angular/core';

import { TranslationService } from '../../core/i18n/translation.service';
import { IpcCommands } from '../../core/ipc/commands';
import { IpcEvents } from '../../core/ipc/events';
import type { UnlistenFn } from '../../core/ipc/tauri-bridge';
import { ProfilesStore, normalizeJavaVersion } from '../../core/state/profiles.store';
import { ReposStore } from '../../core/state/repos.store';
import { ServicesStore } from '../../core/state/services.store';
import { SettingsStore } from '../../core/state/settings.store';
import { DividerComponent, SpinnerComponent } from '../../ui';
import { DialogService } from '../dialogs/dialog.service';
import { GlobalPanelComponent } from './global-panel.component';
import { RepoCardComponent } from './repo-card/repo-card.component';
import { GlobalLogPanelComponent } from './statusbar/global-log-panel.component';
import { TopbarComponent, profileGroupArg } from './topbar.component';
import { RepoActionsService } from './state/repo-actions.service';
import { WorkspaceStore } from './state/workspace.store';

@Component({
  selector: 'workspace-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DividerComponent,
    GlobalLogPanelComponent,
    GlobalPanelComponent,
    RepoCardComponent,
    SpinnerComponent,
    TopbarComponent,
  ],
  styleUrl: './workspace-page.component.scss',
  template: `
    <app-topbar
      (groupChanged)="onGroupChanged($event)"
      (rescanRequested)="onRescan()"
    />
    <ui-divider />
    <app-global-panel />

    <!-- §4 scrollable card list. While a (re)scan runs, the stale card list
         is hidden entirely — only the spinner shows (§4 rescan semantics). -->
    <div class="page__cards">
      @if (repos.scanning()) {
        <div class="page__scanning">
          <ui-spinner size="md" [label]="i18n.t('label.scanning_status')" />
        </div>
      } @else {
        @if (repos.repos().length === 0) {
          <p class="page__empty">{{ i18n.t('label.no_repos') }}</p>
        }
        @for (repo of repos.repos(); track repo.name) {
          <app-repo-card [repo]="repo" />
        }
      }
    </div>

    <app-global-log-panel />

    <!-- §1/§4 status bar -->
    <footer class="page__statusbar">
      <span class="page__status">{{ statusText() }}</span>
      <span class="page__counts">{{ countsText() }}</span>
    </footer>
  `,
})
export class WorkspacePageComponent {
  protected readonly statusText = computed(() =>
    this.repos.scanning()
      ? this.i18n.t('label.scanning_status')
      : this.i18n.t('label.ready'),
  );

  protected readonly countsText = computed(
    () =>
      `${this.i18n.t('label.statusbar_repos', { count: this.repos.repos().length })}` +
      ` · ${this.i18n.t('label.statusbar_running', { count: this.services.runningCount() })}`,
  );

  constructor(
    protected readonly i18n: TranslationService,
    protected readonly repos: ReposStore,
    private readonly services: ServicesStore,
    private readonly settings: SettingsStore,
    private readonly profiles: ProfilesStore,
    private readonly ws: WorkspaceStore,
    private readonly actions: RepoActionsService,
    private readonly dialogs: DialogService,
    private readonly commands: IpcCommands,
    private readonly events: IpcEvents,
    destroyRef: DestroyRef,
  ) {
    let unlisten: UnlistenFn | undefined;
    void this.init().then((fn) => {
      unlisten = fn;
    });
    destroyRef.onDestroy(() => unlisten?.());
  }

  /** Topbar group change (§27): persist, rescan, reload that group's profile. */
  protected async onGroupChanged(name: string): Promise<void> {
    await this.settings.setActiveGroup(name).catch(() => undefined);
    await this.scanAndReload();
  }

  protected onRescan(): void {
    void this.scanAndReload();
  }

  // -- startup ------------------------------------------------------------------

  private async init(): Promise<UnlistenFn | undefined> {
    await this.ws.init().catch(() => undefined);
    const unlisten = await this.events
      .onAppCloseRequested(() => void this.onCloseRequested())
      .catch(() => undefined);
    await this.scanAndReload();
    return unlisten;
  }

  /** §17 confirm-close: answer `app_exit { force }` either way. */
  private async onCloseRequested(): Promise<void> {
    const confirmed = await this.dialogs.confirmClose(this.services.activeCount());
    await this.commands.appExit(confirmed).catch(() => undefined);
  }

  /**
   * The §4 scan flow: scan the active group's paths, prune dead card state,
   * restore persisted `repo_state`, then reload the group's profile list and
   * re-apply its last profile STATE-ONLY (`skipDirtyCheck`, §26 — async
   * branch loads would race a false dirty positive).
   */
  private async scanAndReload(): Promise<void> {
    const group = this.settings.activeGroup();
    const paths = group?.paths ?? [];
    if (paths.length === 0) {
      return;
    }
    try {
      const detected = await this.repos.scan(paths);
      this.ws.pruneCards(detected.map((r) => r.name));
      const states = this.settings.repoStates();
      for (const repo of detected) {
        const persisted = states[repo.name];
        if (!persisted) {
          continue;
        }
        this.ws.patchCard(
          repo.name,
          {
            selected: persisted.selected ?? true,
            customCommand: persisted.custom_command ?? '',
            javaLabel: normalizeJavaVersion(persisted.java_version) ?? '',
            expanded: persisted.expanded ?? false,
          },
          { silent: true },
        );
      }
    } catch (err: unknown) {
      console.error('workspace scan failed', err);
      return;
    }

    const groupArg = profileGroupArg(group?.name);
    await this.profiles.refresh(groupArg).catch(() => undefined);
    const last = this.settings.lastProfileForActiveGroup();
    if (last) {
      const doc = await this.profiles.load(last, groupArg).catch(() => null);
      if (doc) {
        await this.actions.applyProfile(doc, { skipDirtyCheck: true });
      }
    }
  }
}
