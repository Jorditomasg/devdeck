# Architecture — DevOps Manager v2 (Tauri 2 + Angular)

Status: **approved baseline** for the v2 rewrite. Companion documents (the migration contract):

- `inventory-backend.md` — exhaustive behavior contract of the Python non-GUI layers
- `inventory-config-ci.md` — config schemas, translations, theme tokens, persistence, CI/CD
- `inventory-gui.md` — every screen, widget, timing and interaction of the customtkinter GUI

All `§n` references below point into those inventories.

---

## 1. Stack & rationale (decided)

| Concern | v1 (Python) | v2 | Why |
|---|---|---|---|
| Shell / runtime | CPython + Tk (customtkinter) | **Tauri 2** (Rust core, system WebView) | Small signed NSIS installer, real process supervision primitives, first-class tray/single-instance plugins, no Nuitka packaging fragility (§5.4 config-ci) |
| UI | customtkinter widgets | **Angular 22, zoneless + signals, standalone components, OnPush** | Signal stores map 1:1 to the card/status state machine; zoneless removes zone.js cost for a log-streaming-heavy UI; SCSS design tokens replace `ui_theme.yml` |
| IPC | in-process Python EventBus | **typed Tauri `invoke` commands + Tauri events** | Hard process boundary forces the clean contract v1 never had (GUI spawned its own subprocesses, §21.1 backend) |

Pinned at scaffold time (2026-06, verified against npm/crates.io — see `v2/README.md`):
Angular `^22.0.0` (TypeScript `~6.0.0`), `@tauri-apps/api` `^2.11.0`, `@tauri-apps/cli` `^2.11.2`,
`tauri` crate `2.11`, `tauri-build` `2.6`, plugins: `single-instance 2.4`, `dialog 2.7`,
`opener 2.5`, `log 2.8`. YAML via `serde_yaml_ng 0.10` (maintained fork; `serde_yaml` is
archived/deprecated, `serde_yml` rejected for maintenance-quality concerns).

---

## 2. Process model

**Rust owns ALL side effects. Angular is a pure renderer over a typed IPC contract.**

```
┌─────────────────────────────┐      invoke (typed commands)      ┌──────────────────────────────┐
│  Angular (WebView)          │ ────────────────────────────────▶ │  Rust core (src-tauri)       │
│  - signal stores            │                                   │  - subprocess supervision    │
│  - presentational components│ ◀──────────────────────────────── │  - git / docker / java       │
│  - i18n, theme tokens       │      events (status, log lines)   │  - detection (YAML-driven)   │
└─────────────────────────────┘                                   │  - config + profiles I/O     │
                                                                  └──────────────────────────────┘
```

Rust responsibilities (everything v1 did in `core/`, `infrastructure/`, `application/` **plus**
the spawning the v1 GUI did itself, §21.1 backend):

- **Subprocess supervision** — spawn services/installs, stream merged stdout+stderr line-by-line
  (UTF-8 lossy), drive the `starting → running | error → stopped` state machine via
  `ready_pattern` / `error_pattern` / `port_patterns` (§21.2), enforce the v1 timeout table
  (§21.5), kill whole process trees on stop (taskkill `/F /T` on Windows; **own process group +
  killpg on POSIX — fixing v1's self-kill bug**, §22.1).
- **Git** — every operation of `git_manager.py` (§10): status summary badge, branches + reflog
  recency, fetch/pull/checkout/clone/clean, merge pipeline with `blocked_dirty`/`conflict`
  statuses and revert points. Subprocess `git` CLI (not libgit2): v1 semantics are CLI-shaped
  (`--no-optional-locks`, porcelain parsing, progress on stderr) and credentials/config come free.
- **Detection** — the unified detector (see §6 below).
- **Config & profiles** — JSON app config, saved environments, workspace groups, profile
  snapshots (§8, §15 backend), now in OS-standard directories (see §7).
- **Docker** — compose parse/up/down/status with `docker compose` → `docker-compose` fallback (§9).
- **Java** — JDK discovery and `JAVA_HOME`/`PATH` env injection (§13).
- **Tray, single-instance, window lifecycle** — Tauri APIs/plugins.

Angular responsibilities: render state, fire commands, never touch the filesystem, never spawn
anything, never compute git/detection logic. The frontend can be killed and restarted without
losing a single running service (state lives in Rust's `AppState`).

### Concurrency model (Rust)

- `tokio` multi-threaded runtime; every Tauri command is `async` and non-blocking.
- Per-repo git work funnels through semaphores replicating v1's caps
  (`GIT_BADGE_SEMAPHORE_COUNT = 3`, `GIT_FETCH_SEMAPHORE_COUNT = 2`, GUI inventory §28).
- Detection scans candidates concurrently, capped at 8, **preserving alphabetical input order**
  (§6.2 backend — v1 used `executor.map` precisely for ordering).
- `AppState` = `Arc<RwLock<…>>` maps for repos / running services / config cache. The v1
  "mutate the shared cached dict" hazard (§22.9 backend) disappears: copy-on-read or guarded
  read-modify-write only.

---

## 3. IPC & event contract

### 3.1 Commands (`invoke`)

All commands live in `src-tauri/src/commands/` and are mirrored by a generated-by-hand typed
wrapper layer in `src/app/core/ipc/` (one function per command, no stringly-typed `invoke` calls
outside that folder). Command groups mirror the Rust modules: `detection::scan_workspace`,
`process::{start_service, stop_service, install_dependencies}`, `git::{status_summary, branches,
checkout, pull, merge, revert_merge, clone}`, `config::*`, `profiles::*`, `docker::*`, `java::*`.

Error model: v1 returned `(bool, str)` tuples and swallowed exceptions (§5 backend). v2 commands
return `Result<T, AppError>` where `AppError` (thiserror) serializes to
`{ kind: string, message: string }` — the Angular layer maps `kind` to i18n keys.

### 3.2 Events (replacing the Python EventBus)

v1 had exactly ONE real event, `SERVICE_STATUS_CHANGED` (§4.1 backend — the `REQUEST_*` events
in old docs never existed and are **not** reintroduced). v2 uses Tauri events, emitted only by
Rust, consumed only by the Angular event bridge in `core/ipc/`:

| Event name (constant in `src-tauri/src/events.rs`) | Payload | Replaces |
|---|---|---|
| `service://status-changed` | `{ name, status: "starting"\|"running"\|"stopped"\|"error", exitCode?, error?, port? }` | `SERVICE_STATUS_CHANGED` + the GUI-side port detection (§21.2) — port is now detected in Rust and shipped in the same payload |
| `service://log-line` | `{ name, line, stream: "service"\|"install"\|"docker"\|"git" }` | direct textbox writes from GUI-owned reader threads; ANSI escapes stripped Rust-side |
| `repo://scan-progress` | `{ phase, detected, total }` | statusbar "Scanning…" updates |
| `git://badge` | `{ name, branch, behind, staged, unstaged, conflicts }` | per-card 30 s badge poll results (poll loop lives in Rust) |
| `docker://status` | `{ name, services: { [svc]: "running"\|"stopped" } }` | per-card 15 s compose poll |
| `app://single-instance` | `{ argv, cwd }` | loopback PING/PONG protocol (§12 backend) |

Log lines are **batched** (flush every ~50–100 ms or 64 lines, whichever first) so a chatty
Maven build does not emit thousands of IPC events per second; the Angular log store applies the
v1 trim rules (500 lines per card, 1000 global — GUI inventory §28).

---

## 4. Hexagonal layering

### Rust side (`src-tauri/src/`)

```
domain/      pure types: RepoInfo, RunningService, ServiceStatus, RepoTypeDefinition,
             ProfileDocument, MergeOutcome — no tauri/tokio imports
config/      ports+adapters for app-config JSON, saved environments, groups (OS config dir)
detection/   repo-type YAML loading + the unified matching engine
process/     spawn/stream/supervise/kill (the ONLY module that creates child processes,
             except git/docker which own their domain-specific subprocesses)
git/         git CLI adapter
java/        JDK discovery adapter
profiles/    profile snapshot build/apply/import-export
docker/      docker compose adapter
commands/    Tauri command handlers — thin: validate, call module, map to AppError
events.rs    event name constants + payload structs (the IPC contract, single source of truth)
state.rs     AppState (managed by tauri::Builder)
lib.rs       composition root: plugin registration, state, handler registration
```

Dependency rule: `commands → {config,detection,process,git,java,profiles,docker} → domain`.
Nothing imports `commands`; `domain` imports nothing of ours.

### Angular side (`src/app/`)

```
core/ipc/      typed invoke wrappers + event-to-signal bridge (the ONLY place @tauri-apps/api
               is imported)
core/state/    signal stores (repos, services, logs, profiles, settings) — injectable, no UI
core/i18n/     translation service (same flat dot-namespaced keys, {placeholder} interpolation,
               en_EN fallback chain — config-ci §2)
features/      smart/container components: workspace screen (topbar, global panel, repo cards),
               dialogs
ui/            atomic presentational components — inputs/outputs only, no store/ipc injection
styles/        SCSS design tokens ported from config/ui_theme.yml (config-ci §3)
```

Dependency rule: `features → core/* + ui`; `ui` imports nothing from `core`; `core` never
imports `features`/`ui`. Container–presentational discipline enforced by folder boundaries.

---

## 5. Config-driven repo detection (preserved)

The v1 promise — *drop a YAML file in, get a new framework, zero code changes* — is preserved:

- **Bundled definitions**: `v2/config/repo-types/*.yml` are shipped as Tauri **resources**
  (`bundle.resources` in `tauri.conf.json`) and loaded read-only from the resource dir at
  startup.
- **User overrides**: a `repo-types/` folder inside the OS config dir
  (`dirs::config_dir()/devops-manager/repo-types/`) is merged over the bundled set by `type` id
  (user file with the same `type` replaces the bundled one; new files add types). This replaces
  v1's "edit files inside the install dir" model, which broke under Program Files (§4 config-ci).
- **Schema** = the serde model from config-ci §1.2, with the §1.8 fixes:
  - every shipped definition gets an explicit `priority` (react gets `10` so the
    react/docker-infra tie at 0 can never be filesystem-order dependent);
  - hardcoded type-name special cases become schema flags: `detection.allow_no_git: bool`
    (docker-infra), `heuristics.pattern_search_dirs: [..]` (spring-boot's
    `src/main/resources` fallback), `env_files.implicit_default_profile: bool` (Spring
    `default` injection);
  - `windows_reinstall_cmd` / `unix_reinstall_cmd` added (v1 shipped Windows-only
    `rmdir /s /q …` reinstall commands, §22.7 backend).
- **One detector**: ProjectAnalyzerService semantics (§6 backend) merged with the legacy
  detector's enrichments (§16 backend): `java_version` from pom.xml, static
  `server_port`/`context_path` from Spring config, git remote URL — fields the GUI consumes
  but the v1 main path never populated (§22.4).

---

## 6. Data migration from v1

On first launch, if the OS config dir has no `config.json`, the Rust `config` module runs a
one-shot migrator:

1. **Locate v1 data**: `devops_manager_config.json` and `.devops-profiles/` next to the v1
   install (probe: path handed via CLI arg, the workspace parent convention of `main.py` §1,
   and a user-prompted folder picker as fallback).
2. **Translate `devops_manager_config.json`** (full schema in §8.3 backend / §4.1 config-ci) →
   `config.json` in `dirs::config_dir()/devops-manager/`. Key normalizations:
   - **Spanish sentinel values become typed nulls.** v1 persisted UI strings as magic values:
     - `active_configs` entries equal to `"- Sin Seleccionar -"` → key dropped
       (absent = none selected);
     - `repo_state.*.java_version` / profile `java_version` equal to
       `"Sistema (Por Defecto)"` → `null` (system default).
     The **reader keeps accepting both sentinels forever** (idempotent re-import, and profiles
     exported from v1 can be imported years later).
   - `last_profile` (legacy) folded into `last_profile_by_group["Default"]` if the latter is
     absent — same migration v1 did at runtime (§8.3).
   - `workspace_dir` synthesized into a `Default` workspace group when `workspace_groups` is
     absent; `active_group` pointing at a nonexistent group falls back to the first group
     (v1 tolerated this — real config files exhibit it, §8.3).
   - `repo_configs` / `repo_config_danger` / `java_versions` / `language` /
     `minimize_to_tray` copied as-is (the `repo::module` config-key convention is kept).
2. **Copy `.devops-profiles/`** → `dirs::data_dir()/devops-manager/profiles/`, preserving the
   per-group subdirectory layout and sanitization rules (§15.1 backend), including the
   "custom group with no profiles falls back to root listing" compatibility behavior.
3. **Leave v1 files untouched** (read-only migration; v1 remains usable during transition).
4. Write `{ "migratedFrom": "<path>", "migratedAt": "<ISO>" }` into the new config for support.

Profile **import** (the `.json` export files users share) keeps full v1 compatibility:
`repos` key required, `repetidoN` rename strategy on saved-environment merge conflicts, and
`active_configs` repointing after renames (§8.6, §15.4 backend).

---

## 7. Design fixes vs v1 (fixed by construction)

| # | v1 defect | v2 design fix |
|---|---|---|
| 1 | **POSIX killpg self-kill** (§22.1 backend): services spawned without `start_new_session`, then stopped with `killpg(getpgid(child))` — SIGTERMs the app's own process group on Linux | `process/` spawns every service in its **own process group/session** (`process_group(0)` / `setsid`); stop kills that group, then escalates SIGKILL after timeout. Windows keeps `taskkill /F /T` semantics via Job Objects or taskkill |
| 2 | **Broken legacy detector** (§22.3): `repo_detector.py` fallback path calls an undefined function (`NameError`), and main/legacy paths diverge (enrichment gap §22.4, `.yaml` compose mismatch) | Exactly **one** detector in `detection/`, implementing analyzer semantics + legacy enrichments; no fallback path exists |
| 3 | **Dead YAML key `must_match_package_json`** (§22.5): declared in react.yml, never read — any `package.json` repo without angular/nx files classified as react | Implemented: listed package names must appear in `dependencies` or `devDependencies` of the parsed `package.json` |
| 4 | **Dead YAML key `stop_cmd`** (§22.6): killing `docker-compose up -d` never stopped containers | Implemented: when a definition declares `stop_cmd`, stop runs it (with timeout) instead of/before tree-kill; docker-infra now genuinely downs its stack |
| 5 | **Config/profiles/error.log in the install dir** (§4 config-ci): unwritable under Program Files; i18n sidecar caches written next to translations | All persistence in OS dirs: `dirs::config_dir()` (config), `dirs::data_dir()` (profiles), `dirs::cache_dir()`/log plugin (logs). Bundled resources are read-only |
| 6 | **Hand-rolled single-instance** (§12 backend): temp-dir registry + loopback PING/PONG/SHUTDOWN sockets, stale-file pruning | `tauri-plugin-single-instance`: second launch invokes the callback in the first instance, which focuses the window. The v1 design was *per-workspace*; v2 is app-global with the second instance's argv forwarded so the running instance can switch/open the requested workspace group |
| 7 | **PIL screenshot dialog overlay** (GUI inventory): modal "dimming" implemented by screenshotting the window with Pillow and overlaying a darkened image | Plain CSS `backdrop-filter` / semi-transparent overlay — free, resize-safe, removes the Pillow dependency entirely |
| 8 | **Broken CI packaging** (§5.4 config-ci): Nuitka `--standalone` build but only the bare `.exe` zipped, signed and released — unusable without its `main.dist/` folder; no version stamping | `tauri-action` builds a self-contained **NSIS installer** (`bundle.targets: ["nsis"]`), versioned from `tauri.conf.json`, zipped and sent to SignPath (same org/project/policy slugs, new artifact configuration for the installer), released as a working single file |
| 9 | Window white-flash hack (alpha 0 → 1 after build, GUI §1) | `"visible": false` in the window config + explicit `show()` after the frontend signals first paint |
| 10 | Phantom `REQUEST_*` events documented but never implemented (§22.2) | Event catalog is generated from `events.rs` constants — docs and code cannot diverge |

Deliberate **keeps** (not bugs): timing/concurrency table values (GUI §28 — do not lower poll
intervals), `--no-optional-locks` git status, badge double-counting of partially staged files
(§22.19), `origin`-only remote assumptions (§22.20), per-card log trim values.

---

## 8. Directory layout

```
v2/
  package.json                # Angular 22, @tauri-apps/api, @tauri-apps/cli, typescript ~6.0, sass
  angular.json                # @angular/build:application, scss, assets, dev server :4200
  tsconfig.json               # strict
  tsconfig.app.json
  .gitignore
  README.md
  src/
    index.html
    main.ts                   # bootstrapApplication, zoneless
    app/
      app.component.ts        # shell placeholder (router-less single screen)
      app.config.ts           # provideZonelessChangeDetection()
      core/
        ipc/                  # typed invoke/event wrappers (only @tauri-apps/api import site)
        state/                # signal stores
        i18n/                 # translation service (flat keys, {placeholder}, en_EN fallback)
      features/
        workspace/            # main screen: topbar, global panel, repo cards
        dialogs/              # clone, settings, profile, merge, docker, groups, …
      ui/                     # atomic presentational components
    styles/
      styles.scss             # entry; imports _tokens.scss (owned by the theme task)
    assets/
      i18n/                   # en_EN.json / es_ES.json (owned by the i18n task)
  src-tauri/
    Cargo.toml                # tauri 2 + tray-icon; serde, serde_json, serde_yaml_ng, tokio,
                              # regex, thiserror, dirs; plugins: single-instance, dialog, opener, log
    tauri.conf.json           # DevOps Manager / es.orizon.devops-manager / NSIS / resources
    capabilities/default.json
    build.rs
    icons/                    # icon.ico (red) + icon-green.ico from v1 assets; PNG set TODO
    src/
      main.rs                 # thin: devops_manager_lib::run()
      lib.rs                  # Builder + plugins + modules
      state.rs                # AppState
      events.rs               # event constants + payload structs
      domain/  config/  detection/  process/  git/  java/  profiles/  docker/  commands/
  config/
    repo-types/               # ported YAML definitions (owned by the repo-types task)
```
