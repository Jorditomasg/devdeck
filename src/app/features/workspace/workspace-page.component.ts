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
  effect,
  signal,
  untracked,
} from '@angular/core';

import { TranslationService } from '../../core/i18n/translation.service';
import { IpcCommands } from '../../core/ipc/commands';
import { IpcEvents } from '../../core/ipc/events';
import type { UnlistenFn } from '../../core/ipc/tauri-bridge';
import { ProfilesStore, normalizeJavaVersion } from '../../core/state/profiles.store';
import { ReposStore } from '../../core/state/repos.store';
import { ServicesStore } from '../../core/state/services.store';
import { SettingsStore } from '../../core/state/settings.store';
import { DividerComponent, IconComponent, SpinnerComponent } from '../../ui';
import { DialogService } from '../dialogs/dialog.service';
import { GlobalPanelComponent } from './global-panel.component';
import { RepoCardComponent } from './repo-card/repo-card.component';
import { GlobalLogPanelComponent } from './statusbar/global-log-panel.component';
import { TopbarComponent, profileGroupArg } from './topbar.component';
import { RepoActionsService } from './state/repo-actions.service';
import { WorkspaceStore } from './state/workspace.store';
import {
  computeOrphans,
  effectiveOrder,
  filterRepos,
  midOrder,
  orderedRepos,
  orphanGroups,
  reorder,
} from './workspace-list.logic';

@Component({
  selector: 'workspace-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DividerComponent,
    GlobalLogPanelComponent,
    GlobalPanelComponent,
    IconComponent,
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

    <!-- Orphan banner: services left running in a workspace we switched away
         from. They stay alive on purpose — this surfaces + stops them. -->
    @if (orphans().length > 0) {
      <div class="page__orphans" role="status">
        <span class="page__orphans-text">{{ orphanText() }}</span>
        <button type="button" class="page__orphans-stop" (click)="onStopOrphans()">
          {{ i18n.t('btn.stop_orphans') }}
        </button>
      </div>
    }

    <!-- Repo-list toolbar: live name search (drag-reorder pauses while filtering). -->
    <div class="page__toolbar">
      <input
        class="page__search"
        type="search"
        [placeholder]="i18n.t('placeholder.search_repos')"
        [value]="ws.repoFilter()"
        (input)="ws.setRepoFilter($any($event.target).value)"
      />
      @if (ws.repoFilter().trim()) {
        <span class="page__search-count">{{ visibleRepos().length }}</span>
      }
      <button
        type="button"
        class="page__reorder"
        [class.page__reorder--on]="reorderMode()"
        [attr.aria-pressed]="reorderMode()"
        [attr.title]="i18n.t('tooltip.reorder_mode')"
        (click)="reorderMode.set(!reorderMode())"
      >
        <ui-icon name="grip-vertical" [size]="15" />
        {{ reorderMode() ? i18n.t('btn.reorder_done') : i18n.t('btn.reorder') }}
      </button>
    </div>

    <!-- §4 scrollable card list. While a (re)scan runs, the stale card list
         is hidden entirely — only the spinner shows (§4 rescan semantics). -->
    <div class="page__cards">
      @if (repos.scanning()) {
        <div class="page__scanning">
          <ui-spinner size="md" [label]="i18n.t('label.scanning_status')" />
        </div>
      } @else {
        @if (visibleRepos().length === 0) {
          <p class="page__empty">
            {{ ws.repoFilter().trim() ? i18n.t('label.no_repos_match') : i18n.t('label.no_repos') }}
          </p>
        }
        @for (repo of visibleRepos(); track repo.name; let i = $index) {
          <div
            class="page__slot"
            [class.page__slot--dragging]="dragIndex() === i"
            [class.page__slot--drop-before]="dropIndex() === i && dragIndex() !== i && (dragIndex() ?? -1) > i"
            [class.page__slot--drop-after]="dropIndex() === i && dragIndex() !== i && (dragIndex() ?? -1) < i"
            (dragover)="onDragOver($event, i)"
            (drop)="onDrop(i)"
          >
            @if (dragEnabled()) {
              <span
                class="page__grip"
                draggable="true"
                [attr.title]="i18n.t('tooltip.drag_reorder')"
                (dragstart)="onDragStart($event, i)"
                (dragend)="onDragEnd()"
              ><ui-icon name="grip-vertical" [size]="20" /></span>
            }
            <app-repo-card class="page__slot-card" [repo]="repo" />
          </div>
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

  /** Display order: manual fractional order over the alphabetical baseline,
   *  then the live name-search filter (§4 list). */
  protected readonly visibleRepos = computed(() => {
    const ordered = orderedRepos(this.repos.repos(), (n) => this.ws.card(n).order ?? undefined);
    return filterRepos(ordered, this.ws.repoFilter());
  });

  /** Reorder mode: explicit toggle (right of the search box) — drag grips only
   *  appear while it is on, so normal use never triggers an accidental drag. */
  protected readonly reorderMode = signal(false);

  /** Drag is live only in reorder mode AND when not filtering (the list is a
   *  full set then, so fractional ordering stays consistent). */
  protected readonly dragEnabled = computed(
    () => this.reorderMode() && !this.ws.repoFilter().trim(),
  );

  /** Index of the card currently being dragged (`null` when idle). */
  protected readonly dragIndex = signal<number | null>(null);

  /** Index the drag is hovering over — drives the drop-position indicator. */
  protected readonly dropIndex = signal<number | null>(null);

  /** Services still running in a workspace we switched away from (§switch). */
  protected readonly orphans = computed(() =>
    computeOrphans(
      this.services.services(),
      this.repos.repos().map((r) => r.name),
      (repo) => this.ws.serviceGroups()[repo],
    ),
  );

  protected readonly orphanText = computed(() => {
    const list = this.orphans();
    const groups = orphanGroups(list);
    const base = this.i18n.t('label.orphans_running', { count: list.length });
    return groups.length > 0 ? `${base} (${groups.join(', ')})` : base;
  });

  /** Identity of the active environment for rescans: its name + directories.
   *  A string so unrelated config writes (e.g. repo order) keep it equal and
   *  do NOT trigger a rescan — only a switch or a directory edit does. */
  private readonly scanKey = computed(() => {
    const g = this.settings.activeGroup();
    return `${g?.name ?? ''} ${(g?.paths ?? []).join(' ')}`;
  });

  /** Skip the effect's initial run — `init()` owns the first scan (ordering). */
  private firstScanSeen = false;

  constructor(
    protected readonly i18n: TranslationService,
    protected readonly repos: ReposStore,
    private readonly services: ServicesStore,
    private readonly settings: SettingsStore,
    private readonly profiles: ProfilesStore,
    protected readonly ws: WorkspaceStore,
    private readonly actions: RepoActionsService,
    private readonly dialogs: DialogService,
    private readonly commands: IpcCommands,
    private readonly events: IpcEvents,
    destroyRef: DestroyRef,
  ) {
    // Rescan whenever the ACTIVE environment changes — either switched, or its
    // directories edited (the environments dialog runs in its own window and
    // persists via `config://changed`, which re-syncs `activeGroup` here). The
    // first run is skipped so `init()` owns the deterministic startup scan.
    effect(() => {
      this.scanKey();
      if (!this.firstScanSeen) {
        this.firstScanSeen = true;
        return;
      }
      untracked(() => void this.scanAndReload());
    });

    let unlisten: UnlistenFn | undefined;
    void this.init().then((fn) => {
      unlisten = fn;
    });
    destroyRef.onDestroy(() => unlisten?.());
  }

  /** Topbar group change (§27): persist the active environment; the scanKey
   *  effect rescans + reloads that environment's profile. */
  protected async onGroupChanged(name: string): Promise<void> {
    await this.settings.setActiveGroup(name).catch(() => undefined);
  }

  protected onRescan(): void {
    void this.scanAndReload();
  }

  // -- drag reorder (§order) ----------------------------------------------------

  /**
   * Start drag: set the ghost to the card HEADER (not the tiny grip icon, nor
   * the whole card) so an expanded card still drags as a closed one, aligned
   * under the cursor where it was grabbed.
   */
  protected onDragStart(e: DragEvent, i: number): void {
    if (!this.dragEnabled()) {
      return;
    }
    this.dragIndex.set(i);
    const header = (e.target as HTMLElement)
      .closest('.page__slot')
      ?.querySelector('app-card-header') as HTMLElement | null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i)); // some browsers need data set
      if (header) {
        const r = header.getBoundingClientRect();
        e.dataTransfer.setDragImage(
          header,
          e.clientX - r.left,
          Math.max(0, Math.min(e.clientY - r.top, r.height)),
        );
      }
    }
  }

  protected onDragOver(e: DragEvent, i: number): void {
    if (this.dragIndex() !== null) {
      e.preventDefault(); // required for (drop) to fire
      this.dropIndex.set(i);
    }
  }

  protected onDragEnd(): void {
    this.dragIndex.set(null);
    this.dropIndex.set(null);
  }

  /**
   * Drop: give the moved repo a fractional `order` BETWEEN its new neighbours'
   * effective orders, so exactly ONE `repo_state` write persists the reorder.
   * ponytail: neighbour math is O(n) per drop; fine for tens of repos.
   */
  protected onDrop(target: number): void {
    const from = this.dragIndex();
    this.dragIndex.set(null);
    this.dropIndex.set(null);
    if (from === null || from === target || !this.dragEnabled()) {
      return;
    }
    const list = this.visibleRepos();
    const moved = list[from];
    if (!moved) {
      return;
    }
    const next = reorder(list, from, target);
    const idx = next.findIndex((r) => r.name === moved.name);
    const eff = effectiveOrder(this.repos.repos(), (n) => this.ws.card(n).order ?? undefined);
    const before = idx > 0 ? eff(next[idx - 1]!.name) : undefined;
    const after = idx < next.length - 1 ? eff(next[idx + 1]!.name) : undefined;
    this.ws.setCardOrder(moved.name, midOrder(before, after));
    void this.settings
      .setRepoState(moved.name, this.ws.repoStatePatch(moved.name))
      .catch(() => undefined);
  }

  /** Stop every service still running in another workspace (orphan banner). */
  protected onStopOrphans(): void {
    for (const orphan of this.orphans()) {
      void this.services.stop(orphan.id).catch(() => undefined);
    }
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
      // Tag this group's repos so a later switch can name where an orphan
      // (a service left running here) came from.
      this.ws.tagServiceGroups(group?.name ?? '', detected.map((r) => r.name));
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
            order: persisted.order ?? null,
            selectedCommandProfile: persisted.command_profile ?? '',
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
