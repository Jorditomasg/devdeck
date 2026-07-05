/**
 * Typed wrappers — one async function per Rust command, grouped by domain.
 *
 * `CMD` is the SINGLE source for command name strings (ipc-contract.md §2);
 * no stringly-typed `invoke` calls may exist outside this folder
 * (architecture-v2.md §3.1). Every wrapper delegates to the injectable
 * `TauriBridge`, so stores/components testing against `IpcCommands` only
 * need a `FakeTauriBridge`.
 */
import { Injectable } from '@angular/core';

import { TauriBridge } from './tauri-bridge';
import type {
  AppConfig,
  ChangelogRelease,
  ComposeService,
  DockerServiceState,
  GitAuthor,
  GitBadge,
  GitCommitFileStat,
  GitChangeEntry,
  GitFileAtCommit,
  GitFileDiff,
  GitLogFilter,
  GitLogPage,
  MergeOutcome,
  MergeRequest,
  MissingRepo,
  OpOutput,
  OrderedBranches,
  ProfileApplyReport,
  ProfileDocument,
  RepoInfo,
  RepoState,
  RevertPoint,
  RevertOutcome,
  ServiceId,
  ServiceSnapshot,
  ShellInfo,
  StashEntry,
  UpdateInfo,
  WorkspaceGroup,
} from './tauri.types';

/**
 * Command name registry — mirrors docs/migration/ipc-contract.md §2 verbatim
 * (incl. the §2.1 lifecycle extensions). Keys are camelCase for ergonomic
 * access; values are the snake_case wire names registered in `lib.rs`.
 */
export const CMD = {
  // app lifecycle (incl. §2.1 extensions — names match commands/app.rs)
  frontendReady: 'frontend_ready',
  appExit: 'app_exit',
  appHideToTray: 'app_hide_to_tray',
  showMainWindow: 'show_main_window',
  requestQuit: 'request_quit',
  openLogWindow: 'open_log_window',
  getLogBacklog: 'get_log_backlog',
  // interactive terminals (design doc 2026-06-14)
  openTerminalWindow: 'open_terminal_window',
  attachTerminal: 'attach_terminal',
  terminalWrite: 'terminal_write',
  terminalResize: 'terminal_resize',
  closeTerminal: 'close_terminal',
  listShells: 'list_shells',
  setTerminalShell: 'set_terminal_shell',
  // native dialog windows (docs/migration/dialogs-as-windows.md)
  openDialogWindow: 'open_dialog_window',
  getDialogArgs: 'get_dialog_args',
  resolveDialog: 'resolve_dialog',
  // detection
  scanWorkspace: 'scan_workspace',
  listRepos: 'list_repos',
  // process
  startService: 'start_service',
  stopService: 'stop_service',
  restartService: 'restart_service',
  installDependencies: 'install_dependencies',
  listServices: 'list_services',
  stopAllServices: 'stop_all_services',
  isInstalled: 'is_installed',
  // git
  gitStatusSummary: 'git_status_summary',
  gitBranches: 'git_branches',
  gitCurrentBranch: 'git_current_branch',
  gitCheckout: 'git_checkout',
  gitPull: 'git_pull',
  gitFetch: 'git_fetch',
  gitClone: 'git_clone',
  gitClean: 'git_clean',
  gitLocalChanges: 'git_local_changes',
  gitHasBranch: 'git_has_branch',
  gitCaptureRevertPoint: 'git_capture_revert_point',
  gitMerge: 'git_merge',
  gitRevertMerge: 'git_revert_merge',
  gitRefreshBadge: 'git_refresh_badge',
  // git stash
  gitStashList: 'git_stash_list',
  gitStashPush: 'git_stash_push',
  gitStashApply: 'git_stash_apply',
  gitStashPop: 'git_stash_pop',
  gitStashDrop: 'git_stash_drop',
  // git branch management
  gitCreateBranch: 'git_create_branch',
  gitDeleteBranch: 'git_delete_branch',
  gitDeleteRemoteBranch: 'git_delete_remote_branch',
  gitRenameBranch: 'git_rename_branch',
  gitPublishBranch: 'git_publish_branch',
  // git history (git suite phase 1, design doc 2026-07-02)
  openGitWindow: 'open_git_window',
  gitLog: 'git_log',
  gitCommitFiles: 'git_commit_files',
  gitCommitFileDiff: 'git_commit_file_diff',
  gitFileAtCommit: 'git_file_at_commit',
  gitWorkingDiff: 'git_working_diff',
  gitAuthors: 'git_authors',
  gitDiffRange: 'git_diff_range',
  gitDiffRangeFile: 'git_diff_range_file',
  gitLsFiles: 'git_ls_files',
  gitCommitBody: 'git_commit_body',
  gitTags: 'git_tags',
  // git changes window (working tree, design doc 2026-07-03)
  gitChangesList: 'git_changes_list',
  gitStageFile: 'git_stage_file',
  gitUnstageFile: 'git_unstage_file',
  gitDiscardFile: 'git_discard_file',
  gitReadWorkingFile: 'git_read_working_file',
  gitWriteWorkingFile: 'git_write_working_file',
  // config
  getAppConfig: 'get_app_config',
  setLanguage: 'set_language',
  setMinimizeToTray: 'set_minimize_to_tray',
  setActiveGroup: 'set_active_group',
  setLastProfile: 'set_last_profile',
  saveWorkspaceGroups: 'save_workspace_groups',
  setRepoState: 'set_repo_state',
  getSavedEnvironments: 'get_saved_environments',
  saveSavedEnvironments: 'save_saved_environments',
  getCommandProfiles: 'get_command_profiles',
  saveCommandProfiles: 'save_command_profiles',
  setActiveConfig: 'set_active_config',
  setDangerFlags: 'set_danger_flags',
  readConfigFile: 'read_config_file',
  writeConfigFile: 'write_config_file',
  applyEnvironment: 'apply_environment',
  readActiveEnvironment: 'read_active_environment',
  // java
  detectJdks: 'detect_jdks',
  saveJavaVersions: 'save_java_versions',
  // profiles
  listProfiles: 'list_profiles',
  loadProfile: 'load_profile',
  saveProfile: 'save_profile',
  deleteProfile: 'delete_profile',
  exportProfile: 'export_profile',
  importProfile: 'import_profile',
  getMissingRepos: 'get_missing_repos',
  applyProfileEnvironments: 'apply_profile_environments',
  // docker
  dockerAvailable: 'docker_available',
  dockerComposeServices: 'docker_compose_services',
  dockerComposeUp: 'docker_compose_up',
  dockerComposeStop: 'docker_compose_stop',
  dockerComposeDown: 'docker_compose_down',
  dockerComposeStatus: 'docker_compose_status',
  dockerComposeLogs: 'docker_compose_logs',
  dockerRefreshStatus: 'docker_refresh_status',
  dockerLogStart: 'docker_log_start',
  dockerLogStop: 'docker_log_stop',
  setDockerSelection: 'set_docker_selection',
  // updates & about (§2.9)
  checkForUpdate: 'check_for_update',
  installUpdate: 'install_update',
  getChangelog: 'get_changelog',
  whatsNewOnStartup: 'whats_new_on_startup',
  disableWhatsNew: 'disable_whats_new',
} as const;

/**
 * Pseudo service id of the aggregated global log (Rust `LogCache::GLOBAL`) —
 * accepted by `openLogWindow` / `getLogBacklog`.
 */
export const GLOBAL_LOG_ID = '__global__';

/** Union of all wire command names. */
export type CommandName = (typeof CMD)[keyof typeof CMD];

@Injectable({ providedIn: 'root' })
export class IpcCommands {
  constructor(private readonly bridge: TauriBridge) {}

  // -- app lifecycle (ipc-contract.md §2.1) ---------------------------------

  /** Signal first paint so Rust shows the hidden window (fix §7.9). */
  frontendReady(): Promise<void> {
    return this.bridge.invoke<void>(CMD.frontendReady);
  }

  /**
   * Answer to `app://close-requested` (§2.1 close protocol): `force: true`
   * stops everything and exits; `false` cancels the close.
   */
  appExit(force: boolean): Promise<void> {
    return this.bridge.invoke<void>(CMD.appExit, { force });
  }

  /** Hide the main window to the tray (minimize-to-tray behavior, §2.1). */
  appHideToTray(): Promise<void> {
    return this.bridge.invoke<void>(CMD.appHideToTray);
  }

  /**
   * Restore + focus the main window and hide the tray quick-control panel —
   * the panel's "Open DevDeck" action (tray-panel design doc 2026-06-23).
   */
  showMainWindow(): Promise<void> {
    return this.bridge.invoke<void>(CMD.showMainWindow);
  }

  /**
   * Tray-panel "Close DevDeck": routes through the same confirm-running flow
   * as the tray Quit menu (restores the main window + emits
   * `app://close-requested` when services run, else exits).
   */
  requestQuit(): Promise<void> {
    return this.bridge.invoke<void>(CMD.requestQuit);
  }

  /**
   * Open (or focus) the detached log window for a service — the v1 detached
   * log Toplevel as a real OS window (§2.1 lifecycle extension). Use
   * `GLOBAL_LOG_ID` for the aggregated global log.
   */
  openLogWindow(serviceId: string, title: string): Promise<void> {
    return this.bridge.invoke<void>(CMD.openLogWindow, { serviceId, title });
  }

  /** Recent log lines for a service from the Rust-side cache (window seed). */
  getLogBacklog(serviceId: string): Promise<string[]> {
    return this.bridge.invoke<string[]>(CMD.getLogBacklog, { serviceId });
  }

  // -- native dialog windows (docs/migration/dialogs-as-windows.md) ----------

  readonly dialog = {
    /**
     * Open a non-resizable dialog window of `kind`, storing `args` for it to
     * fetch. Returns the result token; await `dialog://resolved` for it.
     * `parentLabel` parents + centers the window (sub-dialogs pass their own
     * window label).
     */
    openWindow: (
      kind: string,
      title: string,
      args: unknown,
      parentLabel?: string,
    ): Promise<string> =>
      this.bridge.invoke<string>(CMD.openDialogWindow, {
        kind,
        title,
        args,
        parentLabel: parentLabel ?? null,
      }),

    /** Fetch THIS dialog window's inputs (by token). */
    getArgs: <T>(token: string): Promise<T> =>
      this.bridge.invoke<T>(CMD.getDialogArgs, { token }),

    /**
     * Resolve a dialog window: emits `dialog://resolved { token, result }` and
     * closes the window. Pass `result: null` to cancel (opener applies its
     * fallback).
     */
    resolve: (token: string, result: unknown): Promise<void> =>
      this.bridge.invoke<void>(CMD.resolveDialog, { token, result }),
  };

  // -- detection (§2.2) -----------------------------------------------------

  readonly detection = {
    /**
     * Scan the given workspace roots (the active group's paths). Progress
     * arrives via `repo://scan-progress`; also re-targets the git/docker
     * pollers Rust-side.
     */
    scanWorkspace: (paths: readonly string[]): Promise<RepoInfo[]> =>
      this.bridge.invoke<RepoInfo[]>(CMD.scanWorkspace, { paths }),

    /**
     * The last scan result cached Rust-side (empty before the first scan).
     * Lets dialog windows hydrate their `ReposStore` (they never scan).
     */
    listRepos: (): Promise<RepoInfo[]> => this.bridge.invoke<RepoInfo[]>(CMD.listRepos),
  };

  // -- process supervision (§2.3) -------------------------------------------

  readonly process = {
    /** Fire-and-forget; lifecycle arrives via `service://status-changed`. */
    startService: (
      serviceId: ServiceId,
      opts?: { javaLabel?: string },
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.startService, { serviceId, ...opts }),

    stopService: (serviceId: ServiceId): Promise<void> =>
      this.bridge.invoke<void>(CMD.stopService, { serviceId }),

    restartService: (
      serviceId: ServiceId,
      opts?: { javaLabel?: string },
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.restartService, { serviceId, ...opts }),

    /** 600 s cap + 5 s kill grace (inventory-backend.md §17.1). */
    installDependencies: (
      serviceId: ServiceId,
      reinstall: boolean,
      javaLabel?: string,
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.installDependencies, {
        serviceId,
        reinstall,
        javaLabel,
      }),

    /** Re-hydrate after a frontend reload — services live in Rust. */
    listServices: (): Promise<ServiceSnapshot[]> =>
      this.bridge.invoke<ServiceSnapshot[]>(CMD.listServices),

    stopAllServices: (): Promise<void> =>
      this.bridge.invoke<void>(CMD.stopAllServices),

    /**
     * Dependency-install state of a repo: true when every `ui.install.
     * check_dirs` entry exists (empty list ⇒ always installed) — the §6/§7
     * deps-warning + install-button-label heuristic.
     */
    isInstalled: (path: string, checkDirs: readonly string[]): Promise<boolean> =>
      this.bridge.invoke<boolean>(CMD.isInstalled, { path, checkDirs }),
  };

  // -- git (§2.4) -------------------------------------------------------------

  readonly git = {
    statusSummary: (repoPath: string): Promise<GitBadge> =>
      this.bridge.invoke<GitBadge>(CMD.gitStatusSummary, { repoPath }),

    /**
     * Reflog-recency ordered; default limit 7 (inventory-backend.md §10.1).
     * `includeRemote` defaults to `true` (Rust side); pass `false` for a
     * local-only list (branch-management dialog).
     */
    branches: (
      repoPath: string,
      limit?: number,
      includeRemote?: boolean,
    ): Promise<OrderedBranches> =>
      this.bridge.invoke<OrderedBranches>(CMD.gitBranches, {
        repoPath,
        limit,
        includeRemote,
      }),

    currentBranch: (repoPath: string): Promise<string> =>
      this.bridge.invoke<string>(CMD.gitCurrentBranch, { repoPath }),

    checkout: (repoPath: string, branch: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitCheckout, { repoPath, branch }),

    pull: (repoPath: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitPull, { repoPath }),

    fetch: (repoPath: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitFetch, { repoPath }),

    /** Progress % arrives as `[git] …` log lines (`stream: "git"`). */
    clone: (url: string, destPath: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitClone, { url, destPath }),

    clean: (repoPath: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitClean, { repoPath }),

    localChanges: (
      repoPath: string,
      ignorePatterns: readonly string[],
    ): Promise<string[]> =>
      this.bridge.invoke<string[]>(CMD.gitLocalChanges, {
        repoPath,
        ignorePatterns,
      }),

    hasBranch: (repoPath: string, branch: string): Promise<boolean> =>
      this.bridge.invoke<boolean>(CMD.gitHasBranch, { repoPath, branch }),

    /** MUST run before `merge` (inventory-backend.md §10.5). */
    captureRevertPoint: (
      repoPath: string,
      request: MergeRequest,
    ): Promise<RevertPoint> =>
      this.bridge.invoke<RevertPoint>(CMD.gitCaptureRevertPoint, {
        repoPath,
        request,
      }),

    /** Full §10.4 pipeline; conflicts leave the tree conflicted. */
    merge: (repoPath: string, request: MergeRequest): Promise<MergeOutcome> =>
      this.bridge.invoke<MergeOutcome>(CMD.gitMerge, { repoPath, request }),

    revertMerge: (
      repoPath: string,
      revertPoint: RevertPoint,
    ): Promise<RevertOutcome> =>
      this.bridge.invoke<RevertOutcome>(CMD.gitRevertMerge, {
        repoPath,
        revertPoint,
      }),

    /** Force one badge poll; result arrives as `git://badge`. */
    refreshBadge: (repoPath: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.gitRefreshBadge, { repoPath }),

    // -- stash management --
    stashList: (repoPath: string): Promise<StashEntry[]> =>
      this.bridge.invoke<StashEntry[]>(CMD.gitStashList, { repoPath }),

    /** `message: null` omits `-m`; untracked files are included when asked. */
    stashPush: (
      repoPath: string,
      message: string | null,
      includeUntracked: boolean,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStashPush, {
        repoPath,
        message,
        includeUntracked,
      }),

    /** Applies and KEEPS the entry. */
    stashApply: (repoPath: string, index: number): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStashApply, { repoPath, index }),

    /** Applies and DROPS the entry. */
    stashPop: (repoPath: string, index: number): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStashPop, { repoPath, index }),

    stashDrop: (repoPath: string, index: number): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStashDrop, { repoPath, index }),

    // -- branch management --
    /** `base: null` branches off HEAD; `checkout` switches to the new branch. */
    createBranch: (
      repoPath: string,
      name: string,
      base: string | null,
      checkout: boolean,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitCreateBranch, {
        repoPath,
        name,
        base,
        checkout,
      }),

    /** `force` uses `-D` (skips the merged check). */
    deleteBranch: (
      repoPath: string,
      name: string,
      force: boolean,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitDeleteBranch, { repoPath, name, force }),

    deleteRemoteBranch: (repoPath: string, name: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitDeleteRemoteBranch, { repoPath, name }),

    /** `from: null` renames the current branch. */
    renameBranch: (
      repoPath: string,
      from: string | null,
      to: string,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitRenameBranch, { repoPath, from, to }),

    publishBranch: (repoPath: string, name: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitPublishBranch, { repoPath, name }),

    // -- history queries (git suite phase 1, design doc 2026-07-02) --
    /**
     * Open (or focus) the detached git window of a repo — mirrors
     * `openLogWindow` (`?git=<repoId>`, label `git-<repoId>`). `view`
     * preselects a branch filter and/or opens the stash viewer; an
     * already-open window is only focused (it does not re-navigate).
     */
    openWindow: (
      repoId: string,
      title: string,
      view?: { branch?: string; tab?: 'history' | 'stashes' | 'changes'; stash?: number },
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.openGitWindow, { repoId, title, ...view }),

    /** Every author of the repo, most commits first (author filter). */
    authors: (repoPath: string): Promise<GitAuthor[]> =>
      this.bridge.invoke<GitAuthor[]>(CMD.gitAuthors, { repoPath }),

    /** Tracked files (capped) — the path filter's autocomplete source. */
    lsFiles: (repoPath: string): Promise<string[]> =>
      this.bridge.invoke<string[]>(CMD.gitLsFiles, { repoPath }),

    /** Full commit message (`%B`), fetched on demand by the detail view. */
    commitBody: (repoPath: string, sha: string): Promise<string> =>
      this.bridge.invoke<string>(CMD.gitCommitBody, { repoPath, sha }),

    /** Repo tags, newest first (capped) — the rev filter's tag section. */
    tags: (repoPath: string): Promise<string[]> =>
      this.bridge.invoke<string[]>(CMD.gitTags, { repoPath }),

    /** Files changed between two revs (`base...target`, compare view). */
    diffRange: (
      repoPath: string,
      base: string,
      target: string,
    ): Promise<GitCommitFileStat[]> =>
      this.bridge.invoke<GitCommitFileStat[]>(CMD.gitDiffRange, {
        repoPath,
        base,
        target,
      }),

    /** One file's diff between two revs (compare view). */
    diffRangeFile: (
      repoPath: string,
      base: string,
      target: string,
      path: string,
    ): Promise<GitFileDiff> =>
      this.bridge.invoke<GitFileDiff>(CMD.gitDiffRangeFile, {
        repoPath,
        base,
        target,
        path,
      }),

    /** Paginated, git-filtered `git log` (50 commits + `hasMore`). */
    log: (repoPath: string, filter: GitLogFilter): Promise<GitLogPage> =>
      this.bridge.invoke<GitLogPage>(CMD.gitLog, { repoPath, filter }),

    /** Files touched by one commit, with add/del counts (numstat). */
    commitFiles: (repoPath: string, sha: string): Promise<GitCommitFileStat[]> =>
      this.bridge.invoke<GitCommitFileStat[]>(CMD.gitCommitFiles, { repoPath, sha }),

    /** Unified diff of ONE file in one commit (first-parent; capped). */
    commitFileDiff: (
      repoPath: string,
      sha: string,
      path: string,
    ): Promise<GitFileDiff> =>
      this.bridge.invoke<GitFileDiff>(CMD.gitCommitFileDiff, { repoPath, sha, path }),

    /** Full file text at a commit (blob size checked before reading). */
    fileAtCommit: (
      repoPath: string,
      sha: string,
      path: string,
    ): Promise<GitFileAtCommit> =>
      this.bridge.invoke<GitFileAtCommit>(CMD.gitFileAtCommit, { repoPath, sha, path }),

    /** Working-tree diff of one file (`staged` → `--cached`); stage view. */
    workingDiff: (
      repoPath: string,
      path: string,
      staged: boolean,
    ): Promise<GitFileDiff> =>
      this.bridge.invoke<GitFileDiff>(CMD.gitWorkingDiff, { repoPath, path, staged }),

    // -- changes window (working tree, design doc 2026-07-03) --

    /** Working-tree changes, both groups (`MM` yields two entries). */
    changesList: (repoPath: string): Promise<GitChangeEntry[]> =>
      this.bridge.invoke<GitChangeEntry[]>(CMD.gitChangesList, { repoPath }),

    /** `git add -- <path>` — also marks a conflicted file resolved. */
    stageFile: (repoPath: string, path: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStageFile, { repoPath, path }),

    /** `git restore --staged -- <path>`. */
    unstageFile: (repoPath: string, path: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitUnstageFile, { repoPath, path }),

    /** DESTRUCTIVE (confirm first): restore tracked / clean untracked. */
    discardFile: (
      repoPath: string,
      path: string,
      untracked: boolean,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitDiscardFile, { repoPath, path, untracked }),

    /** Working-tree file contents (same caps as `fileAtCommit`). */
    readWorkingFile: (repoPath: string, path: string): Promise<GitFileAtCommit> =>
      this.bridge.invoke<GitFileAtCommit>(CMD.gitReadWorkingFile, { repoPath, path }),

    /** Save the changes-window editor (path guarded inside the repo). */
    writeWorkingFile: (
      repoPath: string,
      path: string,
      content: string,
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.gitWriteWorkingFile, { repoPath, path, content }),
  };

  // -- config (§2.5) ----------------------------------------------------------

  readonly config = {
    getAppConfig: (): Promise<AppConfig> =>
      this.bridge.invoke<AppConfig>(CMD.getAppConfig),

    /** Language codes `en_EN` / `es_ES` persisted. */
    setLanguage: (language: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.setLanguage, { language }),

    setMinimizeToTray: (value: boolean): Promise<void> =>
      this.bridge.invoke<void>(CMD.setMinimizeToTray, { value }),

    setActiveGroup: (name: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.setActiveGroup, { name }),

    /**
     * Persist the last loaded profile of a group (`last_profile_by_group`).
     * `group: null` = Default group; `name: null` = the no-profile sentinel.
     */
    setLastProfile: (group: string | null, name: string | null): Promise<void> =>
      this.bridge.invoke<void>(CMD.setLastProfile, { group, name }),

    saveWorkspaceGroups: (groups: readonly WorkspaceGroup[]): Promise<void> =>
      this.bridge.invoke<void>(CMD.saveWorkspaceGroups, { groups }),

    setRepoState: (repo: string, state: RepoState): Promise<void> =>
      this.bridge.invoke<void>(CMD.setRepoState, { repo, state }),

    getSavedEnvironments: (
      configKey: string,
    ): Promise<Record<string, string>> =>
      this.bridge.invoke<Record<string, string>>(CMD.getSavedEnvironments, {
        configKey,
      }),

    saveSavedEnvironments: (
      configKey: string,
      environments: Readonly<Record<string, string>>,
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.saveSavedEnvironments, {
        configKey,
        environments,
      }),

    getCommandProfiles: (repo: string): Promise<Record<string, string>> =>
      this.bridge.invoke<Record<string, string>>(CMD.getCommandProfiles, { repo }),

    saveCommandProfiles: (
      repo: string,
      profiles: Readonly<Record<string, string>>,
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.saveCommandProfiles, { repo, profiles }),

    /** `null` or `""` drops the key. */
    setActiveConfig: (configKey: string, name: string | null): Promise<void> =>
      this.bridge.invoke<void>(CMD.setActiveConfig, { configKey, name }),

    setDangerFlags: (
      configKey: string,
      names: readonly string[],
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.setDangerFlags, { configKey, names }),

    readConfigFile: (path: string): Promise<string> =>
      this.bridge.invoke<string>(CMD.readConfigFile, { path }),

    writeConfigFile: (path: string, content: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.writeConfigFile, { path, content }),

    /** Routes through `config_writer_type` (inventory-config-ci.md §1.5). */
    applyEnvironment: (args: {
      writerType: string;
      targetFile: string;
      profile: string;
      content: string;
    }): Promise<void> => this.bridge.invoke<void>(CMD.applyEnvironment, args),

    /**
     * Current content of the file `applyEnvironment` writes for `profile`
     * (missing → `""`). The read-side counterpart used to detect env-file
     * drift (file no longer matches the selected saved environment).
     */
    readActiveEnvironment: (args: {
      writerType: string;
      targetFile: string;
      profile: string;
    }): Promise<string> =>
      this.bridge.invoke<string>(CMD.readActiveEnvironment, args),
  };

  // -- java (§2.6) ------------------------------------------------------------

  readonly java = {
    /** label → JAVA_HOME; never rejects (invalid candidates skipped). */
    detectJdks: (): Promise<Record<string, string>> =>
      this.bridge.invoke<Record<string, string>>(CMD.detectJdks),

    /** Whole-map replace of the `java_versions` registry. */
    saveJavaVersions: (
      versions: Readonly<Record<string, string>>,
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.saveJavaVersions, { versions }),
  };

  // -- profiles (§2.7) ----------------------------------------------------------

  readonly profiles = {
    /** `group` omitted ⇒ Default group (root profiles dir). */
    listProfiles: (group?: string): Promise<string[]> =>
      this.bridge.invoke<string[]>(CMD.listProfiles, { group }),

    /** Broken/missing files resolve `null` (v1 parity). */
    loadProfile: (
      name: string,
      group?: string,
    ): Promise<ProfileDocument | null> =>
      this.bridge.invoke<ProfileDocument | null>(CMD.loadProfile, {
        name,
        group,
      }),

    /**
     * Frontend builds the per-repo state; Rust enriches with config-file /
     * saved-env snapshots when `includeConfigFiles`. Resolves the saved path.
     */
    saveProfile: (args: {
      name: string;
      group?: string;
      doc: ProfileDocument;
      includeConfigFiles: boolean;
    }): Promise<string> => this.bridge.invoke<string>(CMD.saveProfile, args),

    deleteProfile: (name: string, group?: string): Promise<boolean> =>
      this.bridge.invoke<boolean>(CMD.deleteProfile, { name, group }),

    exportProfile: (doc: ProfileDocument, destPath: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.exportProfile, { doc, destPath }),

    /** Rejects (`kind: "profile"`) when the file has no `repos` key. */
    importProfile: (srcPath: string): Promise<ProfileDocument> =>
      this.bridge.invoke<ProfileDocument>(CMD.importProfile, { srcPath }),

    getMissingRepos: (
      workspaceDir: string,
      doc: ProfileDocument,
    ): Promise<MissingRepo[]> =>
      this.bridge.invoke<MissingRepo[]>(CMD.getMissingRepos, {
        workspaceDir,
        doc,
      }),

    /** Applies config_files + saved_environments; returns `repetidoN` renames. */
    applyProfileEnvironments: (
      doc: ProfileDocument,
      workspaceDir: string,
    ): Promise<ProfileApplyReport> =>
      this.bridge.invoke<ProfileApplyReport>(CMD.applyProfileEnvironments, {
        doc,
        workspaceDir,
      }),
  };

  // -- docker (§2.8) --------------------------------------------------------------

  readonly docker = {
    available: (): Promise<boolean> =>
      this.bridge.invoke<boolean>(CMD.dockerAvailable),

    composeServices: (composeFile: string): Promise<ComposeService[]> =>
      this.bridge.invoke<ComposeService[]>(CMD.dockerComposeServices, {
        composeFile,
      }),

    composeUp: (
      composeFile: string,
      services?: readonly string[],
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.dockerComposeUp, {
        composeFile,
        services,
      }),

    composeStop: (
      composeFile: string,
      services?: readonly string[],
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.dockerComposeStop, {
        composeFile,
        services,
      }),

    composeDown: (composeFile: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.dockerComposeDown, { composeFile }),

    composeStatus: (
      composeFile: string,
      services: readonly string[],
    ): Promise<Record<string, DockerServiceState>> =>
      this.bridge.invoke<Record<string, DockerServiceState>>(
        CMD.dockerComposeStatus,
        { composeFile, services },
      ),

    composeLogs: (
      composeFile: string,
      service: string,
      tail: number,
    ): Promise<string> =>
      this.bridge.invoke<string>(CMD.dockerComposeLogs, {
        composeFile,
        service,
        tail,
      }),

    /** Force one status poll; result arrives as `docker://status`. */
    refreshStatus: (
      repoName: string,
      composeFile: string,
      services: readonly string[],
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.dockerRefreshStatus, {
        repoName,
        composeFile,
        services,
      }),

    /**
     * Attach a viewer to a compose service's LIVE `logs -f` stream; lines then
     * flow through `service://log-line` under `serviceId` (a self-describing
     * `docker::<file>::<service>` id — also the `?log=` value + backlog key).
     * The first attach spawns the follower, later ones share it. Always pair
     * with {@link logStop} on teardown.
     */
    logStart: (serviceId: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.dockerLogStart, { serviceId }),

    /** Detach a viewer; the last detach kills the `logs -f` process. */
    logStop: (serviceId: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.dockerLogStop, { serviceId }),

    /**
     * Relay a docker service selection to the main window (Rust re-emits
     * `docker://selection`). `file` is the compose file BASENAME; `services`
     * the selected list; `active` whether the file joins the profile start.
     */
    setSelection: (
      repoName: string,
      file: string,
      services: readonly string[],
      active: boolean,
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.setDockerSelection, {
        repoName,
        file,
        services,
        active,
      }),
  };

  // -- interactive terminals (design doc 2026-06-14) ------------------------

  readonly terminal = {
    /**
     * Open a detached PTY terminal window for a repo (`cwd` = repo path).
     * Returns the new terminal id (`<repoId>::term::<n>`); the window's webview
     * then calls `attach` with that id. A non-empty `command` is typed-ahead
     * into the shell right after spawn (design doc 2026-07-05).
     */
    openWindow: (
      repoId: string,
      cwd: string,
      title: string,
      command?: string,
    ): Promise<string> =>
      this.bridge.invoke<string>(CMD.openTerminalWindow, { repoId, cwd, title, command }),

    /**
     * Bind this window's output channel: `onData` receives raw PTY bytes
     * (`ArrayBuffer`, ANSI intact) — feed straight to `xterm.write`. The
     * pre-attach backlog arrives as the first message.
     */
    attach: (id: string, onData: (bytes: Uint8Array) => void): Promise<void> => {
      const channel = this.bridge.channel<ArrayBuffer>((buffer) =>
        onData(new Uint8Array(buffer)),
      );
      return this.bridge.invoke<void>(CMD.attachTerminal, { id, channel });
    },

    /** Forward keystrokes (the string from `xterm.onData`) to the PTY. */
    write: (id: string, data: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.terminalWrite, { id, data }),

    /** Resize the PTY viewport (from the xterm fit addon). */
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      this.bridge.invoke<void>(CMD.terminalResize, { id, cols, rows }),

    /** Kill the PTY process tree and drop the session (on window close). */
    close: (id: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.closeTerminal, { id }),

    /** Shells detected on this machine, for the Settings terminal picker. */
    listShells: (): Promise<ShellInfo[]> => this.bridge.invoke<ShellInfo[]>(CMD.listShells),

    /**
     * Persist the shell command for NEW terminals (`null`/empty → per-platform
     * default). Emits `config://changed`.
     */
    setShell: (shell: string | null): Promise<void> =>
      this.bridge.invoke<void>(CMD.setTerminalShell, { shell }),
  };

  // -- updates & about (§2.9) -----------------------------------------------

  readonly updates = {
    /** Query for a newer version; `available: false` when up to date. */
    check: (): Promise<UpdateInfo> =>
      this.bridge.invoke<UpdateInfo>(CMD.checkForUpdate),

    /** Download + install the available update; progress via `update://progress`. */
    install: (): Promise<void> => this.bridge.invoke<void>(CMD.installUpdate),

    /** Full parsed changelog history, newest first. */
    changelog: (): Promise<ChangelogRelease[]> =>
      this.bridge.invoke<ChangelogRelease[]>(CMD.getChangelog),

    /**
     * Marks the running version as seen and returns it when the app was just
     * updated (so the "What's new" popup should show), else `null`.
     */
    whatsNewOnStartup: (): Promise<string | null> =>
      this.bridge.invoke<string | null>(CMD.whatsNewOnStartup),

    /** Opt out of the "What's new" popup permanently. */
    disableWhatsNew: (): Promise<void> =>
      this.bridge.invoke<void>(CMD.disableWhatsNew),
  };
}
