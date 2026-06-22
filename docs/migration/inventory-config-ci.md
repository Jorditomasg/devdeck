# Inventory — Configuration Formats, Packaging & CI/CD

**Purpose**: exhaustive contract for the Tauri 2 (Rust + Angular) rewrite of DevDeck.
This document stands alone: it captures every config schema, design token, translation key,
persistence format, script behavior and CI/CD detail of the current Python implementation.

Sources inventoried (all paths relative to repo root `devdeck/`):

| Area | Files |
|---|---|
| Repo-type definitions | `config/repo_types/{angular,docker-infra,maven-lib,nx-workspace,react,spring-boot}.yml` |
| Translations | `config/translations/en_EN.yml`, `config/translations/es_ES.yml` |
| UI theme | `config/ui_theme.yml` (merged over defaults in `gui/theme.py`) |
| User config | `devdeck_config.json` (repo root, gitignored), `.devops-profiles/*.json` (gitignored) |
| CI/CD | `.github/workflows/build-and-sign.yml`, `installer.iss` |
| Scripts | `scripts/win/*`, `scripts/linux/*` |
| Toolchain | `pyproject.toml`, `.python-version`, `uv.lock`, `.gitignore` |

---

## 1. Repo-Type YAML Schema (`config/repo-types/*.yml`)

> **v2 schema (`schema_version: 2`).** This section documents the schema that
> shipped with the Tauri rewrite. It is NOT the v1 Python schema (which used
> `detection` / `heuristics` / `commands` / `env_files` / `features` /
> `ui.install.check_dirs`). The v1→v2 field mapping is in §1.2. Authoritative
> source of truth: the design doc
> `docs/superpowers/specs/2026-06-21-repo-types-v2-design.md` and the Rust
> structs in `src-tauri/src/domain/repo_type.rs`.

This is the heart of config-driven extensibility. The v2 redesign draws a hard
boundary between **data** and **behavior**:

- **Data** (marker files, commands, log patterns, ports, restart delay, icons,
  UI hints) lives in YAML.
- **Behavior** (how to write a config file, how to enrich a repo, how to resolve
  which app to run in a monorepo, which action buttons exist) is pluggable code
  **selected by name from YAML** through single-location registries.

**Extensibility model:**

- **Adding a framework that reuses existing strategies = pure YAML, zero code.**
  Drop a new `config/repo-types/<type>.yml` declaring marker files, commands,
  log patterns and a known `config.writer` — detection, loading, env handling
  and card rendering are all generic over the def. (See §1.5 for a Go example.)
- **Adding genuinely new behavior = one entry in a single registry.** Each new
  config writer / enricher / app-resolution strategy / UI action requires
  exactly one impl + one line in its registry; everything else stays declarative.

The single extension points (the only places code is touched to add behavior):

| Behavior | Single extension point | Registry symbol |
|---|---|---|
| Config writers (`config.writer`) | `src-tauri/src/config/writers.rs` | `writers()` (+ `ConfigWriter` trait, `writer_exists`) |
| Repo enrichers (`enrich`) | `src-tauri/src/detection/enrich.rs` | `enrichers()` (+ `Enricher` trait, `enricher_exists`) |
| App-resolution strategies (`run.app_resolution.strategy`) & UI actions (`ui.actions`) | `src-tauri/src/detection/validate.rs` | `KNOWN_STRATEGIES` / `KNOWN_ACTIONS` (validation gate); strategy dispatch in `detection/builder.rs::resolve_app` |
| UI action buttons | `src/app/features/workspace/repo-card/repo-card.actions.ts` | `REPO_CARD_ACTIONS` (+ `resolveActions`) |

### 1.1 Loading & validation rules

Implemented in `src-tauri/src/config/repo_types_loader.rs` +
`src-tauri/src/detection/validate.rs`:

- Every `*.yml` / `*.yaml` under the bundled `config/repo-types/` resource and the
  user override dir is loaded; bundled and user defs are merged.
- `schema_version: 2` is **mandatory.** A file with a missing/other version is
  logged as an error and **dropped** (not silently kept).
- A file **without a top-level `type` key** is logged and skipped.
- After parsing, the merged set is **validated** (`validate::validate_all`).
  Unlike v1 (which silently dropped broken YAML), v2 surfaces precise errors and
  **drops any def that fails validation** so detection never matches a broken
  type. Each of these is a logged error + drop:
  - unknown `config.writer` (not in the writers registry),
  - unknown `enrich` strategy (not in the enrichers registry),
  - unknown `run.app_resolution.strategy` (not in `KNOWN_STRATEGIES`),
  - unknown `ui.actions` entry (not in `KNOWN_ACTIONS`),
  - any invalid regex in `logs.ready` / `logs.error` / `logs.ports`,
  - wrong `schema_version` / empty `type`.
- Definitions are sorted by `priority` **descending**; first matching definition
  wins. Every shipped def has an explicit, unique priority (no ties): spring-boot
  60 > nx-workspace 50 > angular 40 > maven-lib 20 > react 10 > docker-infra 0.

### 1.2 Field mapping v1 → v2

The v2 schema reorganizes the flat v1 blocks into six intent-based blocks
(`detect / run / logs / config / enrich / ui`). OS command overrides are now
**nested** (`{ default, windows, unix }`) instead of flat `windows_*`/`unix_*`
keys. Three formerly hardcoded `if repo_type == "..."` behaviors became data
(`run.restart_delay_ms`, `config.editable`, `ui.actions`) and one became a named
strategy (`run.app_resolution`).

| v1 | v2 |
|---|---|
| `detection.required_files` / `exclude_files` | `detect.files.required` / `.excluded` |
| `detection.allow_no_git: true` | `detect.git_required: false` (inverted; default `true`) |
| `heuristics.must_have_directories` / `must_not_have_directories` | `detect.dirs.required` / `.excluded` |
| `heuristics.must_match_patterns` | `detect.patterns.match` |
| `heuristics.pattern_search_dirs` | `detect.patterns.search_dirs` |
| `heuristics.must_match_package_json` (was a DEAD key in v1) | `detect.package_json` (now actually enforced — react uses it) |
| `commands.install_cmd` / `reinstall_cmd` (+ `windows_/unix_` variants) | `run.install` / `run.reinstall` — nested `{ default, windows, unix }` |
| `commands.start_cmd` (+ `windows_/unix_start_cmd`) | `run.start.{ default, windows, unix }` |
| `commands.stop_cmd` (was a DEAD key in v1) | `run.stop.default` (now enforced by the process layer) |
| `commands.ready_pattern` / `error_pattern` / `port_patterns` | `logs.ready` / `logs.error` / `logs.ports` |
| `env_files.config_writer_type` | `config.writer` |
| `env_files.default_dir` / `main_config_filename` | `config.dir` / `config.main_file` |
| `env_files.patterns` / `pull_ignore_patterns` / `exclude_dirs` | `config.patterns` / `config.pull_ignore` / `config.exclude_dirs` |
| `env_files.implicit_default_profile` | `config.implicit_default_profile` |
| `features` | `enrich` |
| `ui.install.check_dirs` (nested) | `ui.install_check_dirs` (flattened) |
| *(hardcoded docker restart delay in `process.rs`)* | `run.restart_delay_ms` (data) |
| *(hardcoded docker config/env hiding in `repo-card`)* | `config.editable` (data) |
| *(hardcoded docker seed button in `repo-card`)* | `ui.actions` (data) + action registry |
| *(hardcoded Nx `apps/` + alphabetical in `resolve_main_app`)* | `run.app_resolution` (named strategy) |

### 1.3 Full schema (serde model)

Mirrors the `RepoTypeDef` sub-structs in `src-tauri/src/domain/repo_type.rs`.
`RepoTypeDef` keeps snake_case YAML keys (it is parsed from YAML and never
serialized to the frontend — only `RepoInfo` is camelCased on the wire). Every
block/field has a sensible default, so a minimal YAML still parses.

```
RepoTypeDef {
  schema_version: u32                   // REQUIRED == 2 (loader rejects anything else)
  type: String                          // REQUIRED. Unique id ("spring-boot", "angular", ...)
  priority: i32 = 0                     // higher = evaluated first

  detect: {                             // everything about matching a dir to this type
    git_required: bool = true           // `.git/` dir required unless false (docker-infra)
    files:    { required: [String]=[], excluded: [String]=[] }   // exact root filenames
    dirs:     { required: [String]=[], excluded: [String]=[] }   // relative dirs (isdir)
    patterns: { match: [String]=[],    search_dirs: [String]=[] }// fnmatch globs + fallback dirs
    package_json: [String] = []         // dependency gate: deps that must be in package.json
  }

  run: {                                // lifecycle commands & process behavior
    install:   OsCommand                // { default?, windows?, unix? }; resolved() picks per-OS
    reinstall: OsCommand
    start:     OsCommand
    stop:      OsCommand
    restart_delay_ms: Option<u64>       // None ⇒ caller default (300 ms); docker ships 2000
    app_resolution: Option<{            // generalizes the v1 Nx-only {main_app}
      placeholder: String               //   token in run.start to replace, e.g. "main_app"
      scan_dir:    String               //   dir scanned for candidate apps, e.g. "apps"
      strategy:    String               //   "first_alphabetical" | "single_dir" (validated)
    }>
  }

  logs: {                               // output parsing
    ready: Option<String>               // regex; matching log line ⇒ status "running"
    error: Option<String>               // regex; matching log line ⇒ status "error"
    ports: [String] = []                // regexes with ONE capture group = detected port
  }

  config: {                             // env/config file discovery + write strategy
    writer: String = "raw"              // NAMED writer strategy: raw | spring | angular | …
    dir:    String = ""                 // preferred env/config dir ("." = repo root)
    main_file: String = ""              // file the ACTIVE environment content is written into
    patterns:    [String] = []          // globs identifying env/config files; [] disables handling
    pull_ignore: [String] = []          // globs of env files ignored in git-dirty checks before pull
    exclude_dirs: Option<[String]>      // null ⇒ default {".git","node_modules"}; [] ⇒ prune nothing
    implicit_default_profile: bool=false// spring: add `default` when a base application.* exists
    editable: bool = true               // false ⇒ repo exposes no editable env/config (docker-infra)
  }

  enrich: [String] = []                 // NAMED enrichers (registry): "java_version" | "docker_checkboxes"

  ui: {                                 // presentation hints (passthrough to RepoInfo.uiConfig)
    icon:  Option<String>               // emoji on the card header
    color: Option<String>               // hex accent for the type label
    selectors: [{ label: String }] = [] // selectors[0].label = caption of the env/profile combo
    install_check_dirs: [String] = []   // dirs whose existence == "dependencies installed"
    actions: [String] = []              // NAMED action buttons (registry): e.g. ["seed"]
    // unknown YAML keys round-trip through a flattened `extra` map
  }
}
```

### 1.4 Detection, command resolution, env & enrichment semantics

**Detection order** (`src-tauri/src/detection/pipeline.rs::matches_definition`,
behavior-preserving port of v1):

1. **Git gate**: the candidate dir must contain `.git/` unless `detect.git_required:
   false` (data — no longer a `type == "docker-infra"` hardcode).
2. `detect.files.required` — every name must exist as a file in the repo root.
3. `detect.files.excluded` — none may exist in the repo root.
4. `detect.dirs.required` / `detect.dirs.excluded` — checked with `is_dir` relative
   to the repo root.
5. `detect.patterns.match` — ≥1 root file matches ≥1 glob (`fnmatch`); if none match,
   the `detect.patterns.search_dirs` fallback dirs are scanned (this generalizes v1's
   hardcoded spring-boot `src/main/resources/` fallback). docker-infra now expresses
   its compose-file requirement purely as `detect.patterns.match` with
   `git_required: false` — no hardcoded special case remains.
6. `detect.package_json` — when non-empty, the listed deps must appear in the repo's
   `package.json` (react gate; v1 declared this but never enforced it).

First def in priority-desc order passing all gates wins.

**Command resolution** (`detection/builder.rs`): `OsCommand::resolved()` picks the
`windows`/`unix` override when present, else `default`. When `run.app_resolution` is
set and `run.start` contains the `{placeholder}` token, the token is replaced by the
app resolved from `scan_dir` via the named `strategy`:
- `first_alphabetical` — first non-hidden subdir of `scan_dir`, alphabetically (the
  v1 Nx behavior; default fallback for any strategy).
- `single_dir` — the sole subdir.

`from_workspace_file` is intentionally NOT yet implemented and is therefore NOT in
`KNOWN_STRATEGIES` — a YAML declaring it fails validation rather than silently
falling through. (Re-add the name the day its dispatch arm lands in `resolve_app`.)

The user can still override the resolved command per-repo (`custom_command`, §4).

**Install / restart**: `is_installed` probes `ui.install_check_dirs` (all must exist;
empty list ⇒ always installed); installed repos prefer `run.reinstall` over
`run.install`. The card restart delay is `run.restart_delay_ms` (default 300 ms;
docker-infra ships 2000), read in `commands/process.rs::restart_delay` — no
`type == "docker-infra"` branch.

**`config` (env files) semantics** are unchanged from v1 in behavior, now read from the
`config` block: `config.patterns ==
[]` ⇒ no env files/profiles; a present `config.dir` is scanned non-recursively first,
else a full walk pruning `config.effective_exclude_dirs()` (the `exclude_dirs`
absent-vs-empty distinction: `null` ⇒ `{.git, node_modules}`, `[]` ⇒ prune nothing).
Writers dispatch through the registry (`config/writers.rs`): `spring` validates YAML
and targets `application.yml`/`application-{profile}.yml`; `angular`/`raw` (and any
unknown name) write verbatim to the target file.

**Enrichers** (`enrich`, `detection/enrich.rs`): each name is looked up in the
`enrichers()` registry and run against the `RepoInfo` (replacing v1's
`if has_feature(...)` chain). Shipped: `java_version` (extracts `<java.version>` /
`<maven.compiler.source>` from `pom.xml`) and `docker_checkboxes` (collects
`docker-compose*.yml|yaml`). The enricher names still travel to the frontend on the
`RepoInfo.features` wire field. (Spring `server.port`/`context-path` extraction and
git-remote resolution remain unconditional, applied to every repo.)

### 1.5 New-framework example (Go) — pure YAML, zero code

```yaml
schema_version: 2
type: go-service
priority: 35
detect:
  files: { required: [go.mod] }
run:
  install: { default: "go build ./..." }
  start:   { default: "go run ." }
logs:
  ready: "listening on|Server started"
  ports: ["(?:listening on|:)(\\d+)"]
config:
  writer: raw
  dir: "."
  patterns: [".env*"]
ui: { icon: "🐹", color: "#00ADD8" }
```

This needs no Rust or Angular change: `raw` writer, no enrichers, no new strategy or
action. The acceptance proof for "scalable" is dropping such a YAML in and rescanning.

### 1.6 Current values per definition

Values as shipped in `config/repo-types/*.yml` (v2). `OsCommand` values show the
`default` form; `unix:`/`windows:` overrides are called out inline.

| Key | `spring-boot.yml` | `nx-workspace.yml` | `angular.yml` | `maven-lib.yml` | `react.yml` | `docker-infra.yml` |
|---|---|---|---|---|---|---|
| `priority` | 60 | 50 | 40 | 20 | 10 | 0 |
| `detect.git_required` | — (default `true`) | — | — | — | — | `false` |
| `detect.files.required` | `pom.xml` | `package.json`, `nx.json` | `package.json`, `angular.json` | `pom.xml` | `package.json` | — |
| `detect.files.excluded` | — | — | — | — | `angular.json`, `nx.json` | — |
| `detect.dirs.required` | `src/main/resources` | — | — | `src` | — | — |
| `detect.dirs.excluded` | — | — | — | `src/main/resources` | — | — |
| `detect.patterns.match` | `application*.yml`, `application*.yaml`, `application*.properties` | — | — | — | — | `docker-compose*.yml`, `docker-compose*.yaml` |
| `detect.patterns.search_dirs` | `src/main/resources` | — | — | — | — | — |
| `detect.package_json` | — | — | — | — | `react`, `react-dom` | — |
| `run.install` | `mvn clean install -DskipTests -B` | `npm i` | `npm i` | `mvn clean install -DskipTests -B` | `npm ci` | `""` |
| `run.reinstall` | — | unix: `rm -rf node_modules && npm i` | — | — | — | — |
| `run.start` | `mvn spring-boot:run` (unix: `./mvnw spring-boot:run`) | `npx nx serve {main_app}` | `npx ng serve` | `mvn clean install -DskipTests -B` | `npm start` | `docker-compose up -d` |
| `run.stop` | — | — | — | — | — | `docker-compose down` |
| `run.restart_delay_ms` | — | — | — | — | — | `2000` |
| `run.app_resolution` | — | placeholder `main_app`, scan_dir `apps`, strategy `first_alphabetical` | — | — | — | — |
| `logs.ready` | `Started \w+ in` | `localhost:\d+\|Local:.*http\|compiled\|Listening on` | `compiled successfully\|build at` | `BUILD SUCCESS` | `compiled successfully\|Compiled\|localhost:\d+` | — |
| `logs.error` | `Application run failed` | — | — | `BUILD FAILURE` | — | — |
| `logs.ports` | `Tomcat (?:started on\|initialized with) port.*?(\d+)`; `http://(?:localhost\|127\.0\.0\.1\|0\.0\.0\.0\|\[::1\])[:\s]+(\d+)` | `Local:\s*http://localhost:(\d+)`; `http://localhost:(\d+)`; `Listening on.*?(\d+)` | `Local:\s*http://localhost:(\d+)`; `http://localhost:(\d+)` | — | `Local:\s*http://localhost:(\d+)`; `http://(?:localhost\|127\.0\.0\.1):(\d+)`; `(?:listening on\|bound to).*?port\s+(\d+)` | — |
| `config.writer` | `spring` | `angular` | `angular` | — (default `raw`) | `raw` | `raw` |
| `config.dir` | `src/main/resources` | `apps/default/src/environments` | `src/environments` | — | `.` | `.` |
| `config.main_file` | `application.yml` | — | — | — | — | — |
| `config.patterns` | `application*.yml`, `application*.yaml`, `application*.properties` | `environment*.ts`, `.env`, `.env.*` | `environment*.ts` | — | `.env*` | `.env` |
| `config.exclude_dirs` | — (null ⇒ `.git`,`node_modules`) | — | — | `[]` (prune nothing) | — | — |
| `config.implicit_default_profile` | `true` | — | — | — | — | — |
| `config.editable` | — (default `true`) | — | — | — | — | `false` |
| `enrich` | `java_version` | — | — | `java_version` | — | `docker_checkboxes` |
| `ui.icon` | 🍃 | 🅰 | 🅰 | 📦 | ⚛️ | 🐳 |
| `ui.color` | `#22c55e` | `#ef4444` | `#ef4444` | `#f97316` | `#61dafb` | `#3b82f6` |
| `ui.selectors[0].label` | `App:` | — | — | — | — | — |
| `ui.install_check_dirs` | `target` | — | — | `target` | — | — |
| `ui.actions` | — | — | — | — | — | `seed` |

> Note: several v1 keys did not survive to the shipped v2 YAMLs because the v2
> structs default them. `pull_ignore` is empty/omitted on every shipped def
> (v1's `pull_ignore_patterns` are not currently re-declared); `run.start` for
> maven-lib has no OS overrides (v1's `mvnw.cmd`/`./mvnw` build commands were
> dropped in favor of the single `mvn` default). `nx-workspace`'s reinstall is
> now a portable unix override (`rm -rf …`) rather than the v1 Windows-only
> `rmdir /s /q`.

### 1.7 Migration gotchas — resolved in v2

The v1 dead keys and hardcodes that this doc previously flagged are now resolved:

1. **`must_match_package_json` is now enforced** (`detect.package_json`,
   `detection/pipeline.rs::check_package_json`) — react no longer matches every
   bare `package.json`.
2. **`stop_cmd` is now enforced** (`run.stop`) — the process layer runs it before
   tree-kill (docker-infra stops containers via `docker-compose down`).
3. **Every def has an explicit, unique priority** — no ties (react is 10).
4. **The hardcoded type-name special cases became schema data**: docker's git
   exemption is `detect.git_required: false`; the spring-boot resources-subdir
   pattern fallback is `detect.patterns.search_dirs`; docker's compose requirement
   is plain `detect.patterns.match`; the spring `default`-profile injection is
   `config.implicit_default_profile`.
5. **The "seed" action is now declared, not hardcoded**: `ui.actions: ["seed"]` +
   the action registry (`repo-card.actions.ts`) resolves it to the
   `run_flyway_seeds` command. The remaining `if repo_type == "docker-infra"` /
   `repoType === 'docker-infra'` literals were all eliminated (the v2 acceptance
   criterion).

---

## 2. Translations (`config/translations/en_EN.yml`, `es_ES.yml`)

### 2.1 Facts

- Format: flat YAML; **keys are literal dot-namespaced strings** (`btn.start:` is one flat
  key, not nested maps), except the nested `_meta` block.
- **381 translatable flat keys per language + `_meta.name` / `_meta.code`** (382 top-level
  YAML keys each). Verified programmatically: **EN and ES are in perfect parity — zero keys
  missing on either side, zero duplicates.**
- `_meta`: `en_EN.yml:1-3` → `name: "English"`, `code: "en_EN"`;
  `es_ES.yml:1-3` → `name: "Español"`, `code: "es_ES"`.
- Interpolation: Python `str.format`-style `{placeholder}` applied via
  `value.format_map(kwargs)` (`core/i18n.py:49-57`). For Angular, map to ICU/runtime params.
- Pluralization: **no ICU plurals** — the app uses explicit key pairs
  (`dialog.confirm_close.message_one` / `message_many`,
  `dialog.instance_conflict.message_one` / `message_many`).
- Fallback: missing key in the active language falls back to the always-loaded `en_EN`
  catalog (`core/i18n.py:21`); a missing key everywhere returns the key itself.
- Language selection: `init_i18n(language_code)` called once in `main.py` before any widget;
  code persisted under `"language"` in `devdeck_config.json`; change requires restart.
- Many values embed emoji/symbols that are part of the UX (e.g. `btn.start: "▶ Start"`,
  `badge.danger_env: "⚠ ENV"`) — port them verbatim.

### 2.2 Namespace inventory (counts per language)

| Namespace | Keys | Content |
|---|---|---|
| `btn.*` | 32 | Buttons (header, global panel, dialogs, java, groups) |
| `install.*` | 5 | Install button states |
| `label.*` | 26 | Static labels, statuses, placeholders in cards/panel |
| `tooltip.*` | 38 | All tooltips (cards, global panel, docker, env danger) |
| `dialog.*` | 223 | Per-dialog: `merge`(42), `settings`(41), `profile`(37), `env_manager`(26), `import`(24), `clone`(12), `workspace_groups`(8), `instance_conflict`(8), `confirm_close`(5), `config_editor`(5), `pull`(4), `reinstall`(2), `docker`(2), `clean`(2), `git`(2), `global_log`(1), `select_file_title`(1), `config`(1) |
| `tray.*` | 4 | System-tray menu |
| `log.*` | 29 | App-generated log lines |
| `misc.*` | 6 | Generic error/warning titles & messages |
| `docker.*` | 14 | Docker-compose dialog |
| `badge.*` | 1 | Danger-env badge |
| `placeholder.*` | 3 | Searchable combo placeholders |
| **Total** | **381** | |

### 2.3 Complete key list (with interpolation placeholders)

Values must be copied verbatim from `config/translations/en_EN.yml` and `es_ES.yml`
(both 435 lines). Every key below exists in BOTH languages.

#### `btn.*` (32 keys)

- `btn.start`
- `btn.stop`
- `btn.restart`
- `btn.pull`
- `btn.pull_all`
- `btn.install_all`
- `btn.clean`
- `btn.merge`
- `btn.save_changes`
- `btn.cancel`
- `btn.close`
- `btn.apply_branch`
- `btn.clear_log`
- `btn.detach_log`
- `btn.config`
- `btn.add_java`
- `btn.autodetect_java`
- `btn.create_shortcut`
- `btn.create_shortcut_win`
- `btn.create_shortcut_linux`
- `btn.manage_java`
- `btn.save`
- `btn.reload`
- `btn.clone`
- `btn.rescan`
- `btn.add_path`
- `btn.remove_path`
- `btn.rename`
- `btn.manage_groups`
- `btn.add_group`
- `btn.delete_group`
- `btn.accept`

#### `install.*` (5 keys)

- `install.label_missing`
- `install.label_ok`
- `install.status_deps_missing`
- `install.in_progress`
- `install.error`

#### `label.*` (26 keys)

- `label.no_profile`
- `label.branch`
- `label.select_all`
- `label.global_panel_title`
- `label.global_branch`
- `label.log_section`
- `label.status.stopped`
- `label.status.running`
- `label.status.starting`
- `label.status.error`
- `label.status.installing`
- `label.loading`
- `label.no_selection`
- `label.tray.running`
- `label.tray.starting`
- `label.ready`
- `label.scanning_status`
- `label.group`
- `label.java`
- `label.java_default`
- `label.java_recommended` — placeholders: `{version}`
- `label.cmd`
- `label.cmd_placeholder`
- `label.status.running_port` — placeholders: `{port}`
- `label.branch_placeholder`
- `label.select_file_to_edit`

#### `tooltip.*` (38 keys)

- `tooltip.config_btn`
- `tooltip.pending_pulls`
- `tooltip.modified_files`
- `tooltip.start_btn`
- `tooltip.stop_btn`
- `tooltip.restart_btn`
- `tooltip.pull_btn`
- `tooltip.clean_btn`
- `tooltip.merge_btn`
- `tooltip.conflict_files`
- `tooltip.expand`
- `tooltip.open_explorer`
- `tooltip.open_repo`
- `tooltip.reload_repo`
- `tooltip.branch_in_profile`
- `tooltip.env_in_profile`
- `tooltip.apply_branch`
- `tooltip.pull_all`
- `tooltip.install_all`
- `tooltip.restart_selected`
- `tooltip.stop_selected`
- `tooltip.start_selected`
- `tooltip.rescan_btn`
- `tooltip.clone_btn`
- `tooltip.settings_btn`
- `tooltip.global_log_btn`
- `tooltip.docker_profile_checkbox`
- `tooltip.mark_danger_off`
- `tooltip.mark_danger_on`
- `tooltip.cmd_entry` — placeholders: `{cmd}`
- `tooltip.docker_manage`
- `tooltip.docker_manage_active`
- `tooltip.workspace_dir` — placeholders: `{path}`
- `tooltip.profile_selector`
- `tooltip.manage_profiles`
- `tooltip.manage_groups`
- `tooltip.modify_config` — placeholders: `{name}`
- `tooltip.danger_env_badge`

#### `dialog.*` (223 keys)

- `dialog.settings.title`
- `dialog.workspace_groups.title`
- `dialog.workspace_groups.groups_label`
- `dialog.workspace_groups.name_label`
- `dialog.workspace_groups.name_placeholder`
- `dialog.workspace_groups.paths_label`
- `dialog.workspace_groups.browse_title`
- `dialog.workspace_groups.new_group_name`
- `dialog.workspace_groups.error_empty_paths` — placeholders: `{names}`
- `dialog.clone.title`
- `dialog.profile.title`
- `dialog.confirm_close.title`
- `dialog.reinstall.title`
- `dialog.global_log.title`
- `dialog.confirm_close.message_one`
- `dialog.confirm_close.message_many` — placeholders: `{count}`
- `dialog.confirm_close.btn_cancel`
- `dialog.confirm_close.btn_confirm`
- `dialog.instance_conflict.title`
- `dialog.instance_conflict.message_one`
- `dialog.instance_conflict.message_many` — placeholders: `{count}`
- `dialog.instance_conflict.detail`
- `dialog.instance_conflict.btn_close_others`
- `dialog.instance_conflict.btn_open_anyway`
- `dialog.instance_conflict.btn_cancel`
- `dialog.instance_conflict.closing`
- `dialog.settings.language_title`
- `dialog.settings.workspace_title`
- `dialog.settings.behavior_title`
- `dialog.settings.shortcut_title`
- `dialog.settings.java_title`
- `dialog.settings.shortcut_desc`
- `dialog.settings.shortcut_desc_win`
- `dialog.settings.shortcut_desc_linux`
- `dialog.settings.language_desc`
- `dialog.settings.minimize_to_tray`
- `dialog.settings.java_none_configured`
- `dialog.settings.java_n_configured` — placeholders: `{count}`
- `dialog.settings.language_restart_title`
- `dialog.settings.language_restart_msg` — placeholders: `{name}`
- `dialog.settings.shortcut_success_title`
- `dialog.settings.shortcut_success_msg` — placeholders: `{path}`
- `dialog.settings.shortcut_unavailable`
- `dialog.settings.shortcut_error`
- `dialog.settings.shortcut_err_link` — placeholders: `{code}`
- `dialog.settings.shortcut_err_qi` — placeholders: `{code}`
- `dialog.settings.shortcut_err_save` — placeholders: `{code}`
- `dialog.clone.url_label`
- `dialog.clone.url_placeholder`
- `dialog.clone.folder_label`
- `dialog.clone.folder_placeholder`
- `dialog.clone.btn`
- `dialog.clone.btn_cloning`
- `dialog.clone.error_no_url`
- `dialog.clone.error_folder_exists` — placeholders: `{name}`
- `dialog.clone.success_title`
- `dialog.clone.success_msg` — placeholders: `{name}`
- `dialog.clone.error_clone_msg` — placeholders: `{msg}`
- `dialog.reinstall.confirm`
- `dialog.config_editor.unsaved_title`
- `dialog.config_editor.unsaved_msg`
- `dialog.config_editor.saved_title`
- `dialog.config_editor.saved_msg`
- `dialog.config_editor.error_save`
- `dialog.profile.section_title`
- `dialog.profile.help_text`
- `dialog.profile.save_current`
- `dialog.profile.name_placeholder`
- `dialog.profile.btn_save`
- `dialog.profile.include_config_files`
- `dialog.profile.saved_list_title`
- `dialog.profile.btn_load`
- `dialog.profile.btn_delete`
- `dialog.profile.btn_export`
- `dialog.profile.import_external`
- `dialog.profile.btn_import`
- `dialog.profile.error_no_name`
- `dialog.profile.overwrite_title`
- `dialog.profile.overwrite_msg` — placeholders: `{name}`
- `dialog.profile.saved_title`
- `dialog.profile.saved_msg` — placeholders: `{name}`
- `dialog.profile.error_no_selection`
- `dialog.profile.error_load_failed` — placeholders: `{name}`
- `dialog.profile.no_changes`
- `dialog.profile.loaded_title`
- `dialog.profile.loaded_msg`
- `dialog.profile.confirm_delete_title`
- `dialog.profile.confirm_delete_msg` — placeholders: `{name}`
- `dialog.profile.export_dialog_title`
- `dialog.profile.exported_title`
- `dialog.profile.exported_msg` — placeholders: `{path}`
- `dialog.profile.error_export_failed`
- `dialog.profile.import_dialog_title`
- `dialog.profile.error_invalid_file`
- `dialog.profile.no_changes_title`
- `dialog.profile.no_changes_identical` — placeholders: `{name}`
- `dialog.profile.change_branch` — placeholders: `{from_val}`, `{to_val}`
- `dialog.profile.change_profile` — placeholders: `{from_val}`, `{to_val}`
- `dialog.profile.changes_clone_repo` — placeholders: `{branch}`, `{name}`
- `dialog.profile.changes_overwrite_files` — placeholders: `{count}`
- `dialog.import.title`
- `dialog.import.section_title`
- `dialog.import.btn_accept`
- `dialog.import.missing_repos_title`
- `dialog.import.clone_missing`
- `dialog.import.overwrite_files` — placeholders: `{count}`
- `dialog.import.map_java_title`
- `dialog.import.java_needs` — placeholders: `{version}`
- `dialog.import.java_used_in`
- `dialog.import.changes_summary`
- `dialog.import.applying_title`
- `dialog.import.preparing`
- `dialog.import.log_detail`
- `dialog.import.changes_header`
- `dialog.import.clone_header`
- `dialog.import.uses_java` — placeholders: `{version}`
- `dialog.import.will_clone` — placeholders: `{branch}`, `{java}`, `{name}`
- `dialog.import.will_overwrite` — placeholders: `{count}`
- `dialog.import.no_changes_selected`
- `dialog.import.completed`
- `dialog.import.btn_close`
- `dialog.import.done_title`
- `dialog.import.applying_configs`
- `dialog.import.btn_applying`
- `dialog.env_manager.title`
- `dialog.env_manager.btn_new`
- `dialog.env_manager.btn_auto_import`
- `dialog.env_manager.select_hint`
- `dialog.env_manager.btn_rename`
- `dialog.env_manager.btn_duplicate`
- `dialog.env_manager.btn_delete`
- `dialog.env_manager.btn_save`
- `dialog.env_manager.editing` — placeholders: `{name}`
- `dialog.env_manager.unsaved_title`
- `dialog.env_manager.unsaved_msg` — placeholders: `{name}`
- `dialog.env_manager.saved_title`
- `dialog.env_manager.saved_msg` — placeholders: `{name}`
- `dialog.env_manager.new_title`
- `dialog.env_manager.new_prompt`
- `dialog.env_manager.error_duplicate`
- `dialog.env_manager.rename_title`
- `dialog.env_manager.rename_prompt`
- `dialog.env_manager.duplicate_title`
- `dialog.env_manager.duplicate_prompt`
- `dialog.env_manager.delete_title`
- `dialog.env_manager.delete_msg` — placeholders: `{name}`
- `dialog.env_manager.auto_import_title`
- `dialog.env_manager.auto_import_no_files`
- `dialog.env_manager.auto_import_success` — placeholders: `{added}`
- `dialog.env_manager.auto_import_exists`
- `dialog.settings.java_no_versions`
- `dialog.settings.java_detected_title`
- `dialog.settings.java_detected_msg` — placeholders: `{added_count}`
- `dialog.settings.java_not_found_title`
- `dialog.settings.java_not_found_msg`
- `dialog.settings.java_delete_title`
- `dialog.settings.java_delete_msg` — placeholders: `{name}`
- `dialog.settings.java_edit_title`
- `dialog.settings.java_new_title`
- `dialog.settings.java_config_header`
- `dialog.settings.java_field_name`
- `dialog.settings.java_name_placeholder`
- `dialog.settings.java_field_path`
- `dialog.settings.java_path_placeholder`
- `dialog.settings.java_dir_title`
- `dialog.settings.java_name_required`
- `dialog.settings.java_path_required`
- `dialog.settings.java_exe_warn_title`
- `dialog.settings.java_exe_warn_msg` — placeholders: `{java_exe}`
- `dialog.select_file_title`
- `dialog.docker.unavailable_title`
- `dialog.docker.unavailable_msg`
- `dialog.pull.error_title`
- `dialog.pull.error_msg` — placeholders: `{changes}`, `{name}`
- `dialog.pull.confirm_title`
- `dialog.pull.confirm_msg` — placeholders: `{branch}`, `{commits}`
- `dialog.clean.confirm_title`
- `dialog.clean.confirm_msg`
- `dialog.git.checkout_error_title`
- `dialog.git.checkout_error_msg` — placeholders: `{branch}`, `{msg}`
- `dialog.merge.title`
- `dialog.merge.repo_label` — placeholders: `{name}`
- `dialog.merge.target_section`
- `dialog.merge.target_branch`
- `dialog.merge.target_new`
- `dialog.merge.base_label`
- `dialog.merge.new_placeholder`
- `dialog.merge.source_section`
- `dialog.merge.source_label`
- `dialog.merge.origin_remote`
- `dialog.merge.origin_local`
- `dialog.merge.pull_opt`
- `dialog.merge.push_opt`
- `dialog.merge.btn`
- `dialog.merge.btn_running`
- `dialog.merge.error_no_source`
- `dialog.merge.error_no_target`
- `dialog.merge.error_no_base`
- `dialog.merge.error_no_new`
- `dialog.merge.success_title`
- `dialog.merge.success_msg`
- `dialog.merge.push_failed_title`
- `dialog.merge.push_failed_msg` — placeholders: `{msg}`
- `dialog.merge.conflict_title`
- `dialog.merge.conflict_msg` — placeholders: `{files}`
- `dialog.merge.dirty_title`
- `dialog.merge.dirty_msg` — placeholders: `{changes}`
- `dialog.merge.error_title`
- `dialog.merge.error_msg` — placeholders: `{msg}`
- `dialog.merge.log_label`
- `dialog.merge.error_same_branch`
- `dialog.merge.done_ok`
- `dialog.merge.done_push_failed` — placeholders: `{msg}`
- `dialog.merge.done_conflict` — placeholders: `{count}`
- `dialog.merge.done_dirty`
- `dialog.merge.done_error` — placeholders: `{msg}`
- `dialog.merge.reverting`
- `dialog.merge.cancel_pending`
- `dialog.merge.revert_confirm_title`
- `dialog.merge.revert_confirm_msg`
- `dialog.merge.revert_pushed_title`
- `dialog.merge.revert_pushed_msg`
- `dialog.config.write_error` — placeholders: `{path}`

#### `tray.*` (4 keys)

- `tray.show`
- `tray.quit`
- `tray.start_selected` — placeholders: `{count}`
- `tray.stop_running` — placeholders: `{count}`

#### `log.*` (29 keys)

- `log.scanning`
- `log.repos_detected` — placeholders: `{count}`, `{names}`
- `log.config_applied`
- `log.profile_saved` — placeholders: `{name}`
- `log.no_changes_local`
- `log.modified_files_header` — placeholders: `{count}`
- `log.import_cloning` — placeholders: `{name}`
- `log.import_clone_error` — placeholders: `{msg}`, `{name}`
- `log.import_starting` — placeholders: `{names}`
- `log.import_complete`
- `log.profile_applied` — placeholders: `{name}`
- `log.profile_imported_saved` — placeholders: `{name}`
- `log.pull_start`
- `log.reload_start`
- `log.reload_done` — placeholders: `{branch}`
- `log.no_conflicts`
- `log.conflict_files_header` — placeholders: `{count}`
- `log.install_done` — placeholders: `{name}`
- `log.install_fail` — placeholders: `{name}`
- `log.install_timeout` — placeholders: `{name}`
- `log.global_branch_applied` — placeholders: `{branch}`, `{changed}`, `{total}`
- `log.global_branch_not_found` — placeholders: `{branch}`, `{changed}`, `{missing}`, `{total}`
- `log.global_pulling` — placeholders: `{count}`
- `log.global_installing` — placeholders: `{count}`
- `log.global_all_installed`
- `log.global_install_done`
- `log.global_starting` — placeholders: `{count}`
- `log.global_stopping` — placeholders: `{count}`
- `log.global_restarting` — placeholders: `{count}`

#### `misc.*` (6 keys)

- `misc.error_title`
- `misc.warning_title`
- `misc.enter_branch`
- `misc.no_repos_selected`
- `misc.branch_not_found_title`
- `misc.branch_not_found_msg` — placeholders: `{branch}`, `{repos}`

#### `docker.*` (14 keys)

- `docker.title`
- `docker.no_services`
- `docker.auto_refresh`
- `docker.btn_start_all`
- `docker.btn_stop_all`
- `docker.logs_title_empty`
- `docker.logs_title` — placeholders: `{name}`
- `docker.profile_count` — placeholders: `{n}`
- `docker.log_starting` — placeholders: `{name}`
- `docker.log_stopping` — placeholders: `{name}`
- `docker.log_start_all`
- `docker.log_stop_all`
- `docker.log_unavailable`
- `docker.log_loading` — placeholders: `{name}`

#### `badge.*` (1 keys)

- `badge.danger_env`

#### `placeholder.*` (3 keys)

- `placeholder.search`
- `placeholder.no_results`
- `placeholder.more_items` — placeholders: `{count}`

---

## 3. UI Theme — Design Tokens (`config/ui_theme.yml`, 198 lines)

Loader behavior (`gui/theme.py`): the YAML is read **once at import time** and deep-merged
over an embedded `_DEFAULTS` dict (`gui/theme.py:22+`) whose values are identical to the
shipped YAML — the app starts even if the YAML is missing. The YAML is therefore the single
source of truth for the CSS/SCSS design system. All values below are exhaustive.

### 3.1 Typography (`fonts`, `ui_theme.yml:9-21`)

| Token | Value |
|---|---|
| `fonts.family` | `Segoe UI` |
| `fonts.mono` | `Consolas` |
| `fonts.sizes.xs` | 9 |
| `fonts.sizes.sm` | 10 |
| `fonts.sizes.md` | 11 |
| `fonts.sizes.base` | 12 |
| `fonts.sizes.lg` | 13 |
| `fonts.sizes.xl` | 14 |
| `fonts.sizes.xxl` | 15 |
| `fonts.sizes.h2` | 16 |
| `fonts.sizes.h1` | 22 |

API mapping: `theme.font(size_key, bold=False, mono=False)` → `(family, size[, "bold"])`.

### 3.2 Geometry (`geometry`, `ui_theme.yml:24-39`) — px

| Token | Value | Used for |
|---|---|---|
| `corner_btn` | 6 | button/entry corner radius |
| `corner_card` | 10 | main card radius |
| `corner_panel` | 8 | expanded accordion panel radius |
| `corner_badge` | 4 | small inline badges |
| `corner_combo` | 6 | ComboBox radius |
| `corner_tooltip` | 6 | tooltip outer radius |
| `border_width` | 1 | standard border width |
| `btn_height_sm` | 24 | small buttons (log actions) |
| `btn_height_md` | 28 | standard buttons |
| `btn_height_lg` | 34 | topbar / profile buttons |
| `topbar_height` | 56 | top bar height |
| `checkbox_size` | 18 | standard checkbox |
| `checkbox_size_sm` | 16 | small (select-all) checkbox |
| `checkbox_corner` | 4 | checkbox radius |

### 3.3 Backgrounds (`backgrounds`, `ui_theme.yml:41-49`)

| Token | Hex | Used for |
|---|---|---|
| `app` | `#0f0e26` | root window / topbar / log textbox |
| `card` | `#16132e` | collapsed card |
| `card_hover` | `#1c1940` | card on hover |
| `expand_panel` | `#120f28` | expanded accordion body |
| `section` | `#1e1b4b` | entries, combos, settings frames |
| `section_alt` | `#0f172a` | dialog list backgrounds |
| `divider` | `#312e81` | 1-px separator line |

### 3.4 Borders (`borders`, `ui_theme.yml:51-56`)

| Token | Hex | Used for |
|---|---|---|
| `card` | `#3b3768` | card / log textbox |
| `default` | `#4338ca` | combos, entries, search buttons |
| `settings` | `#312e81` | settings section frame |
| `subtle` | `#334155` | stopped docker btn / neutral lists |

### 3.5 Text colors (`text`, `ui_theme.yml:58-73`)

| Token | Hex | Used for |
|---|---|---|
| `primary` | `#e0e7ff` | main content, log text, repo names |
| `secondary` | `#c7d2fe` | section labels, log header |
| `muted` | `#94a3b8` | status text, secondary checkboxes |
| `faint` | `#6b7280` | branch hint, dimmed labels |
| `placeholder` | `#888888` | placeholders / misc hints |
| `accent` | `#6366f1` | statusbar, port labels |
| `accent_bright` | `#818cf8` | expand/collapse chevron |
| `warning_badge` | `#facc15` | unsaved-changes badge |
| `white` | `#ffffff` | badge text, buttons on dark bg |
| `file_btn_light` | `#333333` | file-picker button (light mode) |
| `file_btn_dark` | `#dddddd` | file-picker button (dark mode) |
| `file_btn_hover_light` | `#E3F2FD` | file-picker hover (light) |
| `file_btn_hover_dark` | `#1a2332` | file-picker hover (dark) |

### 3.6 Service status colors (`status`, `ui_theme.yml:75-81`)

| Token | Hex | Meaning |
|---|---|---|
| `running` | `#22c55e` | service running (green) |
| `starting` | `#eab308` | service starting (yellow) |
| `stopped` | `#6b7280` | stopped (gray) |
| `error` | `#ef4444` | error (red) |
| `logging` | `#f97316` | active log streaming (orange) |

`theme.STATUS_ICONS` maps status strings to these colors for the card status dot.

### 3.7 Button variants (`buttons`, `ui_theme.yml:84-180`) — 16 variants

Each variant = `fg` (background), `hover` (hover background), `border` (border color).
Consumed via `theme.btn_style(variant, height, width, font_size)`.

| Variant | fg | hover | border | Semantic use |
|---|---|---|---|---|
| `success` | `#064e3b` | `#047857` | `#10b981` | positive / save / apply |
| `start` | `#144d28` | `#16a34a` | `#22c55e` | start service |
| `danger` | `#4c1616` | `#dc2626` | `#ef4444` | primary destructive (stop) |
| `danger_alt` | `#7f1d1d` | `#991b1b` | `#b91c1c` | secondary destructive (unsaved quick-save / failed install) |
| `danger_deep` | `#450a0a` | `#dc2626` | `#ef4444` | deep destructive (delete profile in list) |
| `warning` | `#4a3310` | `#d97706` | `#f59e0b` | warning / reload / export |
| `blue` | `#172554` | `#2563eb` | `#3b82f6` | primary blue (pull, clone, browse) |
| `blue_active` | `#1d4ed8` | `#2563eb` | `#3b82f6` | active blue (pull with commits behind) |
| `neutral` | `#1e293b` | `#475569` | `#64748b` | neutral / cancel / config |
| `neutral_alt` | `#334155` | `#475569` | `#64748b` | neutral alt (installed / file) |
| `purple` | `#2e1065` | `#6d28d9` | `#7c3aed` | seed / import (soft purple) |
| `purple_alt` | `#4c1d95` | `#6d28d9` | `#7c3aed` | clean repo / docker compose |
| `purple_global` | `#2e1065` | `#9333ea` | `#a855f7` | global panel apply-db / seed-all |
| `log_action` | `#1e1b4b` | `#312e81` | `#4338ca` | log action buttons (clear / detach) |
| `toggle_expand` | `transparent` | `#312e81` | `#4338ca` | card expand/collapse chevron |
| `profile_accent` | `#7c3aed` | `#6d28d9` | `#7c3aed` | profile combo accent |

### 3.8 Docker-compose button states (`docker`, `ui_theme.yml:182-188`)

| Token | Hex | Meaning |
|---|---|---|
| `btn_stopped_fg` | `#1e293b` | button bg when stack stopped |
| `btn_active_fg` | `#0f172a` | button bg when active |
| `border_running` | `#10b981` | border: ≥1 container running |
| `border_active` | `#3b82f6` | border: profile active, 0 running |
| `border_stopped` | `#334155` | border: fully stopped |

### 3.9 Tooltip (`tooltip`, `ui_theme.yml:190-198`)

| Token | Value |
|---|---|
| `bg_dark` | `#2a2a3e` |
| `text_dark` | `#e0e0e0` |
| `border_dark` | `#444466` |
| `bg_light` | `#333344` |
| `text_light` | `#f5f5f5` |
| `border_light` | `#555577` |
| `delay_ms` | 500 |
| `wrap_px` | 250 |

### 3.10 Non-themed UI constants worth porting

- Default window size `1300x900` (`gui/app.py:99`).
- Timing constants live in `gui/constants.py`, not the theme: git badge refresh 30 000 ms,
  docker poll 15 000 ms, profile-change debounce 300 ms, git-badge concurrency semaphore 3.
- App icons: `assets/icons/icon_red.ico` (window/installer/tray), `icon_green.ico`
  (tray when services running).

---

## 4. User Data & Persistence

Three persistence locations, **all rooted in the application directory** (not OS config dirs):

1. `devdeck_config.json` — app settings + per-repo state (gitignored).
2. `.devops-profiles/` — one JSON file per saved profile, per-group subdirs (gitignored).
3. `%TEMP%/devdeck_instances/<pid>.json` — single-instance registry (runtime only).

> Migration note: Tauri should map (1) and (2) to `app_config_dir`/`app_data_dir`; today the
> location next to the executable means a compiled install under Program Files would try to
> write there.

### 4.1 `devdeck_config.json` — full schema

Read through an mtime-invalidated in-memory cache (`core/config_manager.py:14-56`); every
write must invalidate the cache. All keys are top-level and optional.

| Key | Type | Owner (code) | User data? | Semantics |
|---|---|---|---|---|
| `workspace_dir` | string | `gui/app.py:726-754` | yes | Legacy single workspace path (pre-groups); still synced. |
| `language` | string | `core/i18n.py`, `gui/dialogs/settings.py` | yes | Translation code (`en_EN`, `es_ES`). Restart required. |
| `minimize_to_tray` | bool (default true) | `gui/app.py:836,1023`, `settings.py:132,397` | yes | Minimize hides to tray instead of taskbar. |
| `java_versions` | map name→JAVA_HOME path | `gui/app.py:631,761`, `settings.py:28,396` | yes | User-registered JDKs, e.g. `"Java 17 (jdk-17)": "C:\\Program Files\\Java\\jdk-17"`. |
| `last_profile` | string | `gui/app.py:86` | yes | Legacy last-profile (pre-groups); migrated into `last_profile_by_group` on first run (`gui/app.py:82-89`). |
| `last_profile_by_group` | map group→profile name | `gui/app_profile.py:47-71`, `gui/app.py:610` | yes | Per-group last active profile. |
| `workspace_groups` | array of `{name: string, paths: [string]}` | `core/config_manager.py:332-358` | yes | Workspace groups; auto-migrated from `workspace_dir` when absent. |
| `active_group` | string | `core/config_manager.py:361-380` | yes | Name of active group (falls back to "Default"). |
| `repo_state` | map repoName→object | `gui/app.py:630,776-784` | yes | Per-repo UI state: `{selected: bool, custom_command: string, java_version: string, expanded: bool}`. |
| `active_configs` | map `"repo::module-dir"`→config name | `config_manager.py:406-431` | yes | Active saved-environment per config target (sentinel `"- Sin Seleccionar -"` = none — note: hardcoded Spanish sentinel). |
| `repo_configs` | map repo→module-dir→configName→**file content string** | `config_manager.py:139-198` | yes (bulk) | Saved environments: full text of each named env/profile, keyed `repo_configs[repo][module][name]`. Import merge renames conflicts to `repetidoN` (`config_manager.py:201-264`). |
| `repo_config_danger` | map `"repo::module-dir"`→[config names] | `config_manager.py:383-403` | yes | Environments flagged "dangerous" (red ⚠ badge). |

Notes:
- `config_key` convention is `"repo-name::module-key"` where module-key is the repo-relative
  POSIX dir of the env files (e.g. `spring-petclinic::src/main/resources`,
  `nx-examples::apps/cart/src/environments`).
- Window geometry is **not** persisted (fixed `1300x900` at startup); the
  geometry/fullscreen snapshot in `gui/app.py:820-915` is runtime-only for tray restore.
- DB presets mentioned in older docs are stored inside profiles, not in this file.

Example (sanitized excerpt of the real local file):

```json
{
  "workspace_dir": "C:\\Users\\Jordi\\PROYECTOS\\BOA2",
  "last_profile": "ghf",
  "repo_state": {
    "spring-petclinic": { "selected": true, "custom_command": "", "java_version": "Sistema (Por Defecto)" }
  },
  "active_configs": { "spring-petclinic::src/main/resources": "- Sin Seleccionar -" },
  "language": "es_ES",
  "java_versions": { "Java 17 (jdk-17)": "C:\\Program Files\\Java\\jdk-17" },
  "minimize_to_tray": true,
  "workspace_groups": [ { "name": "Default", "paths": ["C:\\Users\\Jordi\\PROYECTOS\\BOA2"] } ],
  "active_group": "Nuevo Grupo",
  "last_profile_by_group": { "Default": "KLK2", "Nuevo Grupo": "" },
  "repo_configs": {
    "spring-petclinic": {
      "src/main/resources": {
        "mysql": "# full application-mysql.properties content...",
        "default": "# full application.properties content..."
      }
    }
  },
  "repo_config_danger": { "spring-petclinic::src/main/resources": ["postgres"] }
}
```

### 4.2 Profile files (`.devops-profiles/<name>.json`)

Managed by `core/profile_manager.py`. Directory layout (`profile_manager.py:23-36`):
root `.devops-profiles/` for the "Default" group; other groups get a sanitized subdirectory
(`[<>:"/\|?*]` → `_`). Backward compat: a custom group with no profiles falls back to
listing the root dir (`profile_manager.py:68-87`).

Schema (built in `profile_manager.py:130-180`):

```
Profile {
  name: String              // injected on save (profile_manager.py:43)
  created: String           // ISO-8601 timestamp (profile_manager.py:44)
  repos: Map<repoName, {
    git_url: String                       // origin remote URL ("" if none)
    branch: Option<String>                // null when card's "include branch" unchecked
    type: String                          // repo_type id
    profile: Option<String>               // active env/app name; null when untracked
    profile_tracked: <list>               // files tracked for the profile
    custom_command: String
    java_version: String                  // display name; default "Sistema (Por Defecto)" (hardcoded Spanish)
    selected: bool
    docker_compose_active: bool           // only for docker-capable cards
    docker_profile_services: [String]     // compose services auto-started with the card
    config_files: Map<relDir, Map<filename, content>>   // only when "include config files"
    saved_environments: Map<relPath, Map<envName, content>> // only when "include config files"
  }>
}
```

Import/export: profiles are exported/imported as plain JSON files; a file without a `repos`
key is rejected (`profile_manager.py:113-120`). Import clones missing repos (using
`git_url` + `branch`), maps Java versions, optionally overwrites config files, and merges
`saved_environments` with the `repetidoN` rename strategy + `active_configs` fix-up
(`profile_manager.py:330-371`).

### 4.3 Single-instance registry

`core/instance_manager.py`: each instance writes
`<TMP>/devdeck_instances/<pid>.json` (`instance_manager.py:22,38-39`) containing at
least `{workspace, pid, port}` and listens on an ephemeral loopback port. Protocol verbs:
`PING→PONG`, `SHUTDOWN→OK` (`instance_manager.py:24-27`). Stale entries are pruned when the
port no longer answers. Conflict UI = `gui/dialogs/instance_conflict.py`
(`dialog.instance_conflict.*` keys). In Tauri, replace with the single-instance plugin —
but note this implementation is **per-workspace**, not global.

### 4.4 Logs

`error.log` (+ rotations `error.log.*`) written in the app dir via the global exception
handler in `main.py:17-36`; gitignored.

---

## 5. CI/CD Pipeline (`.github/workflows/build-and-sign.yml`, 81 lines)

### 5.1 Triggers (`build-and-sign.yml:3-6`)

- `push` on tags matching `v*`
- `workflow_dispatch` (manual)

### 5.2 Job `build` (windows-latest, `build-and-sign.yml:9-53`)

1. `actions/checkout@v4`
2. `astral-sh/setup-uv@v5` with `python-version: '3.13'`
3. `uv sync`
4. **Nuitka compile** (pwsh, `build-and-sign.yml:25-38`):

   ```
   uv run python -m nuitka --standalone --follow-imports
     --enable-plugin=tk-inter
     --include-package=customtkinter,darkdetect,pystray,PIL,git,yaml
     --include-package-data=customtkinter
     --include-data-dir=config=config        # ships config/ (repo_types, translations, ui_theme)
     --include-data-dir=assets=assets        # ships assets/ (icons)
     --windows-console-mode=hide
     --windows-icon-from-ico=assets\icons\icon_red.ico
     --output-dir=dist
     --output-filename=devdeck
     --assume-yes-for-downloads
     main.py
   ```

   Output: `dist/main.dist/` folder (standalone dist, NOT onefile).
5. Package: `Compress-Archive dist\main.dist\devdeck.exe → dist\devdeck-unsigned.zip`
   (`build-and-sign.yml:40-45`) — **only the .exe is zipped, not the dist folder**.
6. `actions/upload-artifact@v4` as `devdeck-unsigned`; the step's `artifact-id` is
   exported as job output (`build-and-sign.yml:11-12,47-52`).

### 5.3 Job `sign` (ubuntu-latest, `build-and-sign.yml:55-81`)

Uses `SignPath/github-action-submit-signing-request@v1` (`build-and-sign.yml:60-70`) with:

| Parameter | Value |
|---|---|
| `api-token` | secret **`SIGNPATH_API_TOKEN`** (only secret in the pipeline) |
| `organization-id` | `566b6bce-16ea-4c67-80a2-1654b3efdef4` |
| `project-slug` | `devdeck` |
| `signing-policy-slug` | `release-signing` |
| `artifact-configuration-slug` | `exe` |
| `github-artifact-id` | `${{ needs.build.outputs.artifact-id }}` |
| `wait-for-completion` | `true` |
| `output-artifact-directory` | `signed/` |

SignPath pulls the unsigned GitHub artifact (zip), signs the exe per the `exe` artifact
configuration, and the action writes the signed file to `signed/devdeck.exe`.
Then:
- `actions/upload-artifact@v4` → `devdeck-signed`
- `softprops/action-gh-release@v2` (only on tag refs) publishes `signed/devdeck.exe`
  as a GitHub Release asset (`build-and-sign.yml:77-81`).

### 5.4 ⚠ Pipeline findings (verify before replicating)

1. **The released artifact is a bare `devdeck.exe` from a `--standalone` (multi-file)
   build.** Nuitka standalone exes require the surrounding `main.dist/` folder (DLLs,
   `config/`, `assets/`); only the exe is zipped, signed and released. Either the release is
   currently broken for end users, or it is consumed only with a separately distributed
   folder. The Tauri pipeline (NSIS installer) removes this whole class of problem.
2. **No version stamping**: the workflow never passes a version; `pyproject.toml` is fixed at
   `1.0.0` and `installer.iss` defaults `MyAppVersion` to `1.0.0` unless `/D` is passed.
3. The **Inno Setup installer is NOT built in CI** — only locally (see §5.5/§6).
4. For Tauri: equivalent flow = `tauri-action` build → NSIS bundle → zip → SignPath
   (same org/project/policy slugs can be reused with a new artifact configuration for the
   installer; SignPath also supports signing nested files inside installers).

### 5.5 `installer.iss` (Inno Setup 6, 46 lines)

| Setting | Value |
|---|---|
| Defines | `MyAppName "DevDeck"`, `MyAppPublisher "Jorditomasg"`, `MyAppURL "https://github.com/Jorditomasg/devdeck"`, `MyAppExeName "devdeck.exe"`, `MyAppVersion` default `1.0.0` (overridable via `#ifndef`, `installer.iss:5-7`) |
| `AppId` | `{{B7F3A2C1-D4E5-4F6A-8B9C-0D1E2F3A4B5C}` (keep stable for upgrades) |
| Install dir | `{autopf}\DevDeck` (Program Files), `PrivilegesRequired=admin` |
| Arch | `x64compatible` only, 64-bit install mode |
| Output | `dist\devdeck-setup.exe` (`OutputDir=dist`, `OutputBaseFilename=devdeck-setup`) |
| Icon | `assets\icons\icon_red.ico`; `UninstallDisplayIcon={app}\devdeck.exe` |
| Compression | `lzma`, `SolidCompression=yes`, `WizardStyle=modern` |
| Languages | English only |
| Tasks | optional unchecked `desktopicon` |
| Files | `dist\main.dist\*` recursively → `{app}` (**the full Nuitka dist folder** — unlike CI) |
| Icons | Start-menu group + uninstaller + optional desktop icon |
| Run | post-install optional launch (`nowait postinstall skipifsilent`) |

> Equivalent Tauri NSIS config: productName `DevDeck`, publisher `Jorditomasg`,
> perMachine install, x64 only, keep a stable upgrade GUID, desktop-shortcut optional.

### 5.6 `scripts/build-installer.bat` — REMOVED

`CLAUDE.md` still references `scripts/build-installer.bat`, but it **does not exist in HEAD**
(deleted in commit `f9abc45` "reorganize scripts for OS compatibility"). Historical content
(commit `f2bd65e`): activate venv → run the same Nuitka command as `compile.bat` → invoke
`"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss`. If installer builds are still
desired locally, this is the reference procedure.

---

## 6. Scripts (`scripts/win/`, `scripts/linux/`)

### 6.1 Windows (`scripts/win/`)

| Script | What it does |
|---|---|
| `run.vbs` | Silent launcher. Resolves project root via three nested `GetParentFolderName` calls on `WScript.ScriptFullName`; verifies `.venv\Scripts\pythonw.exe` exists (MsgBox error otherwise); `WScript.Shell.Run` with `windowStyle=0` → zero console flash. |
| `run.bat` | Console launcher: `cd` to root, checks venv, `start "" .venv\Scripts\pythonw.exe main.py`. |
| `install.bat` | Bootstraps `uv` (PATH → `%USERPROFILE%\.local\bin\uv.exe` → `pip install uv` → PowerShell `irm https://astral.sh/uv/install.ps1`), runs `uv sync`, then creates a desktop shortcut `DevDeck.lnk` via PowerShell `WScript.Shell.CreateShortcut`: target `wscript.exe`, argument = quoted `run.vbs` path, icon `assets\icons\icon_red.ico,0`, working dir = root. |
| `compile.bat` | Activates venv, runs the same Nuitka command as CI (with `tk-inter` plugin, hidden console, icon). Output `dist\main.dist\devdeck.exe`. |
| `run-compiled.bat` | `start "" dist\main.dist\devdeck.exe %*`. |

### 6.2 Linux (`scripts/linux/`)

| Script | What it does |
|---|---|
| `run.sh` | Resolves root from script dir; uses `.venv/bin/python` directly (no `uv run` overhead). TTY detection (`[ -t 1 ]`): attached `exec` from a shell, otherwise `nohup ... &` detached (file-manager / desktop launch). Forwards `"$@"` (workspace path arg). |
| `install.sh` | Installs `uv` if missing (`curl -LsSf https://astral.sh/uv/install.sh \| sh`), `uv sync`, then writes a `.desktop` entry (`Name=DevDeck`, `Exec=<root>/scripts/linux/run.sh`, `Icon=<root>/assets/icons/icon_red.ico`, `Terminal=false`, `Categories=Development;Utility;`) into `~/.local/share/applications/devdeck.desktop` and onto the Desktop (localized via `xdg-user-dir DESKTOP`), `chmod +x`. |
| `compile.sh` | Same Nuitka build, WITHOUT `--enable-plugin=tk-inter`, `--windows-console-mode` and icon flags. Output `dist/main.dist/devdeck`. |
| `run-compiled.sh` | Requires a workspace path argument; runs `./dist/main.dist/devdeck "$1" &`. |

App-side equivalents: Settings → Quick Access recreates the shortcut at runtime (`.lnk` via
`IShellLink` ctypes on Windows, `.desktop` on Linux) — see `dialog.settings.shortcut_*` keys.

CLI contract of the app itself: `python main.py [workspace_path]` — optional positional
workspace overrides the configured one.

---

## 7. Toolchain & Dependencies

### 7.1 `pyproject.toml` (19 lines)

- `name = "devdeck"`, `version = "1.0.0"`, `requires-python = ">=3.13"`
  (note: `CLAUDE.md` claims >=3.9 — stale; the project file says 3.13).
- Runtime deps: `customtkinter>=5.2.0`, `PyYAML>=6.0`, `gitpython>=3.1.0`,
  `Pillow>=10.0.0`, `pystray>=0.19.4`.
- `[tool.uv] dev-dependencies`: `nuitka>=2.4`, `ordered-set>=4.1.0`, `zstandard>=0.23.0`
  (all build-time only).

### 7.2 `.python-version`

`3.13`

### 7.3 `uv.lock` resolved versions (skim)

customtkinter 5.2.2 · darkdetect 0.8.0 · gitpython 3.1.46 (gitdb 4.0.12, smmap 5.0.3) ·
pillow 12.1.1 · pystray 0.19.5 (python-xlib 0.33 on Linux, pyobjc 12.1 on macOS) ·
pyyaml 6.0.3 · six 1.17.0 · packaging 26.0 · nuitka 4.0.7 · ordered-set 4.1.0 ·
zstandard 0.25.0.

Functional mapping for the rewrite: customtkinter/darkdetect → Angular UI + CSS tokens (§3);
gitpython → `git2` crate or git CLI; pystray/Pillow → Tauri tray API; PyYAML → `serde_yaml`.

### 7.4 `.gitignore` (31 lines)

Ignored: `__pycache__/`, `*.py[cod]`; venvs (`.env`, `.venv`, `env/`, `venv/`);
**user configs** (`.devops-profiles/`, `devdeck_config.json`); logs
(`error.log`, `error.log.*`); IDEs (`.vscode/`, `.idea/`); AI artifacts
(`.agents/`, `.claude/`, `skills-lock.json`); translation caches (`*.cache.json`);
build output (`dist/`).

Note `*.cache.json`: `core/i18n.py` may emit translation cache files next to the YAMLs —
the Angular catalog generation makes these obsolete.

---

## Appendix A — Cross-cutting risks for the rewrite

1. **Release artifact** likely non-functional as shipped (bare standalone exe, §5.4).
2. **Dead YAML keys** (`must_match_package_json`, `stop_cmd`) and missing `react` priority —
   all resolved in the v2 schema (§1.7).
3. **Hardcoded Spanish sentinels in persisted data**: `"- Sin Seleccionar -"`
   (`active_configs` default, `config_manager.py:406`) and `"Sistema (Por Defecto)"`
   (java default in `repo_state`/profiles) — they live in user files, so the rewrite needs
   a migration/normalization step, not just translation.
4. **Config files live next to the executable** (config JSON, profiles, error.log) — move to
   OS-standard dirs in Tauri and migrate existing files.
5. **`repo_configs` stores full file contents** in one JSON — fine for serde, but watch
   size/locking if moving to async Rust IO; current code relies on a single-process
   mtime-cached read-modify-write cycle.
6. Two parallel detection code paths (`project_analyzer.py` vs `core/repo_detector.py`) with
   subtle divergences (`.yaml` compose matching, non-git docker-infra handling) — the rewrite
   should unify them into one.
