/**
 * TypeScript mirrors of every Rust IPC payload/domain type the UI consumes.
 *
 * Wire-format contract: docs/migration/ipc-contract.md §1.2.
 * - Rust serializes IPC payloads camelCase via `#[serde(rename_all = "camelCase")]`.
 * - Persisted v1-compatible documents (AppConfig, RepoState, ProfileDocument,
 *   RepoProfile, RevertPoint, the UiConfig YAML passthrough) keep their v1
 *   snake_case keys VERBATIM — these interfaces mirror the wire exactly, no
 *   client-side key mapping ever happens.
 *
 * Sources of truth on the Rust side:
 * - src-tauri/src/events.rs (event payloads)
 * - src-tauri/src/domain/ (RepoInfo, ServiceStatus, RepoTypeDef.ui)
 * - src-tauri/src/git/types.rs, docker/types.rs, profiles/types.rs,
 *   config/app_config.rs, process/types.rs
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Serialized command error (`Result<T, AppError>` on the Rust side).
 * A failed `invoke` rejects with this shape; `kind` maps to i18n keys
 * (architecture-v2.md §3.1, ipc-contract.md §1.3).
 */
export interface AppError {
  readonly kind: AppErrorKind;
  readonly message: string;
}

/** Stable machine-readable error kinds (extend, never rename). */
export type AppErrorKind =
  | 'configuration'
  | 'detection'
  | 'io'
  | 'yaml_parse'
  | 'json_parse'
  | 'no_os_directory'
  | 'git'
  | 'docker'
  | 'process'
  | 'profile'
  | 'invalid_args';

/** Type guard for rejected invoke payloads. */
export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

/**
 * The 6-state service lifecycle (domain/service_status.rs — canonical;
 * ipc-contract.md §1.4). v1 only ever emitted 4 of these as free strings;
 * `stopping`/`installing` are v2 additions replacing GUI-side boolean flags
 * (inventory-backend.md §3, §17.1).
 */
export type ServiceStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'installing'
  | 'error';

/** Origin of a log line batch (events.rs `LogStream`). */
export type LogStream = 'service' | 'install' | 'docker' | 'git';

/** Snapshot of one tracked service (process/types.rs `ServiceSnapshot`). */
export interface ServiceSnapshot {
  readonly id: ServiceId;
  readonly status: ServiceStatus;
  readonly port?: number;
  readonly pid?: number;
}

/**
 * Service id: `"repo"` or `"repo::module"` — the v1 config-key convention
 * (inventory-backend.md §8.3, ipc-contract.md §1.5).
 */
export type ServiceId = string;

// ---------------------------------------------------------------------------
// Event payloads (events.rs — names in events.ts `EVT`)
// ---------------------------------------------------------------------------

/** Payload of `service://status-changed` (events.rs `ServiceStatusPayload`). */
export interface ServiceStatusEvent {
  readonly name: ServiceId;
  readonly status: ServiceStatus;
  readonly exitCode?: number;
  readonly error?: string;
  readonly port?: number;
  readonly pid?: number;
}

/**
 * Payload of `service://log-line` — one ANSI-stripped batch, flushed every
 * ~75 ms or 64 lines (process/constants.rs `LOG_BATCH_*`). Per-line
 * timestamps are not tracked (v1 parity); `timestampMs` is the flush instant.
 */
export interface ServiceLogEvent {
  readonly name: ServiceId;
  readonly stream: LogStream;
  readonly lines: readonly string[];
  readonly timestampMs: number;
}

/** Payload of `repo://scan-progress`. Terminal phase is `"done"`. */
export interface ScanProgressEvent {
  readonly phase: string;
  readonly detected: number;
  readonly total: number;
}

/**
 * Payload of `git://badge` — mirrors `get_status_summary`
 * (inventory-backend.md §10.2), including v1's double-count of partially
 * staged files (§22.19, a deliberate keep).
 */
export interface GitBadgeEvent {
  readonly name: string;
  readonly branch: string;
  readonly behind: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly conflicts: number;
}

/** State of one compose service (`docker://status`; not-running ⇒ stopped). */
export type DockerServiceState = 'running' | 'stopped';

/** Payload of `docker://status` (15 s poll, inventory-gui.md §28). */
export interface DockerStatusEvent {
  readonly name: string;
  readonly services: Readonly<Record<string, DockerServiceState>>;
}

/** Payload of `app://single-instance` (architecture-v2.md §7.6). */
export interface SingleInstanceEvent {
  readonly argv: readonly string[];
  readonly cwd: string;
}

// ---------------------------------------------------------------------------
// Git command results (git/types.rs)
// ---------------------------------------------------------------------------

/**
 * `(ok, message)` result of a mutating git/docker operation — the typed v1
 * `tuple[bool, str]` contract (inventory-backend.md §10.3). Domain failures
 * resolve with `ok: false`; only infrastructure failures reject the promise.
 */
export interface OpOutput {
  readonly ok: boolean;
  readonly message: string;
}

/** On-demand badge query result (same shape as `git://badge` minus `name`). */
export interface GitBadge {
  readonly branch: string;
  readonly behind: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly conflicts: number;
}

/**
 * Branch list ordered by reflog recency (inventory-backend.md §10.1).
 * `recentCount` = index where the alphabetical section starts (UI separator).
 */
export interface OrderedBranches {
  readonly branches: readonly string[];
  readonly recentCount: number;
}

/** One `git stash list` entry (stash dialog). `index` addresses `stash@{index}`. */
export interface StashEntry {
  readonly index: number;
  readonly message: string;
  readonly branch: string;
}

/** Where a merge lands (git/types.rs `TargetMode`). */
export type MergeTargetMode = 'current' | 'existing' | 'new';

/**
 * Merge pipeline parameters (inventory-backend.md §10.4 — v1 defaults
 * applied Rust-side when keys are omitted: `sourceRemote: true`,
 * `pullTarget: true`, `push: false`, `targetMode: "current"`).
 */
export interface MergeRequest {
  readonly source: string;
  readonly sourceRemote?: boolean;
  readonly targetMode?: MergeTargetMode;
  /** Required for `targetMode: "existing"`. */
  readonly target?: string;
  /** Optional base branch for `targetMode: "new"`. */
  readonly base?: string;
  /** Required for `targetMode: "new"`. */
  readonly newBranch?: string;
  readonly pullTarget?: boolean;
  readonly push?: boolean;
  /** Globs ignored by the dirty guard (`env_pull_ignore_patterns`). */
  readonly dirtyIgnore?: readonly string[];
}

/** The five documented merge outcomes — v1 status strings (snake_case). */
export type MergeStatus =
  | 'ok'
  | 'conflict'
  | 'blocked_dirty'
  | 'error'
  | 'ok_push_failed';

/** Result of `git_merge` — mirrors the v1 result dict (§10.4). */
export interface MergeOutcome {
  readonly status: MergeStatus;
  readonly message: string;
  /** Conflicted paths when `status === 'conflict'`. */
  readonly conflicts: readonly string[];
  /** Dirty paths when `status === 'blocked_dirty'`. */
  readonly dirty: readonly string[];
}

export type RevertMode = 'current' | 'existing' | 'new';

/**
 * Pre-merge snapshot for `git_revert_merge`. v1 snake_case dict keys
 * preserved VERBATIM (inventory-backend.md §10.5; ipc-contract.md §1.2) —
 * v1-era payloads must stay readable.
 */
export interface RevertPoint {
  readonly mode: RevertMode;
  readonly original_branch: string;
  readonly dest?: string;
  readonly dest_head_before?: string;
  readonly new_branch?: string;
}

/** Result of `git_revert_merge` (`{status:'ok'}` / `{status:'error',message}`). */
export interface RevertOutcome {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Detection (domain/repo_info.rs, domain/repo_type.rs)
// ---------------------------------------------------------------------------

/** One entry of the repo-type YAML `ui.selectors` block (YAML keys). */
export interface UiSelector {
  readonly label: string;
}

/**
 * The repo-type `ui:` block as serialized by the Rust `Ui` struct
 * (domain/repo_type.rs). `Ui` carries `#[serde(default)]` but NO
 * `rename_all`, so its fields keep their Rust snake_case names on the wire
 * (`install_check_dirs`, `actions`); the enclosing `RepoInfo.ui_config`
 * becomes `uiConfig` via RepoInfo's own camelCase rename. Unknown YAML keys
 * round-trip through the struct's `#[serde(flatten)] extra` map.
 */
export interface UiConfig {
  readonly icon?: string;
  readonly color?: string;
  readonly selectors: readonly UiSelector[];
  /**
   * Directories whose presence means "installed" (e.g. `["target"]`); empty
   * ⇒ always "installed" (§6/§7 deps heuristic). Wire key is snake_case
   * because the Rust `Ui` struct has no `rename_all`.
   */
  readonly install_check_dirs: readonly string[];
  /** Declared action buttons (e.g. ["seed"]); resolved by the repo-card action registry. */
  readonly actions?: readonly string[];
  readonly [extra: string]: unknown;
}

/**
 * One "module" of a repository — env/config files in one directory; the unit
 * behind the `"repo::module"` config-key convention (inventory-config-ci.md §4.1).
 */
export interface RepoModule {
  /** Repo-relative POSIX dir, or the literal `"root"` for the repo root. */
  readonly key: string;
  /** Repo-relative POSIX dir (`""` for the repo root). */
  readonly dir: string;
  readonly envFiles: readonly string[];
  readonly profiles: readonly string[];
}

/**
 * All detected metadata for one repository (domain/repo_info.rs —
 * superset of v1 inventory-backend.md §2, incl. the §22.4 enrichment fields).
 */
export interface RepoInfo {
  readonly name: string;
  readonly path: string;
  readonly repoType: string;
  readonly profiles: readonly string[];
  readonly gitRemoteUrl?: string;
  /** NOT set by detection; git layer fills on demand (v1 field parity). */
  readonly currentBranch?: string;
  readonly runInstallCmd?: string;
  readonly runReinstallCmd?: string;
  readonly runCommand?: string;
  readonly stopCommand?: string;
  readonly environmentFiles: readonly string[];
  readonly modules: readonly RepoModule[];
  readonly envDefaultDir: string;
  readonly envConfigWriterType: string;
  readonly envPullIgnorePatterns: readonly string[];
  readonly envMainConfigFilename: string;
  readonly envPatterns: readonly string[];
  readonly uiConfig: UiConfig;
  readonly features: readonly string[];
  /** Card restart delay in ms; absent ⇒ backend default (300 ms). */
  readonly restartDelayMs?: number;
  /** Whether this repo exposes editable env/config (docker-infra: false). */
  readonly configEditable: boolean;
  readonly javaVersion?: string;
  readonly serverPort?: number;
  readonly contextPath?: string;
  readonly readyPattern?: string;
  readonly errorPattern?: string;
  readonly portPatterns: readonly string[];
  readonly dockerComposeFiles: readonly string[];
  readonly detectedFramework: string;
  /** Filled from `repo_config_danger` by the config layer before returning. */
  readonly dangerFlags: readonly string[];
}

// ---------------------------------------------------------------------------
// App config (config/app_config.rs — v1 snake_case keys VERBATIM)
// ---------------------------------------------------------------------------

/** One named workspace group. */
export interface WorkspaceGroup {
  readonly name: string;
  readonly paths: readonly string[];
}

/** Per-repo persisted UI state (`repo_state` values — v1 snake_case keys). */
export interface RepoState {
  readonly selected?: boolean;
  /** Active command-profile name; absent = repo-type default command. */
  readonly command_profile?: string;
  /** Selected JDK display label; absent = system default (sentinel normalized). */
  readonly java_version?: string;
  readonly expanded?: boolean;
}

/** v2 persisted window state (camelCase — a v2 addition, not a v1 key). */
export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
  readonly fullscreen: boolean;
}

/**
 * The application config document — the v1 config schema
 * (inventory-backend.md §8.3, inventory-config-ci.md §4.1) with v1
 * snake_case keys preserved verbatim. Spanish sentinels are normalized by
 * the Rust reader before this reaches the frontend.
 */
export interface AppConfig {
  readonly workspace_dir?: string;
  /** v1 language code: `en_EN` / `es_ES`. Applied on next start in v1; live in v2. */
  readonly language?: string;
  /** v1 default when absent: `true`. */
  readonly minimize_to_tray?: boolean;
  /** JDK registry: display label → JAVA_HOME path. */
  readonly java_versions?: Readonly<Record<string, string>>;
  readonly last_profile?: string;
  readonly last_profile_by_group?: Readonly<Record<string, string>>;
  readonly workspace_groups?: readonly WorkspaceGroup[];
  /** May reference a missing group — fall back to the first group (§8.3). */
  readonly active_group?: string;
  readonly repo_state?: Readonly<Record<string, RepoState>>;
  /** Selected saved environment per `"repo::module"` key (absent = none). */
  readonly active_configs?: Readonly<Record<string, string>>;
  /** `repo → module → env-name → full raw file content`. */
  readonly repo_configs?: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
  >;
  readonly repo_config_danger?: Readonly<Record<string, readonly string[]>>;
  readonly recent_workspaces?: readonly string[];
  readonly window?: WindowState;
  /** v2: shell command for new terminals (undefined → per-platform default). */
  readonly terminal_shell?: string;
}

/** One shell offered by `list_shells` for the Settings terminal picker. */
export interface ShellInfo {
  readonly label: string;
  readonly command: string;
}

// ---------------------------------------------------------------------------
// Profiles (profiles/types.rs — v1 snake_case JSON keys VERBATIM)
// ---------------------------------------------------------------------------

/** `config_files` snapshot: module dir (`""` = root) → filename → raw content. */
export type ConfigFilesMap = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/** `saved_environments` snapshot: env-file rel path → env name → raw content. */
export type SavedEnvironmentsMap = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/**
 * Per-repo entry of a profile (inventory-backend.md §15.3 — v1 JSON schema,
 * snake_case + `"type"`). `java_version` may carry the v1 sentinel
 * `"Sistema (Por Defecto)"` (= system default) forever.
 */
export interface RepoProfile {
  readonly git_url: string;
  readonly branch: string | null;
  readonly type: string;
  readonly profile: string | null;
  readonly profile_tracked: readonly string[];
  /** Active command-profile name; `null` = repo default. */
  readonly command_profile: string | null;
  readonly java_version?: string;
  readonly selected: boolean;
  readonly docker_compose_active?: readonly string[];
  readonly docker_profile_services?: Readonly<Record<string, readonly string[]>>;
  readonly config_files?: ConfigFilesMap;
  readonly saved_environments?: SavedEnvironmentsMap;
}

/** One whole-workspace profile document (v1 `.devops-profiles/<name>.json`). */
export interface ProfileDocument {
  readonly name?: string;
  readonly created?: string;
  readonly repos: Readonly<Record<string, RepoProfile>>;
}

/** A profile repo missing from the workspace (clone-missing planning). */
export interface MissingRepo {
  readonly name: string;
  readonly gitUrl: string;
  /** Defaults to `main` (inventory-backend.md §15.4). */
  readonly branch: string;
}

/** Result of `apply_profile_environments` — the `repetidoN` rename report. */
export interface ProfileApplyReport {
  /** `configKey → { originalName → storedAs }` (inventory-backend.md §8.6). */
  readonly renames: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

// ---------------------------------------------------------------------------
// Docker (docker/types.rs)
// ---------------------------------------------------------------------------

/** One service definition from a compose file (docker/types.rs). */
export interface ComposeService {
  readonly name: string;
  /** `image:` value, string `build:` fallback, else literal `"unknown"`. */
  readonly image: string;
  readonly ports: readonly string[];
  readonly dependsOn: readonly string[];
}

/** One running container from `docker ps`. */
export interface ContainerInfo {
  readonly name: string;
  readonly status: string;
  readonly ports: string;
}

// ---------------------------------------------------------------------------
// Updates & about (commands/updates.rs)
// ---------------------------------------------------------------------------

/** Result of `check_for_update` (ipc-contract.md §2.9). */
export interface UpdateInfo {
  readonly available: boolean;
  readonly version: string | null;
  readonly notes: string | null;
  readonly date: string | null;
}

/** One version block from `get_changelog` (mirrors Rust `ChangelogRelease`). */
export interface ChangelogRelease {
  readonly version: string;
  readonly date: string | null;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly fixed: readonly string[];
  readonly removed: readonly string[];
}

/** Payload of `update://progress`. `contentLength` is null until known. */
export interface UpdateProgressEvent {
  readonly downloaded: number;
  readonly contentLength: number | null;
}

/**
 * Payload of `dialog://resolved` — a native dialog window settled. `result` is
 * the dialog's JSON outcome, or `null` when cancelled (the opener applies its
 * registered fallback). See docs/migration/dialogs-as-windows.md.
 */
export interface DialogResolvedEvent {
  readonly token: string;
  readonly result: unknown;
}
