# Backend Feature Inventory — DevDeck (Python → Rust/Tauri 2 migration contract)

This document is the EXHAUSTIVE contract for reimplementing the non-GUI layers of DevDeck.
It is self-contained: implementers must NOT need the Python source. All references are
`relative/path.py:line` against the Python codebase at the time of writing.

Layers covered: `main.py`, `domain/`, `application/`, `core/`, `infrastructure/`.
GUI internals are excluded, EXCEPT where the GUI is a direct party to a backend contract
(process lifecycle, ready/port detection, config schema) — those contracts are documented here.

---

## Table of Contents

1. [Entry point — main.py](#1-entry-point--mainpy)
2. [domain/models/repo_info.py — RepoInfo](#2-domainmodelsrepo_infopy--repoinfo)
3. [domain/models/running_service.py — RunningService](#3-domainmodelsrunning_servicepy--runningservice)
4. [domain/ports/event_bus.py — EventBus + event catalog](#4-domainportsevent_buspy--eventbus)
5. [domain/exceptions.py](#5-domainexceptionspy)
6. [application/services/project_analyzer.py — repo detection](#6-applicationservicesproject_analyzerpy--projectanalyzerservice)
7. [application/use_cases/manage_services_use_case.py](#7-applicationuse_casesmanage_services_use_casepy)
8. [core/config_manager.py + full devdeck_config.json schema](#8-coreconfig_managerpy)
9. [core/db_manager.py — Docker / MySQL / Flyway](#9-coredb_managerpy--docker--mysql--flyway)
10. [core/git_manager.py — every git operation](#10-coregit_managerpy)
11. [core/i18n.py — internationalisation](#11-corei18npy--internationalisation)
12. [core/instance_manager.py — single-instance coordination](#12-coreinstance_managerpy--single-instance-coordination)
13. [core/java_manager.py — Java detection](#13-corejava_managerpy--java-detection)
14. [core/logger.py — error logging](#14-coreloggerpy--error-logging)
15. [core/profile_manager.py — workspace profiles](#15-coreprofile_managerpy--workspace-profiles)
16. [core/repo_detector.py — LEGACY detector](#16-corerepo_detectorpy--legacy-detector)
17. [core/service_launcher.py — install runner + stop semantics](#17-coreservice_launcherpy)
18. [infrastructure/process/process_manager.py](#18-infrastructureprocessprocess_managerpy)
19. [infrastructure/config parsers](#19-infrastructureconfig-parsers)
20. [Repo-type YAML definition schema + shipped definitions](#20-repo-type-yaml-definition-schema)
21. [Cross-cutting: process lifecycle contract (incl. GUI-side spawn)](#21-cross-cutting-process-lifecycle-contract)
22. [Edge cases, gotchas, and known divergences](#22-edge-cases-gotchas-and-known-divergences)

---

## 1. Entry point — main.py

File: `main.py` (97 lines).

Startup sequence (`main()` at main.py:39):

1. **Logging init** — `core.logger.setup_logging()` (main.py:41-42). Must run first; configures
   the rotating `error.log` (see §14).
2. **i18n init** — `init_i18n(get_app_setting("language", default="en_EN"))` (main.py:45-47).
   The language code comes from the JSON config (key `language`); MUST happen before any
   widget/window is created.
3. **Windows AppUserModelID** — on `win32` only, calls
   `ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('devdeck.app.1.0')`
   (main.py:50-56) so the taskbar uses the custom icon. Failures swallowed.
4. **Global exception hook** — `sys.excepthook = handle_exception` (main.py:59).
   `handle_exception` (main.py:17-36):
   - `KeyboardInterrupt` → delegate to default hook and return.
   - Otherwise: print "Fatal Error encountered. Shutting down services..." to stderr,
     print the traceback to stderr, `logging.critical(...)` (goes to error.log),
     attempt to import `ServiceLauncher` (its atexit hook handles cleanup), then `os._exit(1)`.
5. **Workspace resolution** (main.py:62-69):
   - Default workspace = **parent directory of the tool's own directory**
     (`os.path.dirname(project_root)`).
   - `sys.argv[1]`, if present, overrides it; if that path is not a directory, prints
     `Error: El directorio '<path>' no existe.` and `sys.exit(1)`.
6. **Wiring** (main.py:77-93):
   - `config_dir = <project_root>/config`.
   - Instantiate `ProjectAnalyzerService(config_dir)`, `ProcessManager()`, then
     `DevOpsManagerApp(workspace_dir, project_analyzer, process_manager)` and `app.mainloop()`.

`sys.path.insert(0, project_root)` at main.py:10-11 makes the package importable when run as a script.

---

## 2. domain/models/repo_info.py — RepoInfo

Pure dataclass (`@dataclass`, repo_info.py:5-54). Holds ALL detected metadata for one repository.
Fields (name : type = default — meaning):

| Field | Type / default | Meaning | Set by |
|---|---|---|---|
| `name` | `str` (required) | Directory basename | analyzer |
| `path` | `str` (required) | Absolute repo path | analyzer |
| `repo_type` | `str` (required) | YAML `type` value, e.g. `spring-boot`, `angular` | analyzer |
| `profiles` | `List[str] = []` | Detected env/profile names (Spring profiles, Angular env names) | analyzer (`_resolve_env_files`) |
| `git_remote_url` | `Optional[str] = None` | Origin URL | GUI/legacy detector (NOT set by main analyzer — see §22) |
| `current_branch` | `Optional[str] = None` | Current branch | not set by analyzer (GUI queries git directly) |
| `run_install_cmd` | `Optional[str]` | YAML `commands.install_cmd` | analyzer |
| `run_reinstall_cmd` | `Optional[str]` | YAML `commands.reinstall_cmd` | analyzer |
| `run_command` | `Optional[str]` | Resolved start command (OS-specific + `{main_app}` substitution) | analyzer |
| `environment_files` | `List[str] = []` | Absolute paths of matched env/config files | analyzer |
| `env_default_dir` | `str = ""` | YAML `env_files.default_dir` | analyzer |
| `env_config_writer_type` | `str = "raw"` | YAML `env_files.config_writer_type` (`raw`/`spring`/`angular`) | analyzer |
| `env_pull_ignore_patterns` | `List[str] = []` | Glob patterns of files to ignore for "dirty" checks during pull | analyzer |
| `env_main_config_filename` | `str = ""` | YAML `env_files.main_config_filename` | analyzer |
| `env_patterns` | `List[str] = []` | YAML `env_files.patterns` (glob) | analyzer |
| `ui_config` | `dict = {}` | Whole YAML `ui` block (icon, color, selectors, install.check_dirs) | analyzer |
| `features` | `List[str] = []` | YAML `features` list (`java_version`, `docker_checkboxes`) | analyzer |
| `java_version` | `Optional[str] = None` | Recommended Java from pom.xml | ONLY legacy detector (§16, §22) |
| `server_port` | `Optional[int] = None` | Spring server.port | legacy detector statically; GUI updates it at runtime from log lines |
| `context_path` | `Optional[str] = None` | Spring server.servlet.context-path | ONLY legacy detector |
| `ready_pattern` | `Optional[str] = None` | Regex: log line meaning "service ready" | analyzer (YAML `commands.ready_pattern`) |
| `error_pattern` | `Optional[str] = None` | Regex: log line meaning "startup failed" | analyzer |
| `port_patterns` | `List[str] = []` | Regexes with one capture group = port number | analyzer |
| `docker_compose_files` | `List[str] = []` | Absolute paths of `docker-compose*.yml/.yaml` at repo root (sorted) | analyzer when `docker_checkboxes` feature |
| `detected_framework` | `str = "unknown"` | Optional metadata, unused in practice | — |

---

## 3. domain/models/running_service.py — RunningService

Dataclass (running_service.py:10-18):

- `name: str` — service name (== repo name).
- `repo_path: str`.
- `process: Optional[subprocess.Popen] = None` — OS process handle.
- `thread: Optional[threading.Thread] = None` — the streaming/worker thread.
- `status: str = 'stopped'` — one of `running`, `starting`, `stopped`, `error` (free string).
- `port: Optional[int] = None`.

Comment at running_service.py:6-8 acknowledges the process/thread handles leak infrastructure
into the domain; in Rust, model this as a service-state struct + a separate process handle map.

---

## 4. domain/ports/event_bus.py — EventBus

Thread-safe singleton pub/sub (event_bus.py:9-60).

Implementation contract:
- **Singleton** via `__new__` guarded by a class-level `threading.Lock` (event_bus.py:16-25).
  A module-level global `bus = EventBus()` (event_bus.py:60) is what everyone imports.
- Subscriber registry: `Dict[str, List[Callable]]` guarded by an `RLock` (event_bus.py:23-24).
- `subscribe(event_type, callback)` (event_bus.py:27-33): appends if not already present
  (duplicate-subscription is a no-op).
- `unsubscribe(event_type, callback)` (event_bus.py:35-42): silent if missing.
- `publish(event_type, event_data=None)` (event_bus.py:44-57): snapshots the callback list under
  the lock, then invokes each callback **synchronously in the publisher's thread**, OUTSIDE the
  lock. Exceptions in a callback are caught and logged (`logging.error`), never propagated —
  one bad subscriber cannot break others. GUI subscribers are responsible for marshalling to
  the UI thread (Tk `after()`).

### 4.1 Event catalog (ACTUAL, verified by grep over the whole codebase)

Only **one** event type exists in the code:

| Event | Payload (dict) | Publishers | Subscribers |
|---|---|---|---|
| `SERVICE_STATUS_CHANGED` | `{"name": str, "status": "starting"\|"running"\|"stopped"\|"error"}` plus optional `"exit_code": int` (on normal exit) or `"error": str` (on failure) | `infrastructure/process/process_manager.py:58,84,90,98,133,144,152` | `gui/repo_card/_base.py:91` (subscribe), `:122` (unsubscribe on destroy) |

> **Important divergence**: the project CLAUDE.md mentions `REQUEST_START_SERVICE`,
> `REQUEST_STOP_SERVICE`, `REQUEST_INSTALL_DEPENDENCIES`. **These events do not exist anywhere
> in the code.** The GUI calls launcher/manager methods directly. Do not invent them in Rust
> unless intentionally redesigning. Also note: `ProcessManager` (the only publisher) is barely
> used by the GUI in practice — the RepoCard spawns its own processes (§21).

Payload variants emitted by ProcessManager:
- `{"name", "status": "starting"}` — before spawn (process_manager.py:58).
- `{"name", "status": "running"}` — immediately after successful `Popen` (process_manager.py:84).
- `{"name", "status": "stopped", "exit_code": <int>}` — after `wait()` returns (process_manager.py:90).
- `{"name", "status": "error", "error": <str(e)>}` — spawn/run failure (process_manager.py:98).
- `{"name", "status": "stopped"}` — successful manual stop (process_manager.py:133).
- `{"name", "status": "error", "error": "Force killed on timeout."}` — kill after stop timeout (process_manager.py:144).
- `{"name", "status": "error", "error": <str(e)>}` — stop failure (process_manager.py:152).

---

## 5. domain/exceptions.py

Exception hierarchy (exceptions.py:5-23) — all extend `DevOpsManagerException(Exception)`:
- `ConfigurationError` — config file / parsing errors.
- `RepositoryDetectionError` — repo cannot be analyzed/classified.
- `ProcessExecutionError` — subprocess failed to start or crashed.
- `ProfileLoadError` — profile cannot be loaded/applied.

In practice these are RARELY raised — the codebase overwhelmingly returns
`(bool, str)` tuples / empty defaults and swallows exceptions. Keep that error model
(Result types in Rust), not exceptions.

---

## 6. application/services/project_analyzer.py — ProjectAnalyzerService

THE primary repo-detection engine (used by `gui/app.py:561` via `detect_repos_for_group`).

### 6.1 Construction & definition loading

- `__init__(config_dir)` (project_analyzer.py:13-15): stores `config_dir`, eagerly loads all
  repo-type definitions ONCE.
- `_load_repo_types()` (project_analyzer.py:17-33):
  - Reads every `*.yml`/`*.yaml` in `<config_dir>/repo_types/` via `YamlParser.load`
    (mtime-cached, §19). Missing dir → empty list.
  - Keeps only documents containing a `type` key.
  - Sorts **descending by `priority`** (missing priority = 0) — higher priority is evaluated
    first; `docker-infra` (priority 0) is the fallback. First match wins per directory.
  - Shipped priorities: spring-boot 60 > nx-workspace 50 > angular 40 > maven-lib 20 >
    react (none ⇒ 0) > docker-infra 0. (react vs docker-infra tie → order then depends on
    filesystem listing order; react beats docker-infra in practice only via detection rules.)

### 6.2 Workspace scan — `detect_repos(workspace_dir)` (project_analyzer.py:35-63)

1. Non-directory workspace → `[]`.
2. Compute `tool_dir` = the analyzer's own project root (project_analyzer.py:40) so the tool
   never detects itself as a repo.
3. Candidates = direct children of `workspace_dir`, **sorted alphabetically**
   (`sorted(os.listdir(...))`), filtered: must be a directory, name must not start with `.`,
   name != `node_modules`, normalized path != `tool_dir` (project_analyzer.py:42-51).
4. **Parallel classification**: `ThreadPoolExecutor(max_workers=min(8, len(candidates)))`,
   using `executor.map` — NOT `as_completed` — because `map` **preserves input order**, so the
   result list stays alphabetical (project_analyzer.py:58-63). Each classification does
   filesystem walks; parallelism matters from ~5 repos up.
5. `None` results (unmatched dirs) filtered out.

### 6.3 Group scan — `detect_repos_for_group(paths)` (project_analyzer.py:65-78)

- Iterates all paths of a workspace group (skips empty/non-dirs), unions results,
  **deduplicates by `repo.path`**, then sorts the combined list by `name.lower()`.

### 6.4 Per-directory classification — `_classify_repo(name, path)` (project_analyzer.py:80-95)

- Builds `files_in_root` = set of plain-file basenames directly in the repo root (one listdir).
- Tests every definition in priority order via `_matches_definition`; first match →
  `_build_repo_info`; no match → `None` (directory ignored).

### 6.5 Matching rules — `_matches_definition` (project_analyzer.py:97-169)

Evaluated in this exact order; ALL must pass:

1. **Git requirement** (`_check_git_requirements`, :120-122): the dir must contain a `.git`
   directory, EXCEPT when the candidate type is `docker-infra` (which may match non-git dirs).
2. **required_files** (`detection.required_files`): every listed filename must exist in root (:124-125).
3. **exclude_files** (`detection.exclude_files`): none may exist in root (:127-128).
4. **Directory heuristics** (:130-139):
   - `heuristics.must_have_directories`: each must be an existing dir (paths may be nested,
     e.g. `src/main/resources`).
   - `heuristics.must_not_have_directories`: none may exist.
5. **Pattern heuristics** (`_check_pattern_heuristics`, :141-169):
   - `heuristics.must_match_patterns` (fnmatch globs): at least one root file must match at
     least one pattern. **Special case spring-boot**: if no root file matched, also scan plain
     files in `src/main/resources/` (project_analyzer.py:149-156) — Spring configs usually live
     there, not at root.
   - **Special case docker-infra** (:160-167): requires at least one root file matching
     `docker-compose*.yml` / `docker-compose*.yaml` (or the definition's own
     `must_match_patterns` if present).
   - NOTE: `heuristics.must_match_package_json` (used by react.yml) is **NOT implemented** —
     it is silently ignored (see §22).

### 6.6 RepoInfo construction — `_build_repo_info` (project_analyzer.py:171-207)

- Copies command fields from YAML `commands`: `install_cmd`, `reinstall_cmd`, `ready_pattern`,
  `error_pattern`, `port_patterns` (default `[]`).
- **Start command resolution** (`_resolve_run_command`, :222-237):
  - Base = `commands.start_cmd`; overridden by `windows_start_cmd` when `os.name == 'nt'`,
    or by `unix_start_cmd` otherwise (only if those keys exist).
  - `{main_app}` placeholder (nx-workspace): if the command contains `{main_app}` and
    `<repo>/apps/` exists, take the **first** (listdir order) non-hidden subdirectory of
    `apps/` (fallback literal `app`), and substitute it **wrapped in double quotes**:
    `npx nx serve {main_app}` → `npx nx serve "cart"`.
- `ui` block → `repo.ui_config`; `features` list → `repo.features`.
- If `docker_checkboxes` ∈ features: `_find_docker_compose_files` (:209-220) collects root
  files matching `docker-compose*.yml`/`.yaml` (fnmatch, non-recursive), sorted.
- **Env file resolution** (`_resolve_env_files`, :273-293):
  - No `env_files.patterns` → `([], [])`.
  - `exclude_dirs` default `{'.git', 'node_modules'}` when key absent.
  - **Fast path**: if `default_dir` set (value `'.'` means repo root) and that dir exists,
    scan ONLY that directory (`_scan_default_dir_env_files`, :239-252): for each plain file,
    first matching pattern wins (break after match), collect path + extract profile.
    If anything found there, return immediately (tree walk skipped).
  - **Fallback**: full `os.walk` from repo root (`_walk_env_files`, :254-265), pruning excluded
    dir names in-place (`dirs[:] = ...`); every (file, pattern) match appends (no break — a file
    matching 2 patterns is appended twice).
  - **Spring 'default' profile**: if repo_type == `spring-boot` and any found file ends with
    `application.yml|.yaml|.properties`, add profile `default`
    (`_has_spring_default`, :267-271).
  - Profiles returned **sorted** alphabetically.
- **Profile extraction from filename** (`_extract_profile_from_filename`, :295-304):
  - Pattern containing `environment` → regex `environment\.?(.*)\.ts` on the filename; capture
    group (may be empty → `default`) is the profile. E.g. `environment.prod.ts` → `prod`,
    `environment.ts` → `default`.
  - Pattern containing `application` → regex `application-(.+)\.(yml|yaml|properties)$`;
    group 1 is the profile. Plain `application.yml` adds nothing here (handled by the
    `default` special-case above).
  - Other patterns (e.g. `.env*`): NO profile extracted by the analyzer.
- Copies env metadata onto the repo: `env_default_dir`, `env_config_writer_type`
  (default `raw`), `env_pull_ignore_patterns`, `env_main_config_filename`, `env_patterns`
  (project_analyzer.py:201-205).

---

## 7. application/use_cases/manage_services_use_case.py

`ManageServicesUseCase` (manage_services_use_case.py:6-22) — nearly vestigial:

- `__init__(process_manager, repos)` — stores the ProcessManager and a `{name: RepoInfo}` map.
- `update_repos(repos)` — replace the map after a rescan.
- `set_logger(log_callback)` — store a global log callback.

It performs no orchestration; the GUI calls service operations directly. In Rust this can be
absorbed by an app-state struct.

---

## 8. core/config_manager.py

Single most-touched backend module. Handles the JSON app config AND Spring/Angular config files.

### 8.1 mtime-based JSON config cache (config_manager.py:13-46) — MUST REPLICATE

- Module-level: `_CONFIG_CACHE: dict[path → parsed dict]`, `_CONFIG_CACHE_MTIME: dict[path → mtime]`,
  one shared `RLock`, `_CONFIG_CACHE_MAX = 30`.
- `_load_config_cached(path)` (:19-39):
  1. `os.path.getmtime(path)`; under the lock, if cached AND cached mtime == current mtime →
     return cached dict (NOTE: returns the cached object itself, not a copy — callers must not
     mutate, except `set_workspace_groups`/`set_active_group` which do; see §22).
  2. Cache miss → read + `json.load` OUTSIDE the lock; then under the lock, if cache size ≥ 30
     evict the OLDEST inserted entry (insertion-order dict, `next(iter(...))` = FIFO eviction);
     store data + mtime.
  3. Any `OSError`/`JSONDecodeError` (incl. file missing) → `{}` (never raises).
- `_invalidate_config_cache(path)` (:42-46): drop both entries. **EVERY write path must call
  this after writing** (project convention).
- `get_app_setting(key, default=None)` (:49-55): cached read of one top-level key.
  Safe pre-GUI.

### 8.2 Config path

`get_config_path()` (:60-65) → `<project_root>/devdeck_config.json` (sibling of `core/`).
The config lives in the INSTALL directory, not in a user-profile dir.

### 8.3 FULL schema of devdeck_config.json

All keys observed in code + the real file at the project root. Everything optional;
readers always default.

| Key | Type | Meaning | Read / written at |
|---|---|---|---|
| `workspace_dir` | `str` (abs path) | Legacy single workspace root; still kept in sync; used to build the migration default group | gui/app.py:76, config_manager.py:331 |
| `language` | `str` (e.g. `"es_ES"`, `"en_EN"`) | UI language, applied on next start | main.py:47, gui/dialogs/settings.py:101,381 |
| `last_profile` | `str` | LEGACY last loaded profile name; migrated into `last_profile_by_group["Default"]` on load (gui/app.py:82-88) | gui/app.py:86 |
| `last_profile_by_group` | `dict[str group → str profile]` | Last loaded profile per workspace group; `""` = none | gui/app.py:83,610; gui/app_profile.py:47-71 |
| `repo_state` | `dict[str repo → obj]` | Per-repo UI state. Object keys: `selected: bool` (checkbox), `custom_command: str` (override of start cmd, `""` = none), `java_version: str` (display label of selected JDK, default `"Sistema (Por Defecto)"`), `expanded: bool` (card expanded; written since recently — older entries lack it) | written gui/app.py:766-776; read gui/app.py:630,648-654 |
| `active_configs` | `dict[str config_key → str name]` | Currently-selected saved environment per config key. `config_key` format: `"repo-name::module-key"` where module-key is the repo-relative POSIX dir of the env files (e.g. `spring-petclinic::src/main/resources`) or `root`. Sentinel for none: the literal string `"- Sin Seleccionar -"` (config_manager.py:406 — hardcoded Spanish, see §22) | config_manager.py:402-428 |
| `repo_configs` | `dict[repo → dict[module → dict[name → content]]]` | Saved alternative config-file contents ("environments") per repo/module. `content` is the full raw file text | config_manager.py:143-254 |
| `repo_config_danger` | `dict[config_key → list[str]]` | Env names flagged "dangerous" (UI shows warning). Stored sorted; key removed when set empty | config_manager.py:368-399 |
| `java_versions` | `dict[label → JAVA_HOME path]` | User-managed JDK registry, label e.g. `"Java 17 (jdk-17)"` | gui/app.py:631, gui/dialogs/settings.py |
| `minimize_to_tray` | `bool` (default `true`) | Minimize hides to system tray | gui/app.py:836,1023; settings.py:132,397 |
| `workspace_groups` | `list[{name: str, paths: list[str]}]` | Named groups of workspace roots. If absent, a virtual default `[{"name":"Default","paths":[workspace_dir]}]` is synthesized (NOT persisted) by `get_workspace_groups` (config_manager.py:323-333) | config_manager.py:323-345 |
| `active_group` | `str` | Name of the active workspace group; `""`/missing → caller falls back to the first group | config_manager.py:348-365 |

Notes:
- There is **NO** persisted window geometry and **NO** `db_presets` key, despite project docs
  claiming both (window is fixed `1300x900` at gui/app.py:100). Decide explicitly in the rewrite.
- File is written with `json.dump(indent=2, ensure_ascii=False)` everywhere.
- `active_group` may name a group that no longer exists in `workspace_groups` (the real file
  shows `"Nuevo Grupo"` while only `"Default"` exists) — readers must tolerate that.

### 8.4 Spring Boot config IO (config_manager.py:70-99)

- `read_spring_config(resources_dir, profile='default')`: reads
  `application.yml` (profile `default`) or `application-{profile}.yml`; YAML-parsed dict;
  missing/broken → `{}`. (Only `.yml`, never `.yaml`/`.properties`.)
- `write_spring_config(resources_dir, profile, config)`: dumps YAML with
  `default_flow_style=False, allow_unicode=True, sort_keys=False`; returns bool.
  (Docstring says "with backup" — **no backup is actually made**.)

### 8.5 Raw config-file IO (config_manager.py:104-130)

- `write_angular_environment_raw(env_file, content) -> bool`
- `read_config_file_raw(filepath) -> str` (`''` on error)
- `write_config_file_raw(filepath, content) -> bool`
All UTF-8, errors swallowed → bool/empty.

### 8.6 Repo configs ("saved environments") (config_manager.py:132-254)

Storage shape (see §8.3 `repo_configs`). `config_key = "repo::module"`; if the key contains no
`::`, it is used flat (legacy).

- `load_repo_configs(config_key, config_path='')` (:143-154): cached read; returns
  `{name: content}` for that repo/module, `{}` if absent.
- `save_repo_configs(config_key, configs_dict, ...)` (:157-186): read-modify-write of the whole
  JSON (direct file read, NOT via cache), replaces `repo_configs[repo][module]` wholesale,
  writes, invalidates cache. Errors swallowed.
- `merge_repo_configs(config_key, configs_dict, ...) -> renames` (:215-254): smart merge used by
  profile import:
  - incoming name not present → add;
  - present with **identical content** → skip;
  - present with **different content** → store under the first free name `repetido1`,
    `repetido2`, … (`_next_repetido_name`, :189-194) and record `{original: newname}` in the
    returned renames dict.
- `_profile_name_from_file(basename, env_patterns)` (:257-286): derive a profile name from a
  filename using the repo-type glob patterns: escape the glob, replace `\*` with `(.*)`, regex
  match, take the wildcard capture, strip leading `-._` separators; empty → `default`.
  Examples: `application*.yml` + `application-dev.yml` → `dev`; `.env*` + `.env.local` → `local`.
- `auto_import_configs(repo_path, repo_type, environment_files, env_patterns)` (:289-317):
  read each existing env file, derive its name as above, return `{name: content}` (empty content
  skipped). Caller must pre-scope `environment_files` to ONE directory to avoid name collisions.

### 8.7 Workspace groups (config_manager.py:320-365)

- `get_workspace_groups()`: returns stored list, or the synthesized Default group (see §8.3).
- `set_workspace_groups(groups)` / `set_active_group(name)`: read the CACHED dict, mutate it,
  dump whole file, invalidate. (Mutating the cached object — works because of the immediate
  invalidate, but racy; fix in Rust with a proper write lock.)
- `get_active_group()`: cached read of `active_group`, default `""`.

### 8.8 Danger flags & active config (config_manager.py:368-428)

- `load_danger_configs(config_key) -> set[str]` / `save_danger_configs(config_key, set)`
  (stores sorted list; deletes the key when the set is empty).
- `load_active_config(config_key) -> str` — default `"- Sin Seleccionar -"`.
- `save_active_config(config_key, name)` — read-modify-write + invalidate.

---

## 9. core/db_manager.py — Docker / MySQL / Flyway

All functions are module-level, synchronous, subprocess-based; ALL docker subprocesses use
`capture_output=True, text=True`, `creationflags=CREATE_NO_WINDOW` on Windows, and a timeout.
Every function returns data/bools and swallows errors. `LogCallback = Optional[Callable[[str], None]]`.

| Function | Command run | Timeout | Returns / parsing |
|---|---|---|---|
| `is_docker_available()` (db_manager.py:12-19) | `docker info` | 10 s | `returncode == 0` |
| `is_container_running(name)` (:23-33) | `docker ps --filter name=<name> --format {{.Names}}` | 10 s | substring `name in stdout` |
| `get_running_containers(project_prefix='')` (:47-64) | `docker ps --format {{.Names}}\t{{.Status}}\t{{.Ports}}` | 10 s | list of `{'name','status','ports'}`; line split on `\t` (`_parse_container_line`, :36-44, needs ≥2 parts; ports optional `''`); if `project_prefix` non-empty, keep only names CONTAINING it |
| `parse_compose_services(compose_file)` (:66-95) | — (YAML parse) | — | list of `{'name', 'image' (falls back to `build` value, else `'unknown'`), 'ports': [str], 'depends_on': [str]}`; `depends_on` handles both list and dict forms |
| `get_compose_service_status(compose_file)` (:97-124) | `docker-compose -f <basename> ps --services --filter status=running` with `cwd=dirname` | 10 s | `{service: "running"|"stopped"}` over ALL services parsed from the file; not-running ⇒ `stopped` |
| `docker_compose_logs(compose_file, service, tail=100)` (:126-138) | `docker-compose -f <f> logs --tail <n> <service>` | 10 s | `stdout + "\n" + stderr` |
| `docker_compose_up(compose_file, services=None, log)` (:141-175) | `docker-compose -f <f> up -d [services...]` | **120 s** | `(returncode==0, stdout+stderr)`; logs `[docker] Starting <svcs|all> from <f>...` then `Services started` / `FAILED - <msg>` |
| `docker_compose_down(compose_file, log)` (:178-205) | `docker-compose -f <f> down` | 60 s | `(ok, msg)`; logs `[docker] Stopping services from <f>...` then `Services stopped` (logged even on failure) |
| `start_mysql(infra_path, log)` (:217-225) | up with services `['mysqldb']` | 120 s | compose file chosen by `_get_compose_file` |
| `stop_mysql(infra_path, log)` (:228-233) | down | 60 s | |
| `run_flyway_seeds(infra_path, log)` (:248-267) | up with all services whose NAME contains `flyway` (case-insensitive) (`_detect_flyway_services`, :236-245) | 120 s | error msg if no compose file / no flyway services |
| `is_mysql_running()` (:270-277) | via `get_running_containers()` | 10 s | true if any container name contains `mysql` or `mysqldb` (case-insensitive) |
| `start_service_compose(compose_file, service, log)` (:280-283) | up `[service]` | 120 s | |
| `stop_service_compose(compose_file, service=None, log)` (:286-310) | `docker-compose -f <f> stop <service>` (60 s) if service given, else full `down` | 60 s | |

`_get_compose_file(infra_path)` (:208-215): glob `docker-compose*.yml` + `docker-compose*.yaml`
in `infra_path`; prefer the first whose PATH contains `mysql`, else first glob result; `""` if none.

NOTE: uses the legacy `docker-compose` v1 binary name, never `docker compose`. Decide in Rust
(probably try `docker compose` with fallback).

---

## 10. core/git_manager.py

All git calls go through `_run_git_command(args, repo_path, timeout=10)` (git_manager.py:17-23):
`subprocess.run(capture_output=True, encoding='utf-8', errors='replace', cwd=repo_path,
timeout=…, creationflags=CREATE_NO_WINDOW)`. No shell. Default timeout 10 s unless stated.

### 10.1 Branch listing & recency

- `get_branches(repo_path, include_remote=True)` (:47-61):
  - `git branch --no-color` → `_parse_local_branches` (:27-34): strip, remove leading `* `,
    skip empty and lines starting with `(` (detached HEAD).
  - if include_remote: `git branch -r --no-color` → `_parse_remote_branches` (:37-44):
    skip lines containing `->` (HEAD alias), strip FIRST `origin/` prefix only.
  - Return `sorted(set(local + remote))`.
- `get_recent_checked_out_branches(repo_path)` (:64-91): `git reflog --format=%gs -n 300`
  (timeout 10 s); for each line match regex `checkout: moving from \S+ to (\S+)`; collect
  capture group de-duplicated, most-recent first. (Works for checkouts done by ANY tool.)
- `order_branches_by_recency(repo_path, branches, limit=7)` (:94-109): take up to `limit`
  recent branches that exist in `branches` (preserving recency order), then the remaining
  branches sorted alphabetically. Returns `(ordered_list, recent_count)` — `recent_count` is
  where the alphabetical section starts (UI draws a separator).

### 10.2 State queries

- `get_current_branch(repo_path)` (:112-120): `git rev-parse --abbrev-ref HEAD` (5 s);
  failure → literal `'unknown'`.
- `get_commit_sha(repo_path, ref='HEAD')` (:123-131): `git rev-parse --verify --quiet <ref>`
  (5 s) → full SHA or `None`.
- `_merge_in_progress(repo_path)` (:134-140): `git rev-parse --verify --quiet MERGE_HEAD`
  rc==0 ⇒ merge half-done.
- `get_commits_behind(repo_path)` (:320-333): `git rev-list --count HEAD..@{u}` (5 s) → int, 0 on any failure.
- `get_status_summary(repo_path)` (:365-390) — THE per-card badge query, single git call:
  `git --no-optional-locks status --porcelain -b --untracked-files=normal` (10 s).
  Returns `{'branch': str, 'behind': int, 'staged': int, 'unstaged': int, 'conflicts': int}`.
  - Header line `## <branch>...<upstream> [ahead N, behind M]` parsed by
    `_parse_status_branch_header` (:336-346): branch = text before `...` and before first space;
    `behind` via regex `behind (\d+)`.
  - Each status line via `_count_status_line` (:349-362): `??` → unstaged+1 (untracked);
    XY in unmerged set `{'DD','AU','UD','UA','DU','AA','UU'}` (:14) → conflicts+1;
    otherwise X≠' ' → staged+1 AND Y≠' ' → unstaged+1 (a file can count in both).
  - `--no-optional-locks` prevents lock contention with IDEs — keep it.
- `get_conflicted_files(repo_path)` (:393-405): `git diff --name-only --diff-filter=U` → list of paths.
- `count_modified_files(repo_path)` (:408-419): `git --no-optional-locks status --porcelain
  --untracked-files=all` (5 s) → count of non-blank lines.
- `get_local_changes(repo_path, ignore_files=None)` (:422-443): same command; for each line take
  `line[3:]` as the path; EXCLUDE files whose **basename** fnmatch-es any pattern in
  `ignore_files` (used with `env_pull_ignore_patterns` so managed config files don't count as dirty).
- `get_remote_url(repo_path)` (:301-317): `git remote get-url origin` (5 s); converts SSH form to
  HTTPS for browser opening: `git@host:org/repo.git` → replace ALL `:` with `/`, `git@`→`https://`,
  strip trailing `.git`. Failure → `None`.
- `has_branch(repo_path, branch)` (:295-298): membership in `get_branches(include_remote=True)`.

### 10.3 Mutating operations

- `fetch(repo_path, log)` (:143-160): `git fetch --all --prune` (timeout **60 s**) →
  `(ok, stdout+stderr)`; logs `[git] Fetching <name>...` / `Fetch <name>: OK|FAILED`.
- `fetch_quiet(repo_path)` (:163-176): `git fetch --quiet` (30 s) → bool. Intentionally lean
  (no --all/--prune) — used by the focus-triggered throttled refresh.
- `pull(repo_path, log)` (:179-203): `git pull --ff-only` (timeout **120 s**) → `(ok, msg)`;
  log message distinguishes `Already up to date`.
- `checkout(repo_path, branch, log)` (:206-242):
  1. If already on branch → `(True, "Already on '<branch>'")` with NO git checkout run.
  2. `git checkout <branch>` (30 s); success → done.
  3. On failure: `git checkout -b <branch> origin/<branch>` (30 s) — creates a local tracking
     branch from remote. Returns `(ok, combined output)`.
- `clone(url, dest, log, progress_callback)` (:256-292): `Popen(['git','clone','--progress',url,dest])`
  with piped text stdout/stderr; reads **stderr** line-by-line (git writes progress there);
  each line logged as `[git] <line>`; `_emit_clone_progress` (:246-253) extracts the integer
  before a `%` (last whitespace token of the part before the first `%`) and calls
  `progress_callback(int)`. Waits for exit; `(rc==0, joined stderr)`.
- `clean_repo(repo_path, log)` (:446-479): destructive discard of all local changes:
  `git add -A` (so untracked files get tracked and removed by reset) → `git reset --hard HEAD` →
  `git clean -fd` (each 30 s). Success = both reset AND clean rc 0.

### 10.4 Merge feature — `merge_branch` (:593-670)

Signature: `merge_branch(repo_path, *, source, source_remote=True, target_mode='current',
target=None, base=None, new_branch=None, pull_target=True, push=False, dirty_ignore=None, log)`.

Returns dict `{'status': 'ok'|'conflict'|'blocked_dirty'|'error'|'ok_push_failed',
'message': str, 'conflicts': [paths], 'dirty': [paths]}`.

Pipeline:
1. **Dirty guard** (`_prepare_merge`, :553-570): `get_local_changes(repo_path, dirty_ignore)`;
   any result → status `blocked_dirty` with the file list; NOTHING is touched.
2. **Fetch** (only if `source_remote`): `git fetch --all --prune` (120 s); failure → `error`.
3. **Position destination** (`_position_merge_destination`, :519-531):
   - `target_mode='current'`: stay on current branch; optional `pull_target` ff-only pull.
   - `'existing'`: `checkout(target)` (required), then optional pull.
   - `'new'` (`_create_merge_new_branch`, :497-516): `checkout(base)` if base given →
     optional ff-pull → `git checkout -b <new_branch>` (30 s). Missing new_branch → error.
   - `_pull_ff_only` (:482-495) is best-effort: a pull failure is logged
     (`[merge] <name>: aviso al hacer pull — …`) but does NOT abort.
4. **Merge** (`_execute_merge`, :573-590): `git merge <ref>` (120 s) where
   `ref = 'origin/<source>'` if source_remote else `<source>`.
   - rc != 0 and `get_conflicted_files()` non-empty → status `conflict`; **the working tree is
     LEFT in the conflicted state** for manual resolution (never auto-aborted).
   - rc != 0, no conflicts → `error`.
5. **Optional push** (`_push_after_merge`, :534-550): `git push` (120 s); on failure retry
   `git push --set-upstream origin <current_branch>` (handles brand-new branches); second
   failure → status `ok_push_failed` (merge stays committed locally).

Log lines (Spanish, prefix `[merge]`): see :513,515,539,547,549,561,564,568,578,586,658.

### 10.5 Merge revert — `revert_merge` (:673-738)

`revert_merge(repo_path, revert_point, log)` where `revert_point` is a snapshot taken BEFORE
the merge mutated anything:
```
{'mode': 'existing'|'new',
 'original_branch': str,
 # existing mode: 'dest': str, 'dest_head_before': full SHA,
 # new mode:      'new_branch': str}
```
Steps (each 30 s timeout, best-effort):
1. If `_merge_in_progress()` → `git merge --abort`.
2. mode `existing` and both `dest`+`dest_head_before` present → `git checkout <dest>`;
   if that succeeds → `git reset --hard <dest_head_before>` (also undoes the pre-merge ff pull).
3. `git checkout <original_branch>` unless original is `unknown`/`HEAD`.
4. mode `new` → `git branch -D <new_branch>`.
Returns `{'status':'ok'}` or `{'status':'error','message':…}`. A push that already reached the
remote is NOT undone.

---

## 11. core/i18n.py — internationalisation

Module-level state (i18n.py:20-26): `_STRINGS` (active language) and `_EN_FALLBACK` (always
en_EN), both flat `dict[str,str]`; `_TRANSLATIONS_DIR = <project_root>/config/translations`.

- `init_i18n(language_code='en_EN')` (:31-46): loads `en_EN.yml` into the fallback; if
  `<code>.yml` exists AND code != en_EN, loads it as active, else active = fallback.
  Must run before any widget exists. Language changes require restart.
- `t(key, **kwargs)` (:49-60): lookup chain **active → en_EN → the raw key itself** (never
  raises, never returns None). If kwargs given, applies `str.format_map(kwargs)`; format errors
  (KeyError/ValueError) silently leave the string unformatted. Keys are dot-namespaced flat
  strings (`btn.*`, `label.*`, `tooltip.*`, `dialog.<name>.*`, `log.*`, `misc.*`, `install.*`)
  with `{placeholder}` interpolation.
- `list_available_languages()` (:63-76): scans `config/translations/*.yml`; each file may have a
  `_meta: {code, name}` mapping; falls back to filename stem / code; returns
  `[{"code","name"}]` sorted by name.
- `_load_yaml(path, keep_meta=False)` (:81-116) — **JSON sidecar cache**: next to each YAML it
  writes `<file>.yml.cache.json`. On load, if the cache file's mtime ≥ the YAML's mtime, the JSON
  is read directly (skipping the YAML parser — startup optimisation). Otherwise parse YAML
  (`safe_load`), coerce every non-dict value to `str`, best-effort write the cache
  (`ensure_ascii=False`), return. `_meta` is stripped unless `keep_meta`. Any error → `{}`.
  Translation files are FLAT key:value YAML (except the optional `_meta` dict).

---

## 12. core/instance_manager.py — single-instance coordination

NOT a lockfile mutex — a **registry + loopback control socket** design allowing graceful
takeover (instance_manager.py module docstring :1-13).

Constants (:22-28): registry dir = `<tempdir>/devdeck_instances/`; host `127.0.0.1`;
wire tokens `PING`/`PONG`/`SHUTDOWN`/`OK` (raw ASCII bytes, ≤16-byte reads); socket timeout
**1.0 s** per round-trip.

`InstanceManager(workspace)` (:34-47):
- `self.workspace` = `os.path.normcase(os.path.abspath(workspace))` — case/separator-insensitive
  comparison (Windows).
- Own registry file: `<registry_dir>/<pid>.json`, content
  `{"pid": int, "port": int, "workspace": str}` (:146-153).
- Creates the registry dir (errors logged, non-fatal).

API:
- `find_other_instances() -> list[dict]` (:51-74): glob `*.json` in the registry; for each:
  unparsable → delete (prune); own pid → skip; different workspace (normcase compare) → skip;
  no port or PING fails → **delete the stale file** (crashed instance) and skip; otherwise keep,
  adding `"_file"` = registry path. Liveness is proven ONLY by an actual PING/PONG round-trip.
- `_ping(port)` (:76-82): connect, send `PING`, expect reply `PONG` (after strip) within 1 s.
- `send_shutdown(instances)` (:84-95): for each instance, connect, send `SHUTDOWN`, read up to
  16 bytes (the `OK`), close. Fire-and-forget; does not wait for the target to die.
- `still_alive(instances)` (:97-99): subset whose port still answers PING (used to poll until gone).
- `start_server(on_shutdown) -> port` (:103-118): bind TCP on `(127.0.0.1, 0)` (ephemeral port,
  `SO_REUSEADDR`), `listen(5)`, write the registry file, then serve on a daemon thread named
  `instance-control`.
- `_serve()` (:120-144): accept loop; per connection set 1 s timeout, read ≤16 bytes, strip:
  `PING` → reply `PONG`; `SHUTDOWN` → reply `OK`, close conn, invoke the `on_shutdown` callback
  (the app's normal `_on_close`: stops all services, saves state) and **break the accept loop**
  (server stops after one shutdown request).
- `cleanup()` (:155-164): set stop flag, close the server socket (unblocks accept), remove own
  registry file.

Protocol intent: a NEW instance starting on the same workspace finds live older instances,
asks them to shut down gracefully, and polls `still_alive` until clear (GUI drives this flow,
gui/app.py:143 + the instance-conflict dialog).

---

## 13. core/java_manager.py — Java detection

- `_java_search_paths()` (java_manager.py:9-25) — JDK base dirs scanned:
  - Windows: `C:\Program Files\Java`, `...\Eclipse Adoptium`, `...\Amazon Corretto`,
    `...\Microsoft`, `...\BellSoft`, `~\.jdks`.
  - POSIX: `/usr/lib/jvm`, `/Library/Java/JavaVirtualMachines` (macOS),
    `~/.jdks`, `~/.sdkman/candidates/java`.
- `_jdk_home(base_dir, entry)` (:28-35): on POSIX, when base contains `JavaVirtualMachines`,
  descend into `<entry>/Contents/Home` if it exists (macOS bundle layout).
- `auto_detect_java_paths() -> {label: java_home}` (:49-71): for each subdirectory of each
  existing base dir, validate via `_java_label` (:38-46): requires `<home>/bin/java[.exe]` to be
  a file AND `java -version` to yield a parsable version. Label format: `"Java {ver} ({dirname})"`.
  Finally, if env `JAVA_HOME` is set and valid, adds it with suffix label `(JAVA_HOME)`.
- `_get_java_version(java_exe)` (:74-94): run `[java_exe, "-version"]` with **timeout 2 s**,
  CREATE_NO_WINDOW; version is printed on **stderr** usually (falls back to stdout); regex
  `(?:java|openjdk) version "([^"]+)"`; simplify: `1.8.0_311` → `8` (take 2nd dot segment when
  starting with `1.`), else first dot segment (`17.0.2` → `17`). Failure → `""`.
- `build_java_env(java_home) -> dict` (:96-107): clone `os.environ`; if java_home is a valid dir,
  set `JAVA_HOME` and PREPEND `<java_home>/bin` to `PATH` (separator `;` on Windows, `:` on POSIX).
  This env dict is passed to service/install subprocesses when the user picked a JDK for a card.

The persisted JDK registry lives in config key `java_versions` (§8.3); the auto-detect feeds
the settings dialog which merges new entries (gui/dialogs/settings.py:507-508: skip if label OR
path already present).

---

## 14. core/logger.py — error logging

- Log file: `<project_root>/error.log` (logger.py:9-12).
- `setup_logging()` (:20-39): idempotent (skips if a RotatingFileHandler already attached).
  Root logger level **ERROR**; `RotatingFileHandler(maxBytes=5*1024*1024, backupCount=3,
  encoding='utf-8')`; format `"%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"`,
  date format `%Y-%m-%d %H:%M:%S`.
- `get_logger(name)` (:42-44): plain `logging.getLogger(name)`.

---

## 15. core/profile_manager.py — workspace profiles

A "profile" = JSON snapshot of the whole workspace state: per-repo git URL, branch, selected
config profile, custom command, Java choice, selection, docker state, and optionally the raw
content of config files + saved environments.

### 15.1 Storage layout

- Root dir: `<project_root>/.devops-profiles/` (`PROFILES_DIR_NAME`, profile_manager.py:14).
- Per-group subdirs: group `Default` (or None) → the root dir itself (backwards compat);
  any other group → `<root>/<sanitized-group>/` (`get_profiles_dir`, :23-35).
  Sanitization (`_sanitize_group_name`, :18-20): replace `<>:"/\|?*` with `_`, strip leading/
  trailing `._`, empty → `default`. Dirs created on demand.
- One file per profile: `<name>.json`.

### 15.2 CRUD

- `save_profile(name, config, group)` (:38-49): injects `config['name'] = name` and
  `config['created'] = datetime.now().isoformat()`, writes pretty JSON, returns the path.
- `load_profile(name, group)` (:52-64): read or `None`.
- `list_profiles(group)` (:67-84): sorted stems of `*.json`. **Backward-compat fallback**: if a
  non-Default group has NO profiles, list the root directory's profiles instead (:79-83).
- `delete_profile(name, group)` (:87-95): bool.
- `export_profile_to_file(profile_data, dest)` (:98-105) / `import_profile_from_file(path)`
  (:108-117): import validates that key `repos` exists, else `None`.

### 15.3 Profile document schema (built by `build_profile_data`, :135-179)

```jsonc
{
  "name": "...",            // injected on save
  "created": "ISO-8601",    // injected on save
  "repos": {
    "<repo-name>": {
      "git_url": "https://…" | "",
      "branch": "feature/x" | null,        // null = branch not tracked by this profile
      "type": "spring-boot",
      "profile": "dev" | null,             // selected env/config profile, null = not tracked
      "profile_tracked": [...],            // card's tracked file list
      "custom_command": "",                // user override of start command
      "java_version": "Java 17 (jdk-17)" | "Sistema (Por Defecto)",
      "selected": true,
      "docker_compose_active": [...],      // only for docker repos
      "docker_profile_services": {...},    // only for docker repos
      // only when include_config_files=true:
      "config_files": { "<rel-dir|''>": { "<filename>": "<full raw content>" } },
      "saved_environments": { "<rel-path-of-env-file>": { "<env-name>": "<content>" } }
    }
  }
}
```
- `_capture_config_files` (:213-225): reads every existing `repo.environment_files` entry,
  grouped by repo-relative POSIX dir (`''` for root) via `_relative_config_dir` (:202-210).
- `_capture_saved_environments` (:182-199): for each env file dir, builds
  `config_key = "<repo>::<dir or 'root'>"` and exports `load_repo_configs(config_key)`.

### 15.4 Applying profiles

- `get_missing_repos(workspace_dir, profile_data)` (:120-132): repos in the profile whose
  `<workspace>/<name>` dir does not exist → `[{'name','git_url','branch' (default 'main')}]`
  (feeds the clone-missing-repos flow).
- `apply_config_files(repo_path, repo_type, config_files, target_env=None)` (:228-246):
  overwrite files on disk from the snapshot; creates directories as needed; per-file errors
  swallowed. (`target_env` accepted but unused.)
- `apply_saved_environments(repo_name, saved_environments) -> renames_by_key` (:249-269):
  merge each env-file's configs into `repo_configs` via `merge_repo_configs` (§8.6);
  returns `{config_key: {orig: renamed}}` for conflicts.
- `apply_config_files_to_repo_configs(repo_name, config_files) -> renames_by_key` (:308-338):
  alternative import that converts on-disk snapshot files into saved environments; profile name
  per file derived by `_derive_profile_name_from_filename` (:272-305):
  strip extension (`.yml/.yaml/.ts/.js/.properties/.json`), strip leading dot, then known
  prefixes `application-`, `application.`, `environment.`, `environment-`, `env-`, `env.` →
  remainder is the name (empty → `default`); bare `application`/`environment`/`env` → `default`;
  anything else → `default`.
- `update_active_configs_for_renames(renames_by_key)` (:341-371): if an `active_configs` entry
  pointed at a name that was renamed during import, repoint it; single read-modify-write +
  cache invalidate.

---

## 16. core/repo_detector.py — LEGACY detector

Older detection path, kept as **fallback only**: `gui/app.py:563` calls it when no
`project_analyzer` was injected (`from core.repo_detector import detect_repos`, gui/app.py:35).

- `detect_repos(workspace_dir)` (repo_detector.py:16-49): sequential (NOT parallel) scan,
  sorted listdir, same skip rules (hidden, `node_modules`) but **does NOT exclude the tool's own
  directory**. For non-git dirs containing docker-compose files it calls
  `_build_docker_infra_repo(...)` (:41) — **this function does not exist anywhere → NameError**.
  Latent bug in the fallback path (§22).
- `_classify_repo(name, path, analyzer=None)` (:72-108): delegates matching/building to a
  `ProjectAnalyzerService`, then performs ENRICHMENTS that the main path never does:
  - `'java_version' in features` → `_extract_java_version_from_pom(path)` (:185-201): regex
    `<java\.version>([^<]+)</java\.version>` then `<maven\.compiler\.source>([^<]+)<…>` over the
    raw pom.xml text.
  - `_extract_main_spring_config(repo, path)` (:52-69): find the first env file whose basename is
    `application.yml|.yaml|.properties`; if `env_default_dir` set and no profiles yet, derive
    profiles via `_detect_spring_profiles` (:112-128) — regex `application-(.+)\.(yml|yaml|properties)$`
    over the resources dir, `default` PREPENDED when a base application file exists; then parse
    the main config: YAML → `_extract_spring_server_info` (:131-140) reads `server.port` (int)
    and `server.servlet.context-path`; `.properties` → `_extract_spring_info_from_props`
    (:143-159) line-parse for `server.port` / `server.servlet.context-path`.
  - re-finds docker-compose files (`docker-compose*.yml` only, prefix/suffix string check, :162-168).
- `_get_git_remote(path)` (:171-183): `git remote get-url origin` (5 s) — defined but unused here.

**Migration decision needed**: the Rust rewrite should implement ONE detector =
ProjectAnalyzerService semantics (§6) PLUS these enrichments (java_version from pom,
server_port/context_path/profile detection), since the GUI consumes those RepoInfo fields
(gui/repo_card/_expand_panel.py:361-362, _header.py:190).

---

## 17. core/service_launcher.py

`ServiceLauncher` (service_launcher.py:18-201) — tracks `{name: RunningService}`; the GUI's
single instance lives at gui/app.py:91 and is shared by all repo cards.

- `__init__` (:21-24): empty dict, a `threading.Lock` (created but **never used** by any method),
  and **`atexit.register(self.stop_all)`** — on interpreter exit every running service is
  stopped (kills whole process trees).
- `get_service(name)` / `get_all_services()` (copy) / `is_running(name)` (:26-39):
  running ⇔ tracked AND `process.poll() is None`.
- `get_status(name)` (:194-201): untracked → `'stopped'`; process alive → `svc.status`;
  dead → `'stopped'`.

### 17.1 Install runner — `start_generic_install(name, repo_path, cmd_str, log, status_callback, java_home="")` (:42-82)

- Refuses if already running; refuses empty cmd (`[svc] No install command defined for <name>`)
  or invalid repo dir.
- Env: `build_java_env(java_home)` if a JDK was chosen, else inherit (None).
- Registers `RunningService(status='starting', port=0)` BEFORE spawning; logs
  `[svc] Running installation for <name>: <cmd>` (+ `[svc] Using JAVA_HOME: …`),
  fires `status_callback(name, 'starting')`.
- Worker thread (daemon, name `svc-<name>`) runs `_run_install_service` (:93-125):
  - Spawn (`_spawn_install_process`, :84-91): `Popen(cmd_str, cwd=repo_path, env=env,
    shell=True, stdout=PIPE, stderr=STDOUT, creationflags=CREATE_NO_WINDOW|CREATE_NEW_PROCESS_GROUP
    on Windows, 0 on POSIX)`. **Command is a STRING run through the shell.** Output is BYTES.
  - Stream: `iter(process.stdout.readline, b'')`, decode utf-8 `errors='replace'`, strip,
    forward non-empty lines to `log` verbatim (no prefix).
  - After EOF: `process.wait(timeout=600)` — **10-minute cap**; on `TimeoutExpired` log
    `[svc] ⚠️ <name> install timed out after 10 min, killing process`, `kill()` + `wait(5)`.
  - Always mark stopped (`_mark_stopped`, :149-154: status `'stopped'` + callback), then log
    `[svc] ✅ <name> installed successfully` (rc 0) or
    `[svc] <name> installation finished with exit code: <rc>`.
  - Exceptions → `_mark_install_error` (:127-134): status/callback `'error'`, log
    `[svc] <name> system error: <e>` or `[svc] <name> error: <e>`, plus `logging.error`.

### 17.2 Stop semantics

- `_terminate_process_tree(process)` (:136-147):
  - **Windows**: `taskkill /F /T /PID <pid>` (`capture_output`, timeout 15 s,
    CREATE_NO_WINDOW) — force-kills the ENTIRE tree (shell + mvn + JVM + node…).
  - **POSIX**: `os.killpg(os.getpgid(process.pid), signal.SIGTERM)` — ⚠️ processes are NOT
    started in their own session/process group (no `start_new_session`), so `getpgid(child)`
    is the APP's own process group: this would SIGTERM the app itself on Linux. See §22 (must
    fix in Rust: spawn with setsid / new process group, or use a process-group-per-service).
- `stop_service(name, log, status_callback)` (:156-184): not tracked → log
  `[svc] <name> is not running`, return False. Else log `[svc] Stopping <name>...`,
  terminate tree, `process.wait(timeout=10)`; on subprocess/OS error: `process.kill()`
  fallback, still marked stopped, log `[svc] <name> force-stopped: <e>`, return True.
- `stop_all(log, status_callback)` (:187-192): stop every tracked-and-alive service
  (also the atexit hook).

NOTE: the GUI inserts services it spawned itself directly into `launcher._services`
(gui/repo_card/_actions.py:282) so `stop_service`/`stop_all`/atexit cover them too.

---

## 18. infrastructure/process/process_manager.py

`ProcessManager` (process_manager.py:19-161) — the EventBus-integrated process runner.
Instantiated in main.py:83 and handed to the app; **largely parallel** to ServiceLauncher
(the repo cards mostly use their own spawn path — see §21).

- `__init__` (:25-28): `{name: RunningService}`, `threading.Lock` (used here, unlike
  ServiceLauncher), `atexit.register(self.stop_all)`.
- `register_service` / `get_service` / `is_running` (:30-42) — all lock-guarded.
- `start_process(service, cmd: list, cwd, env=None, log_callback=None) -> bool` (:44-69):
  - Already running → log `[sys] <name> is already running.`, False.
  - Register, set status `starting`, publish `SERVICE_STATUS_CHANGED {starting}`.
  - Daemon thread `proc-<name>` runs `_process_run_loop` (:71-100):
    - creationflags = `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` on Windows, 0 on POSIX.
    - `Popen(cmd, cwd=cwd, env=env, stdout=PIPE, stderr=STDOUT,
      shell=(os.name=='nt' and cmd[0] in ('npm','npx','mvn','mvnw.cmd')))` — cmd is a LIST;
      shell only on Windows for those four launchers (they are .cmd shims needing the shell).
    - status `running` + publish; stream output (`_stream_process_output`, :102-106): bytes →
      utf-8 replace → strip → `log_callback("[<name>] <line>")`.
    - `process.wait()` (no timeout) → status `stopped` + publish with `exit_code`; log
      `[sys] <name> process exited (code <rc>)`.
    - Spawn/run errors → status `error` + publish with `error`, log
      `[sys] Error starting <name>: <e>`.
- `stop_process(name, log_callback)` (:108-153):
  - Untracked → `[sys] <name> is not running.`, False.
  - Log `[sys] Stopping <name>...`; Windows: `taskkill /F /T /PID <pid>` (timeout 10 s);
    POSIX: `os.killpg(os.getpgid(pid), SIGTERM)` (same caveat as §17.2).
  - `process.wait(timeout=5)` → status `stopped` + publish, True.
  - `TimeoutExpired` → `process.kill()`, status `error` + publish
    `"Force killed on timeout."`, returns **False**.
  - Other errors → status `error` + publish, False.
- `stop_all()` (:155-161): snapshot names under lock, stop each alive one (atexit hook).

---

## 19. infrastructure/config parsers

### yaml_parser.py
- Module-level `_YAML_CACHE: {filepath: (mtime, data)}` (yaml_parser.py:7) — mtime-based,
  unbounded, NOT thread-locked (safe enough under CPython GIL for dict get/set; give it a lock
  in Rust). Used heavily by repo-type definition loading during scans.
- `YamlParser.load(filepath)` (:13-30): missing file → None; cache hit on equal mtime;
  `yaml.safe_load`; parse/OS errors → None (and not cached).
- `YamlParser.save(filepath, data)` (:32-40): `yaml.dump(default_flow_style=False,
  sort_keys=False)` → bool. (Save does NOT invalidate the cache — stale-read risk if a saved
  file is re-loaded within the same mtime second; see §22.)

### properties_parser.py
- `PropertiesParser.load(filepath)` (properties_parser.py:8-25): line-based Java .properties
  reader; skips blank lines, `#` comments, lines without `=`; splits on FIRST `=`; trims both
  sides; returns dict or None. (No support for `:` separators, escapes, or line continuations.)
- `JsonStore` (:27-47): trivial JSON load (`{}` on error) / save (`indent=4`) — generic helper,
  not used for the main config.

---

## 20. Repo-type YAML definition schema

One file per framework in `config/repo_types/`. Adding a file = new supported repo type, zero
code changes. Full key reference (all optional unless noted):

```yaml
type: "spring-boot"          # REQUIRED — repo_type identifier
priority: 60                  # match order, higher first; missing = 0

detection:
  required_files: [..]        # ALL must exist as plain files in repo root
  exclude_files: [..]         # NONE may exist in repo root

heuristics:
  must_have_directories: [..]      # all must exist (relative paths ok)
  must_not_have_directories: [..]  # none may exist
  must_match_patterns: [..]        # fnmatch globs; ≥1 root file must match
                                   # (spring-boot also checks src/main/resources)
  must_match_package_json: [..]    # ⚠️ DECLARED in react.yml but NOT IMPLEMENTED

commands:
  install_cmd: "npm i"
  reinstall_cmd: "rmdir /s /q node_modules & npm i"   # ⚠️ Windows-only syntax in shipped files
  start_cmd: "npx ng serve"
  windows_start_cmd: "..."    # overrides start_cmd on Windows
  unix_start_cmd: "..."       # overrides start_cmd on POSIX
  stop_cmd: "..."             # declared in docker-infra.yml; NOT read by any code
  ready_pattern: "Started \\w+ in"        # regex → status starting→running
  error_pattern: "Application run failed" # regex → status starting→error
  port_patterns: ["Tomcat ... port.*?(\\d+)"]  # regexes, group(1)=port

env_files:
  default_dir: "src/main/resources"   # "." = repo root; scanned first, tree-walk fallback
  config_writer_type: "spring"        # raw | spring | angular (how GUI writes configs)
  pull_ignore_patterns: ["application*.yml"]  # files ignored in dirty checks
  main_config_filename: "application.yml"
  patterns: ["application*.yml", ...]  # fnmatch globs for env files
  exclude_dirs: [".git", "node_modules", "target"]  # pruned during tree walk

ui:                            # passed through verbatim to RepoInfo.ui_config
  icon: "🍃"
  color: "#22c55e"
  selectors: [{label: "App:"}]
  install:
    check_dirs: ["target"]     # if all exist, repo counts as "installed" (skip auto-install)

features: ["java_version", "docker_checkboxes"]
```

Shipped definitions (config/repo_types/):

| File | type | priority | detection highlights | ready_pattern | error_pattern |
|---|---|---|---|---|---|
| spring-boot.yml | spring-boot | 60 | pom.xml + dir src/main/resources + `application*.{yml,yaml,properties}` | `Started \w+ in` | `Application run failed` |
| nx-workspace.yml | nx-workspace | 50 | package.json + nx.json; start `npx nx serve {main_app}` | `localhost:\d+\|Local:.*http\|compiled\|Listening on` | `Error:` |
| angular.yml | angular | 40 | package.json + angular.json | `compiled successfully\|build at` | `Error:` |
| maven-lib.yml | maven-lib | 20 | pom.xml + dir src + NOT dir src/main/resources; start == install (`mvn clean install -DskipTests -B`; mvnw variants per OS) | `BUILD SUCCESS` | `BUILD FAILURE` |
| react.yml | react | (0) | package.json, exclude angular.json+nx.json (+ unimplemented package.json content check) | `compiled successfully\|Compiled\|localhost:\d+` | `Failed to compile` |
| docker-infra.yml | docker-infra | 0 | no .git required; ≥1 `docker-compose*.{yml,yaml}` at root; feature `docker_checkboxes` | — | — |

Port patterns shipped (one capture group each):
- spring-boot: `Tomcat (?:started on|initialized with) port.*?(\d+)`,
  `http://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[:\s]+(\d+)`
- angular/nx: `Local:\s*http://localhost:(\d+)`, `http://localhost:(\d+)`,
  (nx adds `Listening on.*?(\d+)`)
- react: `Local:\s*http://localhost:(\d+)`, `http://(?:localhost|127\.0\.0\.1):(\d+)`,
  `(?:listening on|bound to).*?port\s+(\d+)`

GUI fallback when a type declares no port_patterns (gui/constants.py:31-35):
`http://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)` and
`(?:listening on|bound to).*?port\s+(\d+)`.

---

## 21. Cross-cutting: process lifecycle contract

How a service actually starts/stops end-to-end today (the Rust backend must own all of this):

### 21.1 Spawn (service start — currently done IN THE GUI, gui/repo_card/_actions.py)

- `_create_subprocess(cmd_str, cwd, env=None, shell=True)` (gui/repo_card/_actions.py:16-25):
  `Popen(cmd_str, cwd=repo.path, env=env, shell=True, stdout=PIPE, stderr=STDOUT,
  creationflags=CREATE_NO_WINDOW|CREATE_NEW_PROCESS_GROUP on Windows / 0 on POSIX)`.
  - Command is the resolved `repo.run_command` (or the user's custom command), a SHELL STRING.
  - `env`: `build_java_env(selected JAVA_HOME)` for Java repos, else inherited.
  - stdout+stderr merged into one byte stream.
- The spawned service is registered into `ServiceLauncher._services` as a
  `RunningService(status='starting')` (gui/repo_card/_actions.py:279-282) so stop/restart/atexit
  work through the launcher.

### 21.2 Status state machine

- `starting` set immediately at spawn.
- If the repo type has NO `ready_pattern` → jump straight to `running`
  (gui/repo_card/_actions.py:285-286,338-339).
- Otherwise each streamed log line is tested (gui/repo_card/_git.py:304-317), ONLY while status
  is `starting`: `error_pattern` match (re.search) → `error`; `ready_pattern` match → `running`.
- Port detection per line (gui/repo_card/_git.py:286-302): skipped if `server_port` already
  known; tries `repo.port_patterns` else the fallback list, `re.search(..., re.IGNORECASE)`,
  `int(group(1))` → updates `repo.server_port` live.
- ANSI escapes are stripped from log lines with `\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`
  (gui/repo_card/_actions.py:13).
- Process exit: after the stream EOFs, `process.wait(timeout=30)` then kill if needed
  (gui/repo_card/_actions.py:290-297). Final status: `stopped` if the user stopped it manually
  (`_is_stopping_manually` flag) or if it had reached `running`; `error` if it died while still
  `starting` (gui/repo_card/_actions.py:299-304).

### 21.3 Stop

GUI stop → `ServiceLauncher.stop_service` (§17.2): Windows `taskkill /F /T /PID` (tree kill),
POSIX `killpg(SIGTERM)` (broken — see §22), wait 10 s, `kill()` fallback.

### 21.4 Exit cleanup

THREE layers ensure no orphans:
1. `atexit` hooks on both `ServiceLauncher.stop_all` (service_launcher.py:24) and
   `ProcessManager.stop_all` (process_manager.py:28).
2. App `_on_close` stops everything explicitly then `os._exit(0)` (gui/app.py:1110-1119).
3. The fatal-exception hook ends with `os._exit(1)` (main.py:36) — NOTE `os._exit` SKIPS atexit
   hooks, so the fatal path relies on the explicit stop in `_on_close` not the hooks; in the
   fatal path orphans CAN survive. Replicate deliberately or improve.

### 21.5 Subprocess conventions (apply to EVERY spawn in the codebase)

- Windows: always `creationflags=CREATE_NO_WINDOW` (no console flash); long-lived services also
  get `CREATE_NEW_PROCESS_GROUP`.
- Decoding: utf-8 with `errors='replace'` everywhere.
- Timeouts (summary): git status/queries 5–10 s; git fetch 60 s (quiet 30 s); git
  pull/merge/push/clone-related 120 s; checkout/reset/clean/branch ops 30 s; docker queries 10 s;
  compose up 120 s; compose down/stop 60 s; java -version 2 s; install wait cap 600 s;
  service stop wait 10 s (launcher) / 5 s (ProcessManager); taskkill 15 s / 10 s.

---

## 22. Edge cases, gotchas, and known divergences

1. **POSIX kill bug (must fix in rewrite)**: services/installs are spawned WITHOUT
   `start_new_session`/`preexec_fn`, but stop uses `os.killpg(os.getpgid(child))`
   (service_launcher.py:147, process_manager.py:129). Since the child shares the app's process
   group on POSIX, this SIGTERMs the whole app, including itself. Windows (taskkill /T) is fine.
   In Rust: spawn each service in its own process group/session and kill that group.
2. **Phantom events**: only `SERVICE_STATUS_CHANGED` exists. `REQUEST_*` events from project
   docs were never implemented (§4.1).
3. **Legacy detector is broken**: `core/repo_detector.py:41` calls undefined
   `_build_docker_infra_repo` → NameError whenever the fallback path scans a non-git dir with
   compose files. Only reachable when `project_analyzer` is None (gui/app.py:563).
4. **Enrichment gap**: the MAIN detection path never populates `RepoInfo.java_version`,
   `server_port`, `context_path`, `git_remote_url` (those extractions live only in the legacy
   detector, §16). The app works because the port is re-detected from logs at runtime and
   git URL is fetched on demand — but `label.java_recommended` and the static port badge are
   effectively dead on the main path. The rewrite should merge both behaviours.
5. **`must_match_package_json`** (react.yml) is declared but not implemented — react currently
   matches ANY package.json repo without angular.json/nx.json (§6.5).
6. **`commands.stop_cmd`** (docker-infra.yml) is declared but never read by code; docker repos
   are stopped via `docker_compose_down` instead.
7. **Windows-only `reinstall_cmd`** in shipped YAMLs (`rmdir /s /q node_modules & npm i`) —
   broken on POSIX; there is no `windows_/unix_` variant mechanism for install/reinstall cmds
   (only for start_cmd).
8. **Hardcoded Spanish sentinel** `"- Sin Seleccionar -"` is a persisted MAGIC VALUE in
   `active_configs` (config_manager.py:406) — it appears inside user config files; the rewrite
   must keep reading it (or migrate it) regardless of UI language. Several backend log strings
   are also Spanish (`git_manager.py:451,467-469,494,513,561…`, `_actions.py:261,308`).
9. **Config cache returns shared mutable dicts** (config_manager.py:27) — callers like
   `set_workspace_groups` mutate the cached object before writing (config_manager.py:340-345).
   Correct today only because writes immediately invalidate; use copy-on-read or proper locking
   in Rust.
10. **mtime granularity**: all three caches (JSON config, YAML parser, i18n sidecar) trust mtime
    equality; sub-second double-writes can serve stale data. `YamlParser.save` never invalidates
    its own cache (§19).
11. **i18n sidecar cache** writes `<file>.yml.cache.json` NEXT TO the translation files —
    the install dir must be writable; failures are silent (works read-only, just slower).
12. **Profile fallback semantics**: a custom group with no profiles silently lists the root
    (Default) profiles (profile_manager.py:79-83) — intentional backwards compatibility.
13. **`docker-infra` matches without `.git`** (project_analyzer.py:120-122) — the only type that
    does; all other types REQUIRE a `.git` directory regardless of their detection rules.
14. **Tool self-exclusion** only exists in the main analyzer (project_analyzer.py:40,49);
    the workspace default is the tool's PARENT directory (main.py:62), so without it the tool
    would try to classify itself.
15. **`{main_app}` resolution** picks the first `apps/` subdir in raw listdir order — on a
    different filesystem the chosen nx app can change; quote-wrapping is included in the
    substitution (project_analyzer.py:230-235).
16. **Spring 'default' profile** is added by the analyzer only when a base
    `application.yml|yaml|properties` exists; the legacy detector PREPENDS `default` instead of
    sorting — ordering differs between paths (§6.6 vs repo_detector.py:124-127).
17. **Install "is installed" check**: all `ui.install.check_dirs` must exist; with NO check_dirs
    the repo always counts as installed (skip auto-install) — gui/repo_card/_actions.py:43-51.
18. **clone progress** parses percentages from git's STDERR lines; stdout is ignored entirely
    (git_manager.py:271-277).
19. **`get_status_summary` counts a renamed/partially staged file in BOTH staged and unstaged**
    (git_manager.py:359-362) — by design; keep parity to avoid badge regressions.
20. **`checkout` remote fallback hardcodes `origin/`** (git_manager.py:226) — multi-remote setups
    only work with origin; same for merge's `origin/<source>` ref (git_manager.py:642).
21. **InstanceManager server stops after handling ONE SHUTDOWN** (instance_manager.py:137 break)
    — fine because the app is closing, but PINGs after a shutdown request go unanswered, so
    `still_alive` polling naturally converges.
22. **Registry pruning is a side effect of discovery** (instance_manager.py:62-71): crashed
    instances are cleaned the next time ANY instance scans — there is no separate GC.
23. **No persisted window geometry / db_presets** despite docs claiming both (§8.3).
24. **error.log lives in the install dir** (logger.py:9) — same writability caveat as the i18n
    cache; rotation 5 MB × 3 backups.
