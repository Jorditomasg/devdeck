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
import { CMD, IpcCommands } from '../../../core/ipc/commands';
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
  firstConfigValue,
  headerHint,
  repoTypeLabel,
  serviceUrl,
} from './card-logic';
import { dotStatusFor, visibilityForStatus } from './card-visibility';
import { resolveActions } from './repo-card.actions';

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
    // §accent: deselected repos dim so the marked set stands out (CSS-only).
    '[class.card--dimmed]': '!state().selected',
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
      (openTerminal)="onOpenTerminal()"
      (openRemote)="onOpenRemote()"
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
            (openConfig)="onOpenConfig()"
            (install)="onInstall()"
            (runAction)="onRunAction($event)"
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
  /** Saved-environment names per module key (loaded on first expand, §7). */
  private readonly envOptions = signal<Readonly<Record<string, readonly string[]>>>({});
  /** Saved command-profile names (loaded on first expand, §7). */
  private readonly commandProfileNames = signal<readonly string[]>([]);
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
      repo.runCommand || '',
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
        actions: resolveActions(repo.uiConfig.actions).map((a) => ({
          key: a.key,
          icon: a.icon,
          label: this.i18n.t(a.labelKey),
          command: a.command,
        })),
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
            options: [noSelection, ...this.commandProfileNames()],
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
  ) {
    // Lazy build: render the subtree the first time the card expands —
    // including a persisted-expanded restore at startup (§4, §7).
    effect(() => {
      if (this.state().expanded && !this.built()) {
        this.built.set(true);
        untracked(() => void this.onFirstExpand());
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
  }

  // -- header handlers (§6, §12) ---------------------------------------------------

  protected onSelectedChange(selected: boolean): void {
    this.ws.patchCard(this.repo().name, { selected });
    void this.persistRepoState();
  }

  protected onToggleExpand(): void {
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

  /** Open a detached interactive PTY terminal rooted at the repo path. */
  protected onOpenTerminal(): void {
    void this.commands.terminal
      .openWindow(
        this.repo().name,
        this.repo().path,
        `${this.repo().name} — ${this.i18n.t('label.terminal')}`,
      )
      .catch((err: unknown) => console.error('open terminal window failed', err));
  }

  protected onOpenRemote(): void {
    const url = this.repo().gitRemoteUrl;
    if (url) {
      void this.opener.openUrl(url);
    }
  }

  protected onPull(): void {
    void this.actions.pull(this.repo());
  }

  /** 📝 badge click — list the modified files (v1 logged them; v2 dialog, §9). */
  protected async onShowChanges(): Promise<void> {
    const files = await this.commands.git
      .localChanges(this.repo().path, [])
      .catch(() => [] as string[]);
    const body =
      files.length > 0
        ? this.i18n.t('log.modified_files_header', { count: files.length }) +
          '\n' +
          files.map((f) => `  ${f}`).join('\n')
        : this.i18n.t('log.no_changes_local');
    await this.dialogs.info(this.i18n.t('dialog.changes.title'), body);
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

  /**
   * Run a declared per-type action (resolved from `ui.actions` via the
   * repo-card action registry). Dispatches the action's IPC command with the
   * same args its dedicated flow used. Only `run_flyway_seeds` exists today;
   * the `switch` is the irreducible code that new actions extend.
   */
  protected onRunAction(command: string): void {
    switch (command) {
      case CMD.runFlywaySeeds:
        void this.actions.seed(this.repo());
        break;
      default:
        console.error('unknown repo-card action command', command);
    }
  }

  protected onConfigSelected(event: { moduleKey: string; value: string }): void {
    const name =
      event.value === this.i18n.t('label.no_selection') ? '' : event.value;
    void this.actions.applyConfigSelection(this.repo(), event.moduleKey, name);
  }

  protected onOpenConfigManager(_moduleKey: string): void {
    this.dialogs.openRepoConfigManager(this.repo().name);
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
    // Manager closed → refresh the dropdown names (it may have added/renamed/deleted).
    const m = await this.commands.config
      .getCommandProfiles(this.repo().name)
      .catch(() => ({}) as Record<string, string>);
    this.commandProfileNames.set(Object.keys(m).sort((a, b) => a.localeCompare(b)));
  }

  protected onDockerFile(file: string): void {
    this.dialogs.openDockerCompose(this.repo().name, file);
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

  /** First-expand loads: branches, saved envs, compose prefetch (§7). */
  private async onFirstExpand(): Promise<void> {
    const repo = this.repo();
    const tasks: Promise<unknown>[] = [];
    if (!this.ws.card(repo.name).branchesLoaded) {
      tasks.push(this.actions.loadBranches(repo));
    }
    for (const module of repo.modules) {
      tasks.push(
        this.actions
          .loadEnvironmentNames(repo, module.key)
          .then((names) =>
            this.envOptions.update((all) => ({ ...all, [module.key]: names })),
          )
          .catch(() => undefined),
      );
    }
    tasks.push(
      this.commands.config
        .getCommandProfiles(repo.name)
        .then((m) =>
          this.commandProfileNames.set(Object.keys(m).sort((a, b) => a.localeCompare(b))),
        )
        .catch(() => undefined),
    );
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
