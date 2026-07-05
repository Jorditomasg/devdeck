/**
 * Repo card container — wires the stores/actions to the presentational
 * `app-card-header` + `app-card-expand` + `app-card-log` (inventory-gui.md
 * §6-§12). Owns ALL i18n (children receive translated text), all side
 * effects (RepoActionsService / DialogService / OpenerService) and the
 * per-card UI state in `WorkspaceStore`.
 *
 * Performance contracts preserved:
 * - **Lazy expand panel** (§7): the expand/log subtree is NOT rendered until
 *   the first expand (`built` flag) — the v1 `_expand_panel_built` semantics.
 *   First expand triggers branch-list load, saved-env names load and the
 *   compose-services prefetch (§7 "+600 ms docker prefetch" collapses into
 *   the same tick — Rust owns the polling now).
 * - **Status flash** (§8): `flashTick` increments once per received log
 *   batch reference change; `ui-status-dot` owns the 3 s timer and the
 *   running/starting guard.
 * - **Profile dirty debounce** (§26/§28): every profile-relevant mutation
 *   goes through `WorkspaceStore` setters, which collapse bursts into ONE
 *   300 ms-debounced comparison. Never compare directly from card code.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  signal,
  untracked,
} from '@angular/core';

import { TranslationService } from '../../../core/i18n/translation.service';
import { ContextMenuService, type MenuEntry } from '../../../ui';
import { IpcCommands } from '../../../core/ipc/commands';
import type { RepoInfo, ServiceStatus } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ServicesStore, type LogLine } from '../../../core/state/services.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { DialogService } from '../../dialogs/dialog.service';
import { OpenerService } from '../opener.service';
import { RepoActionsService, isDockerRepo } from '../state/repo-actions.service';
import { WorkspaceStore } from '../state/workspace.store';
import { composeDisplayName } from '../workspace-logic';
import { CardExpandComponent, type CardExpandText, type CardExpandVm } from './card-expand.component';
import { CardHeaderComponent, type CardHeaderText } from './card-header.component';
import { CardLogComponent, type CardLogText } from './card-log.component';
import {
  composeCountsLabel,
  configAffordances,
  dangerEnvActive,
  dockerButtonState,
  dockerCardStatus,
  effectiveCommand,
  firstConfigValue,
  headerHint,
  repoTypeLabel,
  serviceUrl,
  terminalMenuEntries,
} from './card-logic';
import { dotStatusFor, visibilityForStatus } from './card-visibility';

/** `[stream]`-prefix raw lines, v1 card-log style (§8). git/docker bake
 * their own `[git]`/`[merge]`/`[docker]`/`[db]` prefix, so skip the stream
 * prefix when the line already carries one (avoids `[git] [git] …`). */
export function formatCardLine(entry: LogLine): string {
  return entry.stream === 'service' || entry.line.startsWith('[')
    ? entry.line
    : `[${entry.stream}] ${entry.line}`;
}

@Component({
  selector: 'app-repo-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CardExpandComponent, CardHeaderComponent, CardLogComponent],
  styleUrl: './repo-card.component.scss',
  host: {
    // §accent: deselected repos recede so the marked set stands out — but a
    // running repo stays accented even when unmarked (CSS-only).
    '[class.card--dimmed]': '!state().selected && status() !== "running"',
  },
  template: `
    <app-card-header
      [name]="repo().name"
      [typeLabel]="typeLabel()"
      [typeColor]="typeColor()"
      [selected]="state().selected"
      [expanded]="state().expanded"
      [dot]="dot()"
      [statusText]="statusText()"
      [flashTick]="flashTick()"
      [port]="port()"
      [behind]="behind()"
      [changes]="changes()"
      [conflicts]="conflicts()"
      [danger]="danger()"
      [depsWarning]="depsWarning()"
      [hint]="hint()"
      [vis]="vis()"
      [text]="headerText()"
      (selectedChange)="onSelectedChange($event)"
      (toggleExpand)="onToggleExpand()"
      (start)="onStart()"
      (stop)="onStop()"
      (restart)="onRestart()"
      (openExplorer)="onOpenExplorer()"
      (openTerminal)="onOpenTerminal($event)"
      (menuRequested)="onHeaderMenu($event)"
      (pullClicked)="onPull()"
      (changesClicked)="onShowChanges()"
      (conflictsClicked)="onShowConflicts()"
    />

    <!-- Lazy subtree: only exists after the first expand (§7) -->
    @if (built()) {
      <div class="card__panel" [class.card__panel--open]="state().expanded">
        <div class="card__panel-inner">
          <app-card-expand
            [vm]="expandVm()"
            [text]="expandText()"
            (branchSelected)="onBranchSelected($event)"
            (reload)="onReload()"
            (branchInProfileChange)="onBranchInProfile($event)"
            (pull)="onPull()"
            (merge)="onMerge()"
            (clean)="onClean()"
            (stash)="onStash()"
            (branches)="onBranches()"
            (history)="onHistory()"
            (openConfig)="onOpenConfig()"
            (install)="onInstall()"
            (configSelected)="onConfigSelected($event)"
            (openConfigManager)="onOpenConfigManager($event)"
            (moduleTrackedChange)="onModuleTracked($event)"
            (javaSelected)="onJavaSelected($event)"
            (commandProfileSelected)="onCommandProfileSelected($event)"
            (openCommandProfileManager)="onOpenCommandProfileManager()"
            (dockerFileClicked)="onDockerFile($event)"
          />
          <app-card-log
            [lines]="logLines()"
            [startIndex]="logStartIndex()"
            [url]="url()"
            [text]="logText()"
            (clearClicked)="onClearLog()"
            (copyClicked)="onCopyLog()"
            (detachToggle)="onDetachLog()"
            (urlClicked)="onOpenUrl()"
          />
        </div>
      </div>
    }
  `,
})
export class RepoCardComponent {
  readonly repo = input.required<RepoInfo>();

  /** Lazy-expand flag (v1 `_expand_panel_built`, §7). Never resets. */
  protected readonly built = signal(false);
  /** In-page log enlarge toggle (§8 detach re-scope). */
  /** Detach = real OS window via `open_log_window` (v1 parity, §8). */
  protected onDetachLog(): void {
    void this.commands
      .openLogWindow(this.repo().name, `${this.repo().name} — ${this.i18n.t('label.log_section')}`)
      .catch((err: unknown) => console.error('open log window failed', err));
  }
  /** Increments per log batch — drives the §8 orange dot flash. */
  protected readonly flashTick = signal(0);
  /**
   * Saved-environment names per module key — derived LIVE from the persisted
   * config (any window). Deleting/renaming a saved env in the manager window
   * emits `config://changed`, so the combo options update without a reload.
   */
  private readonly envOptions = computed<Readonly<Record<string, readonly string[]>>>(() => {
    const repo = this.repo();
    const byModule = this.settings.config()?.repo_configs?.[repo.name] ?? {};
    const out: Record<string, readonly string[]> = {};
    for (const module of repo.modules) {
      out[module.key] = Object.keys(byModule[module.key] ?? {}).sort((a, b) => a.localeCompare(b));
    }
    return out;
  });
  /** Saved command profiles, name → command (loaded on first expand, §7). */
  private readonly commandProfiles = signal<Readonly<Record<string, string>>>({});
  /** Branch combo display value — writable so a failed checkout can revert. */
  protected readonly branchDisplay = signal('');
  /**
   * Install state from `is_installed` (§6/§7): `null` = not checked yet (or
   * no `check_dirs` heuristic for this repo type) — treated as installed.
   */
  private readonly depsInstalled = signal<boolean | null>(null);

  private lastLogRef: readonly LogLine[] | null = null;
  private lastStatus: ServiceStatus | null = null;
  private depsQueried = false;
  private cmdProfilesLoaded = false;

  // -- reactive state ----------------------------------------------------------

  protected readonly state = computed(() => this.ws.cardSignal(this.repo().name)());

  private readonly runtime = computed(() => this.services.services()[this.repo().name]);

  private readonly badge = computed(() => this.repos.badges()[this.repo().name]);

  private readonly dockerRunningCount = computed(() => {
    const status = this.ws.dockerStatus()[this.repo().name] ?? {};
    return Object.values(status).filter((s) => s === 'running').length;
  });

  protected readonly status = computed<ServiceStatus>(() => {
    if (isDockerRepo(this.repo())) {
      return dockerCardStatus(this.dockerRunningCount());
    }
    return this.runtime()?.status ?? 'stopped';
  });

  protected readonly dot = computed(() => dotStatusFor(this.status()));
  protected readonly vis = computed(() => visibilityForStatus(this.status()));

  protected readonly port = computed<number | null>(
    () => this.runtime()?.port ?? this.repo().serverPort ?? null,
  );

  protected readonly behind = computed(() => this.badge()?.behind ?? 0);
  protected readonly changes = computed(() => this.badge()?.unstaged ?? 0);
  protected readonly conflicts = computed(() => this.badge()?.conflicts ?? 0);

  protected readonly danger = computed(() =>
    dangerEnvActive(this.state().configValues, this.repo().dangerFlags),
  );

  /** §6 deps badge: only a CONFIRMED missing install warns (`null` = ok). */
  protected readonly depsWarning = computed(() => this.depsInstalled() === false);

  /** Per-service head-trim count → stable log-viewer track keys (§8/§28). */
  protected readonly logStartIndex = computed(() =>
    this.services.droppedFor(this.repo().name)(),
  );

  protected readonly typeLabel = computed(() => repoTypeLabel(this.repo().repoType));
  protected readonly typeColor = computed(
    () => this.repo().uiConfig.color ?? 'var(--color-section)',
  );

  /** Current branch: card state first, badge events as fallback (§9). */
  private readonly branch = computed(
    () => this.state().branch || this.badge()?.branch || '',
  );

  protected readonly hint = computed(() => {
    const repo = this.repo();
    const state = this.state();
    return headerHint(
      this.branch(),
      firstConfigValue(state.configValues, repo.modules.map((m) => m.key)),
      effectiveCommand(
        this.commandProfiles(),
        state.selectedCommandProfile,
        repo.runCommand,
      ),
    );
  });

  protected readonly statusText = computed(() => {
    const status = this.status();
    if (status === 'running') {
      if (isDockerRepo(this.repo())) {
        return this.i18n.t('docker.status_running_count', {
          count: this.dockerRunningCount(),
        });
      }
      const port = this.port();
      return port
        ? this.i18n.t('label.status.running_port', { port })
        : this.i18n.t('label.status.running');
    }
    return this.i18n.t(`label.status.${status}`);
  });

  protected readonly url = computed(() =>
    this.status() === 'running' && !isDockerRepo(this.repo())
      ? serviceUrl(this.port() ?? undefined, this.repo().contextPath)
      : null,
  );

  private readonly rawLogs = computed(() =>
    this.services.logsFor(this.repo().name)(),
  );

  protected readonly logLines = computed(() => this.rawLogs().map(formatCardLine));

  // -- translated text blocks ----------------------------------------------------

  protected readonly headerText = computed<CardHeaderText>(() => ({
    startTip: this.i18n.t('tooltip.start_btn'),
    stopTip: this.i18n.t('tooltip.stop_btn'),
    restartTip: this.i18n.t('tooltip.restart_btn'),
    openExplorerTip: this.i18n.t('tooltip.open_explorer'),
    openTerminalTip: this.i18n.t('tooltip.open_terminal'),
    expandTip: this.i18n.t('tooltip.expand'),
    openRepoTip: this.i18n.t('tooltip.open_repo'),
    pullTip: this.i18n.t('tooltip.pending_pulls'),
    changesTip: this.i18n.t('tooltip.modified_files'),
    conflictsTip: this.i18n.t('tooltip.conflict_files'),
    dangerTip: this.i18n.t('tooltip.danger_env_badge'),
    dangerLabel: this.i18n.t('badge.danger_env'),
    depsWarnLabel: this.i18n.t('install.status_deps_missing'),
    depsWarnTip: '',
  }));

  protected readonly expandText = computed<CardExpandText>(() => ({
    branchLabel: this.i18n.t('label.branch'),
    reloadTip: this.i18n.t('tooltip.reload_repo'),
    branchInProfileTip: this.i18n.t('tooltip.branch_in_profile'),
    envInProfileTip: this.i18n.t('tooltip.env_in_profile'),
    pullTip: this.i18n.t('tooltip.pull_btn'),
    mergeText: this.i18n.t('btn.merge'),
    mergeTip: this.i18n.t('tooltip.merge_btn'),
    cleanText: this.i18n.t('btn.clean'),
    cleanTip: this.i18n.t('tooltip.clean_btn'),
    stashText: this.i18n.t('btn.stash'),
    stashTip: this.i18n.t('tooltip.stash_btn'),
    branchesText: this.i18n.t('btn.branches'),
    branchesTip: this.i18n.t('tooltip.branches_btn'),
    historyText: this.i18n.t('btn.git_history'),
    historyTip: this.i18n.t('tooltip.git_history_btn'),
    configText: this.i18n.t('btn.config'),
    configTip: this.i18n.t('tooltip.config_btn'),
    javaLabel: this.i18n.t('label.java'),
    profileLabel: this.i18n.t('label.command_profile'),
    manageProfilesTip: this.i18n.t('tooltip.manage_command_profiles'),
    searchPlaceholder: this.i18n.t('placeholder.search'),
    noResultsText: this.i18n.t('placeholder.no_results'),
  }));

  protected readonly logText = computed<CardLogText>(() => ({
    title: this.i18n.t('label.log_section'),
    clearText: this.i18n.t('btn.clear_log'),
    copyText: this.i18n.t('btn.copy_log'),
    copyTip: this.i18n.t('tooltip.copy_log'),
    detachText: this.i18n.t('btn.detach_log'),
    urlTip: this.i18n.t('tooltip.open_port'),
    emptyText: this.i18n.t('label.log_empty'),
  }));

  // -- expand panel view model (§7) ----------------------------------------------

  protected readonly expandVm = computed<CardExpandVm>(() => {
    const repo = this.repo();
    const state = this.state();
    const installing = this.status() === 'installing';
    const behind = this.behind();
    const noSelection = this.i18n.t('label.no_selection');
    const javaDefault = this.i18n.t('label.java_default');
    const { hasEnvRows, showConfigBtn, showCmdRow } = configAffordances(
      repo.configEditable,
      repo.environmentFiles.length,
    );

    return {
      branch: {
        options: state.branchesLoaded
          ? state.branches
          : [this.i18n.t('label.loading')],
        recentCount: state.branchesLoaded ? state.recentCount : 0,
        value: this.branchDisplay(),
        loaded: state.branchesLoaded,
        inProfile: state.branchInProfile,
        pullText:
          behind > 0
            ? `${this.i18n.t('btn.pull')} (${behind})`
            : this.i18n.t('btn.pull'),
        pullActive: behind > 0,
        pullBusy: this.pulling(),
        showConfigBtn,
        showInstallBtn: !!repo.runInstallCmd,
        // §7: "Install" while deps are missing, "Reinstall ✓" once installed
        // (unknown/unchecked counts as installed — empty check_dirs contract).
        installText: installing
          ? this.i18n.t('install.in_progress')
          : this.depsInstalled() === false
            ? this.i18n.t('install.label_missing')
            : this.i18n.t('install.label_ok'),
        installEnabled: this.vis().installEnabled,
        installTip: repo.runInstallCmd ?? '',
      },
      modules: hasEnvRows
        ? repo.modules.map((module) => {
            const value = state.configValues[module.key] ?? '';
            return {
              key: module.key,
              label: `${repo.uiConfig.selectors[0]?.label ?? 'App'}:`,
              dirLabel: repo.modules.length > 1 ? module.key : '',
              options: [noSelection, ...(this.envOptions()[module.key] ?? [])],
              value: value || noSelection,
              tracked: state.trackedModules[module.key] !== false,
              danger: value !== '' && repo.dangerFlags.includes(value),
              managerTip: this.i18n.t('tooltip.modify_config', {
                name: module.key,
              }),
            };
          })
        : [],
      java: repo.features.includes('java_version')
        ? {
            options: [
              javaDefault,
              ...Object.keys(this.settings.javaVersions()).sort((a, b) =>
                a.localeCompare(b),
              ),
            ],
            value: state.javaLabel || javaDefault,
            recommended:
              repo.javaVersion && !state.javaLabel
                ? this.i18n.t('label.java_recommended', {
                    version: repo.javaVersion,
                  })
                : '',
          }
        : null,
      commandProfile: showCmdRow
        ? {
            options: [
              noSelection,
              ...Object.keys(this.commandProfiles()).sort((a, b) => a.localeCompare(b)),
            ],
            value: state.selectedCommandProfile || noSelection,
          }
        : null,
      docker: repo.features.includes('docker_checkboxes')
        ? repo.dockerComposeFiles
            .filter((file) => composeDisplayName(file) !== 'all')
            .map((file) => {
              const counts = this.ws.composeCounts(repo.name, file);
              const active = this.isComposeActive(file);
              return {
                file,
                name: composeDisplayName(file),
                counts: composeCountsLabel(counts),
                state: dockerButtonState(counts?.running ?? null, active),
                tip: this.i18n.t(
                  active ? 'tooltip.docker_manage_active' : 'tooltip.docker_manage',
                ),
              };
            })
        : [],
    };
  });

  constructor(
    private readonly ws: WorkspaceStore,
    private readonly repos: ReposStore,
    private readonly services: ServicesStore,
    private readonly settings: SettingsStore,
    private readonly actions: RepoActionsService,
    private readonly dialogs: DialogService,
    private readonly opener: OpenerService,
    private readonly commands: IpcCommands,
    private readonly i18n: TranslationService,
    private readonly menu: ContextMenuService,
  ) {
    // Lazy build: render the subtree the first time the card expands —
    // including a persisted-expanded restore at startup (§4, §7).
    effect(() => {
      if (this.state().expanded && !this.built()) {
        this.built.set(true);
        untracked(() => void this.onFirstExpand());
      }
    });

    // §6 hint: a persisted command-profile selection must resolve to its
    // command even while the card stays collapsed (profiles normally load
    // lazily on first expand).
    effect(() => {
      if (this.state().selectedCommandProfile && !this.cmdProfilesLoaded) {
        untracked(() => void this.loadCommandProfiles());
      }
    });

    // §8 flash: one tick per appended log batch (array reference changes on
    // every append; the dot ignores ticks unless running/starting).
    effect(() => {
      const lines = this.rawLogs();
      if (lines.length > 0 && lines !== this.lastLogRef) {
        this.lastLogRef = lines;
        untracked(() => this.flashTick.update((t) => t + 1));
      }
    });

    // Keep the branch combo display in sync with the card state (programmatic
    // [value] writes never re-emit — ui-searchable-select contract).
    effect(() => {
      const branch = this.branch();
      untracked(() => this.branchDisplay.set(branch));
    });

    // §6/§7 deps state: query `is_installed` once on card create (repos with
    // a non-empty `ui.install_check_dirs` only) and re-query whenever an
    // install finishes (status leaves 'installing').
    effect(() => {
      this.repo(); // also re-arm if the repo input is ever replaced
      const status = this.status();
      const wasInstalling = this.lastStatus === 'installing';
      this.lastStatus = status;
      if (!this.depsQueried || (wasInstalling && status !== 'installing')) {
        this.depsQueried = true;
        untracked(() => void this.refreshDepsState());
      }
    });

    // Env selection lives in the persisted config (any window). If a saved env
    // that was applied gets deleted/renamed in the manager window, drop the
    // now-dangling selection live — no need to close the manager first.
    effect(() => {
      if (!this.settings.config()) {
        return;
      }
      const options = this.envOptions();
      const values = this.state().configValues;
      const repo = this.repo();
      untracked(() => {
        for (const module of repo.modules) {
          const selected = values[module.key];
          if (selected && !options[module.key]?.includes(selected)) {
            void this.actions.applyConfigSelection(repo, module.key, '');
          }
        }
      });
    });
  }

  // -- header handlers (§6, §12) ---------------------------------------------------

  protected onSelectedChange(selected: boolean): void {
    this.ws.patchCard(this.repo().name, { selected });
    void this.persistRepoState();
  }

  protected onToggleExpand(): void {
    if (this.ws.reorderMode()) {
      return; // reorder mode keeps the list collapsed for dragging
    }
    const expanded = !this.state().expanded;
    this.ws.patchCard(this.repo().name, { expanded }, { silent: true });
    void this.persistRepoState();
  }

  protected onStart(): void {
    void this.actions.start(this.repo());
  }

  protected onStop(): void {
    void this.actions.stop(this.repo());
  }

  protected onRestart(): void {
    void this.actions.restart(this.repo());
  }

  protected onOpenExplorer(): void {
    void this.opener.openPath(this.repo().path);
  }

  /** Terminal button (design doc 2026-07-05): menu with a clean shell plus
   * the repo's start commands, each opening a fire & forget PTY terminal. */
  protected async onOpenTerminal(event: MouseEvent): Promise<void> {
    if (!this.cmdProfilesLoaded) {
      await this.loadCommandProfiles();
    }
    const entries = terminalMenuEntries(this.commandProfiles(), {
      shell: this.i18n.t('label.terminal'),
      add: this.i18n.t('menu.add_command'),
    });
    const picked = await this.menu.openFromEvent(event, entries);
    if (picked === 'shell') {
      this.openTerminalWindow();
    } else if (picked === 'add') {
      await this.onOpenCommandProfileManager();
    } else if (picked?.startsWith('profile:')) {
      const name = picked.slice('profile:'.length);
      const cmd = this.commandProfiles()[name];
      if (cmd) {
        this.openTerminalWindow(cmd, name);
      }
    }
  }

  /** Open the detached PTY window rooted at the repo; a non-empty `command`
   * is typed-ahead into the shell (fire & forget — no supervision). */
  private openTerminalWindow(command?: string, titleLabel?: string): void {
    void this.commands.terminal
      .openWindow(
        this.repo().name,
        this.repo().path,
        `${this.repo().name} — ${titleLabel ?? this.i18n.t('label.terminal')}`,
        command,
      )
      .catch((err: unknown) => console.error('open terminal window failed', err));
  }

  protected onOpenRemote(): void {
    const url = this.repo().gitRemoteUrl;
    if (url) {
      void this.opener.openUrl(url);
    }
  }

  /** Right-click on the header — full repo actions menu (v2 of the v1
   * Button-3 → open-remote shortcut; the remote is now one entry of many). */
  protected async onHeaderMenu(event: MouseEvent): Promise<void> {
    const t = (key: string): string => this.i18n.t(key);
    const vis = this.vis();
    const behind = this.behind();
    const items: MenuEntry[] = [
      ...(vis.showStart
        ? [{ id: 'start', label: t('btn.start'), icon: 'play', disabled: !vis.startEnabled } as const]
        : []),
      ...(vis.showStop
        ? [{ id: 'stop', label: t('btn.stop'), icon: 'square', disabled: !vis.stopEnabled } as const]
        : []),
      ...(vis.showRestart
        ? [{ id: 'restart', label: t('btn.restart'), icon: 'refresh', disabled: !vis.restartEnabled } as const]
        : []),
      {
        id: 'pull',
        label: t('btn.pull'),
        icon: 'download',
        separator: true,
        hint: behind > 0 ? `↓${behind}` : undefined,
      },
      { id: 'changes', label: t('menu.view_changes'), icon: 'file-text' },
      { id: 'history', label: t('btn.git_history'), icon: 'history' },
      { id: 'branches', label: t('btn.branches'), icon: 'git-branch' },
      { id: 'stash', label: t('btn.stash'), icon: 'archive' },
      { id: 'merge', label: t('btn.merge'), icon: 'git-merge' },
      { id: 'explorer', label: t('menu.open_folder'), icon: 'folder', separator: true },
      { id: 'terminal', label: t('menu.open_terminal'), icon: 'terminal' },
      {
        id: 'remote',
        label: t('menu.open_remote'),
        icon: 'external-link',
        disabled: !this.repo().gitRemoteUrl,
      },
      { id: 'copy-path', label: t('menu.copy_path'), icon: 'copy', separator: true },
      { id: 'copy-name', label: t('menu.copy_name'), icon: 'copy' },
    ];

    const picked = await this.menu.openFromEvent(event, items);
    switch (picked) {
      case 'start': return this.onStart();
      case 'stop': return this.onStop();
      case 'restart': return this.onRestart();
      case 'pull': return this.onPull();
      case 'changes': return this.onShowChanges();
      case 'history': return this.onHistory();
      case 'branches': return this.onBranches();
      case 'stash': return this.onStash();
      case 'merge': return this.onMerge();
      case 'explorer': return this.onOpenExplorer();
      case 'terminal': return this.openTerminalWindow();
      case 'remote': return this.onOpenRemote();
      case 'copy-path':
        return void navigator.clipboard.writeText(this.repo().path).catch(() => undefined);
      case 'copy-name':
        return void navigator.clipboard.writeText(this.repo().name).catch(() => undefined);
    }
  }

  /** Pull in flight — blocks the header badge and the expand button. */
  protected readonly pulling = computed(() =>
    this.actions.pulling().has(this.repo().name),
  );

  protected onPull(): void {
    if (this.pulling()) {
      return; // header badge has no disabled state — guard here
    }
    void this.actions.pull(this.repo());
  }

  /** 📝 badge click — detached changes window (design doc 2026-07-03). */
  protected onShowChanges(): void {
    void this.commands.git
      .openWindow(this.repo().name, `${this.repo().name} — ${this.i18n.t('git.title_changes')}`, {
        tab: 'changes',
      })
      .catch((err: unknown) => console.error('open git window failed', err));
  }

  /** ⚠️ badge click — conflict summary (no per-file IPC; count only). */
  protected async onShowConflicts(): Promise<void> {
    const count = this.conflicts();
    const body =
      count > 0
        ? this.i18n.t('log.conflict_files_header', { count })
        : this.i18n.t('log.no_conflicts');
    await this.dialogs.info(this.i18n.t('dialog.conflicts.title'), body);
  }

  // -- expand panel handlers (§7, §9-§12) --------------------------------------------

  protected async onBranchSelected(branch: string): Promise<void> {
    // Deterministic two-step revert (no timers). Step 1, synchronously at
    // selection time: mirror the user pick into `branchDisplay` so the
    // display signal matches what the select already shows internally — a
    // programmatic [value] write never re-emits (ui-searchable-select
    // contract), so this cannot loop.
    this.branchDisplay.set(branch);
    const switched = await this.actions.checkout(this.repo(), branch);
    if (!switched) {
      // Step 2: revert. `branchDisplay` now holds the picked branch (already
      // rendered across the await), so writing the real branch is a genuine
      // signal change and reliably propagates into the select.
      this.branchDisplay.set(this.branch());
    }
  }

  protected onReload(): void {
    void this.actions.reload(this.repo());
  }

  protected onBranchInProfile(inProfile: boolean): void {
    this.ws.patchCard(this.repo().name, { branchInProfile: inProfile });
  }

  protected onMerge(): void {
    this.dialogs.openMergeBranch(this.repo().name);
  }

  protected onClean(): void {
    void this.actions.clean(this.repo());
  }

  protected onStash(): void {
    this.dialogs.openStash(this.repo().name);
  }

  protected onBranches(): void {
    this.dialogs.openBranches(this.repo().name);
  }

  /** Detached git history window (git suite phase 1, `open_git_window`). */
  protected onHistory(): void {
    void this.commands.git
      .openWindow(this.repo().name, `${this.repo().name} — ${this.i18n.t('git.title_history')}`)
      .catch((err: unknown) => console.error('open git window failed', err));
  }

  /** Raw config editor (§7 row 1 Config button — repos without env files). */
  protected onOpenConfig(): void {
    const repo = this.repo();
    const candidates = [...repo.environmentFiles, ...repo.dockerComposeFiles];
    const file = candidates[0];
    if (file) {
      this.dialogs.openConfigEditor(repo.name, file);
    }
  }

  protected onInstall(): void {
    void this.actions.install(this.repo(), true);
  }

  protected onConfigSelected(event: { moduleKey: string; value: string }): void {
    const name =
      event.value === this.i18n.t('label.no_selection') ? '' : event.value;
    void this.actions.applyConfigSelection(this.repo(), event.moduleKey, name);
  }

  protected onOpenConfigManager(_moduleKey: string): void {
    // Combo options + stale-selection cleanup are reactive now (the envOptions
    // computed and the config-sync effect both track `config://changed`), so
    // opening the manager is fire-and-forget.
    void this.dialogs.openRepoConfigManager(this.repo().name);
  }

  protected onModuleTracked(event: { moduleKey: string; tracked: boolean }): void {
    this.ws.setModuleTracked(this.repo().name, event.moduleKey, event.tracked);
  }

  protected onJavaSelected(label: string): void {
    const value = label === this.i18n.t('label.java_default') ? '' : label;
    this.ws.patchCard(this.repo().name, { javaLabel: value });
    void this.persistRepoState();
  }

  protected onCommandProfileSelected(value: string): void {
    const name = value === this.i18n.t('label.no_selection') ? '' : value;
    this.ws.patchCard(this.repo().name, { selectedCommandProfile: name });
    void this.persistRepoState();
  }

  protected async onOpenCommandProfileManager(): Promise<void> {
    await this.dialogs.openCommandProfileManager(this.repo().name);
    // Manager closed → refresh names AND commands (it may have edited any).
    await this.loadCommandProfiles();
  }

  protected onDockerFile(file: string): void {
    // Seed the dialog checkboxes with the card's current selection for this
    // file (keyed by basename, the same key the profile stores under).
    const base = file.replace(/\\/g, '/').split('/').pop() ?? file;
    const state = this.state();
    this.dialogs.openDockerCompose(this.repo().name, file, {
      services: state.dockerServices[base] ?? [],
      active: this.isComposeActive(file),
    });
  }

  // -- log handlers (§8) ---------------------------------------------------------------

  protected onClearLog(): void {
    this.services.clearLogs(this.repo().name);
    this.lastLogRef = null;
  }

  protected onCopyLog(): void {
    void navigator.clipboard.writeText(this.logLines().join('\n')).catch(() => undefined);
  }

  protected onOpenUrl(): void {
    const url = this.url();
    if (url) {
      void this.opener.openUrl(url);
    }
  }

  // -- internals ---------------------------------------------------------------------

  /** (Re)load the saved command profiles map — hint + dropdown source. */
  private async loadCommandProfiles(): Promise<void> {
    this.cmdProfilesLoaded = true;
    const m = await this.commands.config
      .getCommandProfiles(this.repo().name)
      .catch(() => ({}) as Record<string, string>);
    this.commandProfiles.set(m);
  }

  /** First-expand loads: branches, command profiles, compose prefetch (§7). */
  private async onFirstExpand(): Promise<void> {
    const repo = this.repo();
    const tasks: Promise<unknown>[] = [];
    if (!this.ws.card(repo.name).branchesLoaded) {
      tasks.push(this.actions.loadBranches(repo));
    }
    if (!this.cmdProfilesLoaded) {
      tasks.push(this.loadCommandProfiles());
    }
    if (repo.dockerComposeFiles.length > 0) {
      tasks.push(
        this.ws.prefetchComposeServices(repo).then(() => {
          for (const file of repo.dockerComposeFiles) {
            const services = this.ws.composeServices()[file] ?? [];
            void this.commands.docker
              .refreshStatus(repo.name, file, services)
              .catch(() => undefined);
          }
        }),
      );
    }
    await Promise.all(tasks);
  }

  /** `is_installed` query (§6/§7). No-op for repos without `check_dirs`. */
  private async refreshDepsState(): Promise<void> {
    const repo = this.repo();
    const dirs = repo.uiConfig.install_check_dirs ?? [];
    if (dirs.length === 0) {
      return; // empty install_check_dirs ⇒ always "installed" (Ui contract)
    }
    const installed = await this.commands.process
      .isInstalled(repo.path, dirs)
      .catch(() => null);
    this.depsInstalled.set(installed);
  }

  private isComposeActive(file: string): boolean {
    const base = composeDisplayName(file);
    return this.state().dockerActive.some((a) => composeDisplayName(a) === base);
  }

  /** Persist the `repo_state` (§34). */
  private persistRepoState(): Promise<void> {
    return this.settings
      .setRepoState(this.repo().name, this.ws.repoStatePatch(this.repo().name))
      .catch(() => undefined);
  }
}
