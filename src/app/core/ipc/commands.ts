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
  ComposeService,
  DockerServiceState,
  GitBadge,
  MergeOutcome,
  MergeRequest,
  MigrationReport,
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
  openLogWindow: 'open_log_window',
  getLogBacklog: 'get_log_backlog',
  // detection
  scanWorkspace: 'scan_workspace',
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
  setActiveConfig: 'set_active_config',
  setDangerFlags: 'set_danger_flags',
  readConfigFile: 'read_config_file',
  writeConfigFile: 'write_config_file',
  applyEnvironment: 'apply_environment',
  migrateFromV1: 'migrate_from_v1',
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
  runFlywaySeeds: 'run_flyway_seeds',
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

  // -- detection (§2.2) -----------------------------------------------------

  readonly detection = {
    /**
     * Scan the given workspace roots (the active group's paths). Progress
     * arrives via `repo://scan-progress`; also re-targets the git/docker
     * pollers Rust-side.
     */
    scanWorkspace: (paths: readonly string[]): Promise<RepoInfo[]> =>
      this.bridge.invoke<RepoInfo[]>(CMD.scanWorkspace, { paths }),
  };

  // -- process supervision (§2.3) -------------------------------------------

  readonly process = {
    /** Fire-and-forget; lifecycle arrives via `service://status-changed`. */
    startService: (
      serviceId: ServiceId,
      opts?: { customCommand?: string; javaLabel?: string },
    ): Promise<void> =>
      this.bridge.invoke<void>(CMD.startService, { serviceId, ...opts }),

    stopService: (serviceId: ServiceId): Promise<void> =>
      this.bridge.invoke<void>(CMD.stopService, { serviceId }),

    restartService: (
      serviceId: ServiceId,
      opts?: { customCommand?: string; javaLabel?: string },
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

    /** Reflog-recency ordered; default limit 7 (inventory-backend.md §10.1). */
    branches: (repoPath: string, limit?: number): Promise<OrderedBranches> =>
      this.bridge.invoke<OrderedBranches>(CMD.gitBranches, { repoPath, limit }),

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
  };

  // -- config (§2.5) ----------------------------------------------------------

  readonly config = {
    getAppConfig: (): Promise<AppConfig> =>
      this.bridge.invoke<AppConfig>(CMD.getAppConfig),

    /** v1 language codes (`en_EN`, `es_ES`) persisted. */
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

    /** `null` drops the key (v1 `"- Sin Seleccionar -"` normalized). */
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

    /** One-shot v1 migrator; `null` = nothing to migrate. */
    migrateFromV1: (v1Root?: string): Promise<MigrationReport | null> =>
      this.bridge.invoke<MigrationReport | null>(CMD.migrateFromV1, { v1Root }),
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

    runFlywaySeeds: (infraPath: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.runFlywaySeeds, { infraPath }),
  };
}
