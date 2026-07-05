# IPC Contract — DevDeck v2

Status: **authoritative**. This document is the contract between the Angular frontend
(`v2/src/app/core/ipc/`) and the Rust commands layer (`v2/src-tauri/src/commands/`). The Rust
commands task implements every command below **verbatim** (names, args, return shapes, error
shape). The TypeScript mirrors live in `v2/src/app/core/ipc/tauri.types.ts` and the typed
wrappers in `v2/src/app/core/ipc/commands.ts` / `events.ts` — those three files and this
document must never diverge.

Companion docs: `architecture-v2.md` (§3 IPC design), `inventory-backend.md`,
`inventory-gui.md` (§28 timing table), `inventory-config-ci.md`.

---

## 1. Conventions

### 1.1 Naming

- **Command names**: `snake_case`, registered in `lib.rs` via `tauri::generate_handler!`.
- **Argument keys**: `camelCase` on the wire. Tauri 2 maps camelCase JS keys to snake_case
  Rust command parameters by default — Rust commands MUST NOT opt out via
  `#[tauri::command(rename_all = "snake_case")]`.
- **Event names**: exactly the constants in `src-tauri/src/events.rs` (`service://status-changed`
  etc.). `events.rs` is the single Rust source of truth; `core/ipc/events.ts` mirrors it.

### 1.2 Payload casing (serde requirement)

All IPC payload structs MUST serialize **camelCase** via `#[serde(rename_all = "camelCase")]`
— already done for `RepoInfo`, `RepoModule`, event payloads, `OpOutput`, `StatusSummary`,
`OrderedBranches`, `MergeRequest`, `MergeOutcome`, `RevertOutcome`, `MissingRepo`,
`ServiceSnapshot`, `ComposeService`, `ContainerInfo`, `WindowState`.

**Deliberate exceptions — persisted v1-compatible documents keep their v1 snake_case keys
verbatim** (they are user files that must round-trip byte-compatibly, architecture-v2.md §6):

| Type | Wire keys | Why |
|---|---|---|
| `AppConfig`, `RepoState`, `WorkspaceGroup` | v1 snake_case (`workspace_dir`, `java_versions`, `custom_command`, `start_args`, …) | `config.json` schema is the v1 schema (inventory-backend.md §8.3) |
| `ProfileDocument`, `RepoProfile` | v1 snake_case + `"type"` for `repo_type` (incl. `start_args`, a v2 addition) | profile `.json` files are shared/imported across versions (inventory-backend.md §15.3) |
| `RevertPoint` | v1 dict keys (`original_branch`, `dest_head_before`, …) | documented v1 payload (inventory-backend.md §10.5) |
| `UiConfig` / `UiSelector` (nested in `RepoInfo.uiConfig`) | snake_case (`install_check_dirs`, `actions`, `selectors`, `icon`, `color`) | passthrough of the repo-type YAML `ui:` block — the Rust `Ui` struct (`domain/repo_type.rs`) has `#[serde(default)]` but NO `rename_all`, so its fields keep their snake_case names on the wire; only the enclosing `RepoInfo.ui_config` field is camelCased (→ `uiConfig`) by `RepoInfo`'s own `rename_all`. Unknown YAML keys round-trip via the struct's `#[serde(flatten)] extra` map. (v2 flattened the v1 nested `ui.install.check_dirs` to a top-level `install_check_dirs`; there is no `UiInstall` type anymore.) |

The TypeScript mirrors reproduce the **wire** casing exactly — no client-side key mapping.

### 1.3 Error shape

Every command returns `Result<T, AppError>`. `AppError` serializes as:

```json
{ "kind": "<machine-readable-kind>", "message": "<human-readable detail>" }
```

A failed `invoke` rejects the promise with this object. The frontend maps `kind` to i18n keys
(architecture-v2.md §3.1). Kinds (extend, never rename):

| kind | Source |
|---|---|
| `configuration`, `detection`, `io`, `yaml_parse`, `json_parse`, `no_os_directory` | `domain::DomainError::kind()` |
| `git` | `git::GitError` (spawn/timeout) surfaced from pipeline-level failures |
| `docker` | `docker::DockerError` |
| `process` | process layer (spawn failure, unknown service id, already-running conflict) |
| `profile` | `profiles::ProfileError` (`MissingReposKey` included) |
| `invalid_args` | command-layer validation |

Operations that v1 reported as `(bool, str)` tuples (git/docker mutations) do **not** error
for domain failures — they resolve with `OpOutput { ok, message }` and only reject on
infrastructure failure (spawn/timeout). This preserves v1's "fold failures into the result"
semantics (inventory-backend.md §5, §10.3).

### 1.4 ServiceStatus — unification requirement

`domain::ServiceStatus` (6 states: `stopped | starting | running | stopping | installing |
error`) is canonical. `events.rs` currently declares a private 5-state copy (no `stopping`)
with a `TODO(integration)` — the commands task MUST complete that unification so
`service://status-changed` can emit all 6 states. The TS union in `tauri.types.ts` is already
the 6-state model.

### 1.5 Service id convention

`"repo"` or `"repo::module"` — the v1 config-key convention (inventory-backend.md §8.3,
`process::types::service_id`). Module key = repo-relative POSIX dir of the env files, or the
literal `root` (`config::ROOT_MODULE_KEY`).

---

## 2. Commands

111 commands across 9 groups (55 core + the 2 app-lifecycle extensions in §2.1
+ the 2 review additions: `set_last_profile` #58 in §2.5, `is_installed` #59
in §2.3, + the post-v1 extensions numbered 60+ in their sections — detached
log/terminal/dialog windows, tray panel, updates §2.9, stash/branch
management, the git-history queries #91–#102 and the changes-window
working-tree commands #103–#108 in §2.4, and `read_active_environment` #111
in §2.5). The authoritative count assertion lives in
`src/app/core/ipc/commands.spec.ts`.

### 2.1 App lifecycle (`commands/app.rs`, wired in `lib.rs`)

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 1 | `frontend_ready` | — | `void` | `lib.rs` — shows the (initially hidden) window after first paint, fixing the v1 white-flash hack (architecture-v2.md §7.9) |

#### App lifecycle extensions

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 56 | `app_exit` | `{ force: boolean }` | `void` | the frontend's answer to `app://close-requested`. `force: true` → `ProcessManager::shutdown_all` (the v1 atexit contract, inventory-backend.md §21.4) + poller stop + `app.exit(0)`. `force: false` → no-op acknowledgement (the close was already prevented Rust-side) |
| 57 | `app_hide_to_tray` | — | `void` | hides the main window; the app keeps running behind the tray icon (inventory-gui.md §25). Restore happens Rust-side via the tray panel "Open DevDeck" or the right-click tray menu |
| 57a | `show_main_window` | — | `void` | restores + focuses the main window and hides the tray quick-control panel — the panel's "Open DevDeck" action (tray-panel design doc 2026-06-23). Exposed because the panel webview holds no `core:window:*` perms |
| 57b | `request_quit` | — | `void` | tray-panel "Close DevDeck": same confirm-running flow as the tray Quit menu — with active services it restores the main window + emits `app://close-requested`, else `app.exit(0)` |
| 60 | `open_log_window` | `{ serviceId: string, title: string }` | `void` | opens (or focuses, when already open) the detached log window for a service — the v1 detached log Toplevel (inventory-gui.md §5/§8) as a real OS window. Loads the SPA with `?log=<serviceId>`; `serviceId` may be the `__global__` aggregate. Window label: `log-<sanitized id>` (capability `windows: ["main", "log-*"]`) |
| 61 | `get_log_backlog` | `{ serviceId: string }` | `string[]` | recent lines from the Rust-side `LogCache` (500/service, 1000 for `__global__` with `[name] ` prefixes) — seeds detached log windows, which then follow live `service://log-line` events |

#### Interactive terminals (design doc `docs/superpowers/specs/2026-06-14-terminales-pty-design.md`)

PTY-backed shells, one detached OS window each (`term-<sanitized id>`,
capability `windows: […, "term-*"]`), isolated from the supervised-service
process layer (`terminal/` subsystem — no status machine, only the `kill.rs`
ladder is reused). Output is streamed RAW (ANSI intact) over a per-window Tauri
`Channel` carrying `InvokeResponseBody::Raw`, **not** the line-batched
`service://log-line` bus — hence no new event. Terminal id is allocated
Rust-side: `<repoId>::term::<n>`, monotonic per repo.

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 62 | `open_terminal_window` | `{ repoId: string, cwd: string, title: string, command?: string }` | `string` (the new terminal id) | allocates the id, spawns a PTY shell (`$SHELL`/`pwsh`→`powershell` default) rooted at `cwd`, opens the `term-<id>` window loading `?terminal=<id>`; a non-empty `command` is typed-ahead (`<command>\r`) into the shell right after spawn |
| 63 | `attach_terminal` | `{ id: string, channel: Channel<ArrayBuffer> }` | `void` | binds the window's output channel: flushes the pre-attach ring buffer, then streams live raw PTY bytes |
| 64 | `terminal_write` | `{ id: string, data: string }` | `void` | forwards keystrokes (the `xterm.onData` string) to the PTY input |
| 65 | `terminal_resize` | `{ id: string, cols: number, rows: number }` | `void` | resizes the PTY viewport (SIGWINCH) |
| 66 | `close_terminal` | `{ id: string }` | `void` | force-kills the PTY process tree (`kill.rs`) and drops the session — invoked by the window on close (no confirmation: closing a terminal window kills its shell) |
| — | `list_shells` | — | `ShellInfo[]` (`{ label, command }`) | shells detected on this machine (PATH + well-known paths: pwsh/powershell/cmd/wsl/Git Bash on Windows; `$SHELL`/bash/zsh/fish/sh on Unix) — for the Settings terminal picker |
| — | `set_terminal_shell` | `{ shell: string \| null }` | `void` | persist the shell command for NEW terminals (`null`/empty → per-platform default); `open_terminal_window` reads `AppConfig::terminal_shell`. Emits `config://changed` |

**Minimize-to-tray** (config key `minimize_to_tray`, v1 default `true`):
Rust-side only — `lib.rs` watches the main window's `Resized` events, probes
`is_minimized()` and hides the window (removing its taskbar entry). Detached
`log-*` windows minimize normally. `frontend_ready` is a no-op when invoked
from a `log-*` window (they bootstrap the same SPA; showing/focusing the main
window from there would steal focus on every detach).

**Close protocol** (inventory-gui.md §17): when the user closes the window (or
picks Quit in the tray menu) while services are running **or any PTY terminal
window is open**, Rust prevents the close and emits `app://close-requested`;
the frontend shows the confirm dialog and answers with `app_exit { force }`.
With nothing running the close proceeds directly (`RunEvent::Exit` does the
cleanup — `ProcessManager::shutdown_all` + `TerminalManager::close_all`).
Closing a single terminal window does NOT confirm — it kills that PTY only.

**Tray** (inventory-gui.md §25, Rust-side only): show/hide toggle + quit menu
(labels localized from the config `language`), tooltip
`"DevDeck — {running}/{total} running|corriendo"` refreshed on every
`service://status-changed` transition, left-click restores the window.

### 2.2 Detection (`detection/`)

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 2 | `scan_workspace` | `{ paths: string[] }` | `RepoInfo[]` | `detection::detect_repos_for_group` |
| — | `list_repos` | — | `RepoInfo[]` | the last `scan_workspace` result cached in `AppState` (empty before the first scan). Lets dialog **windows** — which never scan — hydrate `ReposStore` so `repoByName` works (docs/migration/dialogs-as-windows.md Phase 3) |

Notes:
- `paths` are the active workspace group's roots (the frontend resolves the group from
  `AppConfig`; the command stays stateless w.r.t. group selection).
- Emits `repo://scan-progress` progressively: `phase: "scanning"` at start, one
  `phase: "classifying"` event per candidate directory as repos classify
  (`detected` = repos found so far, `total` = candidate dirs of the current root;
  `detection::ScanProgressFn`), terminal `phase: "done"` with the combined count.
  Concurrency cap 8, alphabetical order preserved, dedup by path
  (inventory-backend.md §6.2–6.3).
- Side effect: re-targets the git badge poller (`git::BadgePoller::set_repos`) and the docker
  status poller (`docker::StatusPoller::set_targets`, for repos with `docker_compose_files`)
  to the scanned repos, and stores the result in `AppState`. The frontend never polls.
- `danger_flags` on each `RepoInfo` is filled from `repo_config_danger` before returning
  (see `RepoInfo` doc in `domain/repo_info.rs`).
- `RepoInfo` is serialized camelCase (`#[serde(rename_all = "camelCase")]`). The v2
  schema redesign added two wire fields (sourced from the repo-type YAML, see
  inventory-config-ci.md §1):
  - `restartDelayMs?: number` — the type's declared `run.restart_delay_ms`; absent ⇒
    the process layer's default (300 ms). Replaces the formerly hardcoded per-type
    docker restart delay.
  - `configEditable: boolean` — the type's `config.editable`; whether the repo exposes
    editable env/config (`false` for docker-infra). Replaces the frontend
    `repoType !== 'docker-infra'` literals. Defaults to `true`.
  - `uiConfig.actions?: string[]` — the YAML `ui.actions` list (e.g. `["seed"]`); the
    repo-card resolves each key through its action registry and renders one button per
    resolved action.

### 2.3 Process supervision (`process/`)

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 3 | `start_service` | `{ serviceId: string, customCommand?: string, startArgs?: string, javaLabel?: string }` | `void` | process manager `start` — builds `ServiceSpec` from the scanned `RepoInfo` + overrides; `startArgs` is appended to the resolved start command (type default OR `customCommand`), preserving OS-aware/`{main_app}` resolution; `javaLabel` resolves through `java::build_java_env` and config key `java_versions` |
| 4 | `stop_service` | `{ serviceId: string }` | `void` | process manager `stop` — runs `stop_cmd` when declared, then tree-kill with SIGTERM→SIGKILL escalation (own process group; architecture-v2.md §7.1) |
| 5 | `restart_service` | `{ serviceId: string, customCommand?: string, startArgs?: string, javaLabel?: string }` | `void` | stop + delayed start (card restart delay = the scanned repo's `RepoInfo.restartDelayMs`, else the 300 ms default; docker-infra ships `run.restart_delay_ms: 2000`. v2 reads this from data — `commands/process.rs::restart_delay` — instead of branching on `repo_type == "docker-infra"`; inventory-gui.md §28) |
| 6 | `install_dependencies` | `{ serviceId: string, reinstall: boolean, javaLabel?: string }` | `void` | install runner — `install_cmd`/OS-resolved `reinstall_cmd`, 600 s cap +5 s kill grace (`process::constants`), refuses while the same id is running (inventory-backend.md §17.1) |
| 7 | `list_services` | — | `ServiceSnapshot[]` | registry snapshot — lets a restarted frontend re-hydrate without losing running services (architecture-v2.md §2) |
| 8 | `stop_all_services` | — | `void` | shutdown-all (30 s cap, `SHUTDOWN_ALL_CAP`); survivors past the cap are force-killed; also wired to Tauri exit |
| 59 | `is_installed` | `{ path: string, checkDirs: string[] }` | `boolean` | `process::is_installed` — the `ui.install_check_dirs` probe (inventory-backend.md §17.1, §22.17): installed when ALL listed dirs exist; an empty list always counts as installed |

All four mutating commands return immediately (`stop_service` runs its stop —
including the untracked `stop_cmd` fallback — detached, like `restart_service`);
progress/result arrives via `service://status-changed` and `service://log-line`.
They reject (`kind: "process"`) only when the spec cannot be built (unknown id,
no command) or the id is already active. A stop emits the transient
`status: "stopping"` before escalation begins (§1.4). The untracked `stop_cmd`
fallback fires ONLY for genuinely untracked ids — a tracked-but-terminal run
(e.g. crashed compose) does not re-run `stop_cmd` (`process::StopOutcome`).
Terminal `error` statuses carry `error: "error pattern matched"` or
`error: "exited while starting, code N"` in the payload.

### 2.4 Git (`git/`)

All repo-addressed commands take the **absolute repo path** (`RepoInfo.path`).
Operation logs flow through `service://log-line` with `stream: "git"` and `name` = repo name.

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 9 | `git_status_summary` | `{ repoPath: string }` | `GitBadge` | `git::get_status_summary` (on-demand; the 30 s poll also pushes `git://badge`) |
| 10 | `git_branches` | `{ repoPath: string, limit?: number }` | `OrderedBranches` | `git::get_ordered_branches` (default limit 7 = `DEFAULT_BRANCH_RECENCY_LIMIT`) |
| 11 | `git_current_branch` | `{ repoPath: string }` | `string` | `git::get_current_branch` |
| 12 | `git_checkout` | `{ repoPath: string, branch: string }` | `OpOutput` | `git::checkout` (with `origin/<branch>` tracking fallback) |
| 13 | `git_pull` | `{ repoPath: string }` | `OpOutput` | `git::pull` (`--ff-only`) |
| 14 | `git_fetch` | `{ repoPath: string }` | `OpOutput` | `git::fetch` (fetch semaphore: 2, inventory-gui.md §28) |
| 15 | `git_clone` | `{ url: string, destPath: string }` | `OpOutput` | `git::clone` — stderr progress % forwarded as `[git] …` log lines (`stream: "git"`, `name` = dest basename) |
| 16 | `git_clean` | `{ repoPath: string }` | `OpOutput` | `git::clean_repo` (add -A, reset --hard, clean -fd) |
| 17 | `git_local_changes` | `{ repoPath: string, ignorePatterns: string[] }` | `string[]` | `git::get_local_changes` (merge-dialog dirty preview) |
| 18 | `git_has_branch` | `{ repoPath: string, branch: string }` | `boolean` | `git::has_branch` |
| 19 | `git_capture_revert_point` | `{ repoPath: string, request: MergeRequest }` | `RevertPoint` | `git::capture_revert_point` — MUST be invoked before `git_merge` (inventory-backend.md §10.5) |
| 20 | `git_merge` | `{ repoPath: string, request: MergeRequest }` | `MergeOutcome` | `git::merge_branch` — full §10.4 pipeline; conflicts leave the tree conflicted |
| 21 | `git_revert_merge` | `{ repoPath: string, revertPoint: RevertPoint }` | `RevertOutcome` | `git::revert_merge` |
| 22 | `git_refresh_badge` | `{ repoPath: string }` | `void` | `git::refresh_badge` — forces one poll cycle; result arrives as `git://badge` |
| 62 | `git_stash_list` | `{ repoPath: string }` | `StashEntry[]` | `git::stash_list` — `git stash list` parsed (newest = index 0) |
| 63 | `git_stash_push` | `{ repoPath: string, message?: string, includeUntracked: boolean }` | `OpOutput` | `git::stash_push` — `git stash push [-u] [-m]` |
| 64 | `git_stash_apply` | `{ repoPath: string, index: number }` | `OpOutput` | `git::stash_apply` — applies, keeps the entry |
| 65 | `git_stash_pop` | `{ repoPath: string, index: number }` | `OpOutput` | `git::stash_pop` — applies + drops |
| 66 | `git_stash_drop` | `{ repoPath: string, index: number }` | `OpOutput` | `git::stash_drop` |
| 67 | `git_create_branch` | `{ repoPath: string, name: string, base?: string, checkout: boolean }` | `OpOutput` | `git::create_branch` — `checkout -b` / `branch` |
| 68 | `git_delete_branch` | `{ repoPath: string, name: string, force: boolean }` | `OpOutput` | `git::delete_branch` — `branch -d`/`-D` |
| 69 | `git_delete_remote_branch` | `{ repoPath: string, name: string }` | `OpOutput` | `git::delete_remote_branch` — `push origin --delete` |
| 70 | `git_rename_branch` | `{ repoPath: string, from?: string, to: string }` | `OpOutput` | `git::rename_branch` — `branch -m` |
| 71 | `git_publish_branch` | `{ repoPath: string, name: string }` | `OpOutput` | `git::publish_branch` — `push -u origin` |
| 91 | `open_git_window` | `{ repoId: string, title: string, branch?: string, tab?: "history"\|"stashes"\|"changes", stash?: number }` | `void` | opens (or focuses) the detached git window of a repo. Loads the SPA with `?git=<repoId>` + the optional view params (`branch` preselects the filter — branch-dialog entry; `tab: "stashes"`/`stash` open the stash viewer — stash-dialog entry; `tab: "changes"` the working-tree changes window — changes-badge entry, design doc 2026-07-03). Per-mode window label `git-`/`git-stashes-`/`git-changes-<sanitized id>` (all matched by capability `windows: [..., "git-*"]`), so focusing one mode never hijacks another. An already-open window of the same mode is only focused. Git suite (design doc 2026-07-02) |
| 92 | `git_log` | `{ repoPath: string, filter: GitLogFilter }` | `GitLogPage` | `git::get_log` — paginated (50 + `hasMore` look-ahead, `skip` cursor); filters (`branch`, `author`, `since`, `until`, `grep`, `path`) applied BY GIT. Badge semaphore (3) |
| 93 | `git_commit_files` | `{ repoPath: string, sha: string }` | `GitCommitFileStat[]` | `git::get_commit_files` — `diff-tree -r --root -m --first-parent --numstat -M` (merges diff against first parent). Badge semaphore |
| 94 | `git_commit_file_diff` | `{ repoPath: string, sha: string, path: string }` | `GitFileDiff` | `git::get_commit_file_diff` — ONE file per call; > 512 KiB ⇒ `{ tooLarge: true }`, binary ⇒ `{ binary: true }`. Badge semaphore |
| 95 | `git_file_at_commit` | `{ repoPath: string, sha: string, path: string }` | `GitFileAtCommit` | `git::get_file_at_commit` — `show <sha>:<path>`, blob size checked with `cat-file -s` BEFORE reading. Badge semaphore |
| 96 | `git_working_diff` | `{ repoPath: string, path: string, staged: boolean }` | `GitFileDiff` | `git::get_working_diff` — working-tree diff of one file (`--cached` when `staged`); consumer = phase-3 stage view. Badge semaphore |
| 97 | `git_authors` | `{ repoPath: string }` | `GitAuthor[]` | `git::get_authors` — `shortlog -sne --branches --remotes --tags` (NO `--all`: stash refs would count the local user), most commits first; author filter dropdown (phase 2). Badge semaphore |
| 98 | `git_diff_range` | `{ repoPath: string, base: string, target: string }` | `GitCommitFileStat[]` | `git::get_range_files` — `diff --numstat -M base...target` (compare / incoming view, phase 3). Badge semaphore |
| 99 | `git_diff_range_file` | `{ repoPath: string, base: string, target: string, path: string }` | `GitFileDiff` | `git::get_range_file_diff` — one file, `diff -M base...target -- <path>`, usual caps. Commit list of a range rides `git_log` with `branch: "base..target"`. Badge semaphore |
| 100 | `git_ls_files` | `{ repoPath: string }` | `string[]` | `git::list_files` — tracked files, capped at 5000; path-filter autocomplete. Badge semaphore |
| 101 | `git_commit_body` | `{ repoPath: string, sha: string }` | `string` | `git::get_commit_body` — full `%B` message on demand (the log format carries only the subject). Badge semaphore |
| 102 | `git_tags` | `{ repoPath: string }` | `string[]` | `git::list_tags` — tags newest first (capped at 1000); the history rev filter lists them with a `tag:` prefix so tag filtering is visually distinct from branches. Badge semaphore |
| 103 | `git_changes_list` | `{ repoPath: string }` | `GitChangeEntry[]` | `git::get_changes` — `status --porcelain -z` parsed into per-group rows (a partially staged `MM` file yields one staged + one unstaged entry). Changes window (design doc 2026-07-03). Badge semaphore |
| 104 | `git_stage_file` | `{ repoPath: string, path: string }` | `OpOutput` | `git::stage_file` — `git add -- <path>` (also marks a conflicted file resolved) |
| 105 | `git_unstage_file` | `{ repoPath: string, path: string }` | `OpOutput` | `git::unstage_file` — `git restore --staged -- <path>` |
| 106 | `git_discard_file` | `{ repoPath: string, path: string, untracked: boolean }` | `OpOutput` | `git::discard_file` — tracked: `git restore -- <path>`; untracked: `git clean -f -- <path>`. DESTRUCTIVE; the frontend confirms first |
| 107 | `git_read_working_file` | `{ repoPath: string, path: string }` | `GitFileAtCommit` | `git::read_working_file` — working-tree contents, same caps as #95 (512 KiB ⇒ `tooLarge`, NUL ⇒ `binary`). Path guarded inside the repo (canonicalized prefix check, no `..`/absolute/symlink escapes). Badge semaphore |
| 108 | `git_write_working_file` | `{ repoPath: string, path: string, content: string }` | `void` | `git::write_working_file` — saves the changes-window editor. Same path guard; only writes files that already exist |

> `StashEntry` type (§1.2): `{ index: number, message: string, branch: string }` (camelCase wire).
> `GitChangeEntry` (§1.2, camelCase wire): `{ path, oldPath?, staged: boolean, status }` — `status` is the porcelain letter (`M`/`A`/`D`/`R`/`T`…) with `??` folded to `U` and conflict states to `C`.
> History types (§1.2, camelCase wire): `GitCommitInfo { sha, parents: string[], authorName, authorEmail, date /* ISO 8601 */, subject, refs: string[] }`, `GitLogPage { commits: GitCommitInfo[], hasMore }`, `GitLogFilter { all?, branch?, author?, since?, until?, grep?, path?, skip? }` (`all` walks every ref — whole-repo flow view; log always runs `--topo-order` for the lane graph), `GitCommitFileStat { path, oldPath?, additions, deletions, binary }`, `GitFileDiff { content?, binary, tooLarge }`, `GitFileAtCommit { content?, binary, tooLarge, size }`, `GitAuthor { name, email, commits }`. Stash contents reuse #93/#94 with `sha: "stash@{n}"` (a stash IS a commit; first-parent diff = `stash show`).

### 2.5 Config (`config/`)

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 23 | `get_app_config` | — | `AppConfig` | `ConfigStore::load` (sentinels normalized; v1 keys accepted forever) |
| 24 | `set_language` | `{ language: string }` | `void` | `ConfigStore::update` — v1 codes (`en_EN`, `es_ES`) persisted |
| 25 | `set_minimize_to_tray` | `{ value: boolean }` | `void` | `ConfigStore::update` |
| 26 | `set_active_group` | `{ name: string }` | `void` | `ConfigStore::update` |
| 27 | `save_workspace_groups` | `{ groups: WorkspaceGroup[] }` | `void` | `ConfigStore::update` |
| 28 | `set_repo_state` | `{ repo: string, state: RepoState }` | `void` | `ConfigStore::update` — whole-entry replace per repo |
| 29 | `get_saved_environments` | `{ configKey: string }` | `Record<string, string>` | `AppConfig::repo_configs_for` |
| 30 | `save_saved_environments` | `{ configKey: string, environments: Record<string, string> }` | `void` | `AppConfig::set_repo_configs_for` (empty map removes the entry) |
| 60 | `get_command_profiles` | `{ repo: string }` | `Record<string, string>` | `AppConfig::command_profiles_for` — returns name→command-line map for one repo |
| 61 | `save_command_profiles` | `{ repo: string, profiles: Record<string, string> }` | `void` | `AppConfig::set_command_profiles_for` (empty map removes the entry) |
| 31 | `set_active_config` | `{ configKey: string, name: string \| null }` | `void` | `ConfigStore::update` — `null` drops the key (v1 sentinel `"- Sin Seleccionar -"` normalized) |
| 32 | `set_danger_flags` | `{ configKey: string, names: string[] }` | `void` | `ConfigStore::update` (stored sorted; empty removes key) |
| 33 | `read_config_file` | `{ path: string }` | `string` | `config::read_config_file_raw` |
| 34 | `write_config_file` | `{ path: string, content: string }` | `void` | `config::write_config_file_raw` |
| 35 | `apply_environment` | `{ writerType: string, targetFile: string, profile: string, content: string }` | `void` | `config::write_active_environment` (`spring` validates YAML + targets profile file; `angular`/`raw` write verbatim, inventory-config-ci.md §1.5) |
| 111 | `read_active_environment` | `{ writerType: string, targetFile: string, profile: string }` | `string` | `config::read_active_environment` — current content of the file `apply_environment` writes for `profile` (`spring` reads the BASE `application.{ext}` — Model B; `angular`/`raw` read the target); missing → `""`. Drives env-file drift deselection (§10). |
| 58 | `set_last_profile` | `{ group: string \| null, name: string \| null }` | `void` | `ConfigStore::update` — persists `last_profile_by_group[group or "Default"] = name`; `name: null` clears the entry (inventory-backend.md §8.3) |

### 2.6 Java (`java/`)

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 37 | `detect_jdks` | — | `Record<string, string>` | `java::auto_detect_java_paths` — label → JAVA_HOME; never errors (invalid candidates skipped) |
| 38 | `save_java_versions` | `{ versions: Record<string, string> }` | `void` | `ConfigStore::update` of the `java_versions` registry (whole-map replace) |

The registry itself is read from `get_app_config().java_versions`.

### 2.7 Profiles (`profiles/`)

`group` omitted/`null` ⇒ the `Default` group (root profiles dir).

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 39 | `list_profiles` | `{ group?: string }` | `string[]` | `ProfileStore::list_profiles` (incl. the empty-custom-group root fallback) |
| 40 | `load_profile` | `{ name: string, group?: string }` | `ProfileDocument \| null` | `ProfileStore::load_profile` (broken files ⇒ `null`, v1 parity) |
| 41 | `save_profile` | `{ name: string, group?: string, doc: ProfileDocument, includeConfigFiles: boolean }` | `string` (saved path) | `ProfileStore::save_profile`; when `includeConfigFiles`, Rust enriches each repo entry via `profiles::capture_config_files` / `capture_saved_environments` before writing. The frontend builds the per-repo state (selection, branch, profile, custom command, java, docker) — it owns that state; Rust owns file snapshots |
| 42 | `delete_profile` | `{ name: string, group?: string }` | `boolean` | `ProfileStore::delete_profile` |
| 43 | `export_profile` | `{ doc: ProfileDocument, destPath: string }` | `void` | `profiles::export_profile_to_file` |
| 44 | `import_profile` | `{ srcPath: string }` | `ProfileDocument` | `profiles::import_profile_from_file` (rejects without `repos` key — `kind: "profile"`) |
| 45 | `get_missing_repos` | `{ workspaceDir: string, doc: ProfileDocument }` | `MissingRepo[]` | `profiles::get_missing_repos` (clone-missing planning; branch defaults to `main`) |
| 46 | `apply_profile_environments` | `{ doc: ProfileDocument, workspaceDir: string }` | `ProfileApplyReport` | `profiles::apply_config_files` + `apply_saved_environments` + `update_active_configs_for_renames`, persisting through `ConfigStore::update` — returns the `repetidoN` renames so the UI can report them (inventory-backend.md §15.4) |

### 2.8 Docker (`docker/`)

Compose operation logs flow through `service://log-line` with `stream: "docker"`.

| # | Command | Args | Returns | Backing |
|---|---|---|---|---|
| 47 | `docker_available` | — | `boolean` | `docker::is_docker_available` |
| 48 | `docker_compose_services` | `{ composeFile: string }` | `ComposeService[]` | `docker::parse_compose_services` |
| 49 | `docker_compose_up` | `{ composeFile: string, services?: string[] }` | `OpOutput` | `docker::docker_compose_up` (120 s timeout) |
| 50 | `docker_compose_stop` | `{ composeFile: string, services?: string[] }` | `OpOutput` | `docker::stop_service_compose` (60 s) |
| 51 | `docker_compose_down` | `{ composeFile: string }` | `OpOutput` | `docker::docker_compose_down` (60 s) |
| 52 | `docker_compose_status` | `{ composeFile: string, services: string[] }` | `Record<string, DockerServiceState>` | `docker::get_compose_service_status` (on-demand; 15 s poll also pushes `docker://status`) |
| 53 | `docker_compose_logs` | `{ composeFile: string, service: string, tail: number }` | `string` | `docker::docker_compose_logs` |
| 54 | `docker_refresh_status` | `{ repoName: string, composeFile: string, services: string[] }` | `void` | `docker::refresh_status` — forces one poll; result arrives as `docker://status` |
| 109 | `docker_log_start` | `{ serviceId: string }` | `void` | `docker::DockerLogManager::attach` — ref-counted `logs -f` follower; `serviceId` is `docker::<file>::<service>`, lines arrive via `service://log-line` (design doc 2026-07-05) |
| 110 | `docker_log_stop` | `{ serviceId: string }` | `void` | `docker::DockerLogManager::detach` — last detach kills the follower |
| 111 | `set_docker_selection` | `{ repoName: string, file: string, services: string[], active: boolean }` | `void` | Rust relay re-emitting `docker://selection` so the main window folds the isolated dialog's selection into card state |

Not exposed (no UI consumer in v1 — `start_mysql` / `stop_mysql` / `is_mysql_running` /
`get_running_containers` stay library-internal until a feature needs them).

### 2.9 Updates & about (`commands/updates.rs`)

Wraps `tauri-plugin-updater` (Rust-side; the frontend never calls the plugin
directly) and serves the bundled `CHANGELOG.md`. Configured via
`plugins.updater` (pubkey + GitHub `latest.json` endpoint) in `tauri.conf.json`.

| # | Command | Args | Returns | Notes |
|---|---|---|---|---|
| 77 | `check_for_update` | — | `UpdateInfo { available, version?, notes?, date? }` | queries the updater endpoint; `available: false` when up to date. Called silently on startup + via the manual button |
| 78 | `install_update` | — | `void` | downloads + installs the update (emits `update://progress`), then restarts the app |
| 79 | `get_changelog` | — | `ChangelogRelease[] { version, date?, added[], changed[], fixed[], removed[] }` | parses the bundled `CHANGELOG.md` (newest first) |
| 80 | `whats_new_on_startup` | — | `string \| null` | marks the running version as seen; returns it when the app was just updated (so the "What's new" popup shows), else `null` (fresh install / same version / opted out) |
| 81 | `disable_whats_new` | — | `void` | user ticked "don't show again": suppresses the post-update popup permanently (`AppConfig.whats_new_disabled`) |

---

#### Native dialog windows (design doc `docs/migration/dialogs-as-windows.md`)

In-app modals are migrating to real OS windows (`dlg-<kind>-<n>`, capability
`windows: […, "dlg-*"]`), non-resizable, one webview each. The opener calls
`open_dialog_window`; the dialog window fetches its inputs with
`get_dialog_args` and returns its outcome with `resolve_dialog`, which emits
`dialog://resolved` and closes the window Rust-side (the dialog webview holds no
`core:window:*` permissions, like the log/terminal windows). The window label
doubles as the result token. See the design doc for the full contract and the
migration phases.

| Command | Args | Returns | Backing |
|---|---|---|---|
| `open_dialog_window` | `{ kind: string, title: string, args: Json, parentLabel?: string \| null }` | `string` (the result token = window label) | allocates `dlg-<kind>-<n>`, stores `args`, opens the non-resizable webview loading `?dialog=<kind>&token=<t>`, parented + centered on `parentLabel` |
| `get_dialog_args` | `{ token: string }` | `Json` | the dialog window's stored inputs (`null` once resolved) |
| `resolve_dialog` | `{ token: string, result: Json }` | `void` | records the outcome, emits `dialog://resolved { token, result }`, closes the window; `result: null` = cancel (opener applies its fallback) |

## 3. Events

12 events. Only Rust emits; the frontend only listens (`core/ipc/events.ts`). Names and payload
structs live in `src-tauri/src/events.rs`.

| Event | Payload (TS mirror) | Cadence / source |
|---|---|---|
| `service://status-changed` | `ServiceStatusEvent { name, status: ServiceStatus, exitCode?, error?, port?, pid? }` | on every lifecycle transition (process layer). 6-state model — see §1.4 |
| `service://log-line` | `ServiceLogEvent { name, stream: "service"\|"install"\|"docker"\|"git", lines: string[], timestampMs }` | **batched**: flush every 75 ms or 64 lines, whichever first (`process::constants::LOG_BATCH_*`); ANSI-stripped, non-empty lines |
| `repo://scan-progress` | `ScanProgressEvent { phase, detected, total }` | during `scan_workspace`; terminal phase is `"done"` |
| `git://badge` | `GitBadgeEvent { name, path, branch, behind, staged, unstaged, conflicts }` | 30 s poll loop per repo (`git::BADGE_REFRESH`; semaphore 3) + forced via `git_refresh_badge`. `name` is the path basename (fallback); the frontend routes by `path` — repos with duplicate basenames across roots carry disambiguated `RepoInfo.name`s |
| `docker://status` | `DockerStatusEvent { name, services: Record<string, "running"\|"stopped"> }` | 15 s poll loop per docker-capable repo (`docker::DOCKER_POLL`) + forced via `docker_refresh_status` |
| `docker://selection` | `DockerSelectionEvent { repoName, file, services: string[], active }` | Rust relay of `set_docker_selection` — the isolated docker-compose window's selection reaches the main window's `WorkspaceStore` (design doc 2026-07-05) |
| `app://single-instance` | `SingleInstanceEvent { argv, cwd }` | second launch (tauri-plugin-single-instance callback) |
| `app://close-requested` | `{}` (empty object) | close/quit attempted while services run; Rust prevented the close — the frontend shows the confirm-running dialog and answers with `app_exit { force }` (§2.1 extensions) |
| `update://progress` | `UpdateProgressEvent { downloaded, contentLength: number \| null }` | download progress while `install_update` runs (updater chunk callback) |
| `config://changed` | `AppConfig` (full, v1 snake_case keys) | the persisted config changed — emitted from the single `ConfigStore::save` choke point so every window's `SettingsStore` re-syncs (docs/migration/dialogs-as-windows.md Phase 3) |
| `profiles://changed` | `{ group: string \| null, saved: string \| null }` | a profile was saved/deleted — emitted from `save_profile` / `delete_profile` so every window's `ProfilesStore` re-lists and reconciles its active selection (adopts `saved`, or deselects a deleted profile). The profile manager runs in its own window; the main window's dropdown would otherwise miss new profiles |
| `dialog://resolved` | `DialogResolvedEvent { token, result: unknown }` | a native dialog window settled (`resolve_dialog` or `dlg-*` close); `result: null` = cancelled → opener applies its fallback (design doc `dialogs-as-windows.md`) |

`name` in `git://badge` / `docker://status` / service events is the repo name / service id
(`"repo"` or `"repo::module"`).

Frontend log trimming (the event consumer's contract, inventory-gui.md §28): 500 lines per
service ring buffer, 1000 lines global — enforced in `core/state/services.store.ts`, not in Rust.

---

## 4. Store ↔ contract mapping (frontend reference)

| Store | Commands consumed | Events consumed |
|---|---|---|
| `ReposStore` | `scan_workspace`, `git_refresh_badge` | `repo://scan-progress`, `git://badge` |
| `ServicesStore` | `start_service`, `stop_service`, `restart_service`, `install_dependencies`, `list_services`, `stop_all_services` | `service://status-changed`, `service://log-line` |
| `ProfilesStore` | `list_profiles`, `load_profile`, `save_profile`, `delete_profile`, `export_profile`, `import_profile`, `get_missing_repos`, `apply_profile_environments` | — |
| `SettingsStore` | `get_app_config`, `set_language`, `set_minimize_to_tray`, `set_active_group`, `save_workspace_groups`, `set_repo_state`, `save_java_versions`, `detect_jdks` | `app://single-instance` |
| feature tasks (dialogs/cards) | git group, docker group, config env group (29–35) | via stores |
| app shell (root component) | `frontend_ready`, `app_exit`, `app_hide_to_tray` | `app://close-requested` |
