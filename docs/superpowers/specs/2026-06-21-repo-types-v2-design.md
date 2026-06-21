# Repo Types v2 — Schema redesign + capability registry

**Date:** 2026-06-21
**Status:** Approved design — ready for implementation plan
**Approach:** A (declarative-first + named-strategy registry)

## Problem

Adding a framework to DevDeck is *mostly* config-driven today: drop a YAML under
`config/repo-types/` and detection/loading/rendering are generic over `RepoTypeDef`.
But scalability leaks in three places:

1. **Adding frameworks** works for the simple case, but anything beyond "marker file +
   commands + log patterns" hits code.
2. **Hardcoded `if repo_type == "..."`** scattered across Rust and Angular (all for
   `docker-infra` today) — these do not scale to new frameworks.
3. **The YAML schema itself** has arbitrary boundaries (`detection` vs `heuristics`),
   mixes concerns (commands vs log-parsing), and has noisy flat OS-override fields.

### The trap we are explicitly avoiding

Pushing *all* behavior into YAML reinvents a programming language in config (the
inner-platform effect). The design draws a hard boundary:

- **Data** (marker files, commands, log patterns, ports, icons, restart delay) → YAML.
- **Behavior** (how to write a config file, how to resolve which app to run, how to
  enrich a repo) → code, made **pluggable and selected by name from YAML** via a
  registry. Never inline `if repo_type ==`.

This is the Strategy pattern + a capability registry. The system already has half of it
(`config_writer_type: "spring"` selects a strategy by name); v2 completes it and removes
the leaks.

## Schema v2

Top-level reorganized into six intent-based blocks. `schema_version: 2` is mandatory;
the loader rejects anything else with a clear error (no v1→v2 migrator — the app is at
0.9.0 and we assume no user overrides exist yet).

```yaml
schema_version: 2
type: spring-boot
priority: 60

detect:                    # everything about matching a dir to this type
  git_required: true       # (replaces allow_no_git, inverted; default true)
  files:   { required: [pom.xml], excluded: [] }
  dirs:    { required: [src/main/resources], excluded: [] }
  patterns:
    match: ["application*.yml", "application*.yaml", "application*.properties"]
    search_dirs: [src/main/resources]      # fallback dirs (was pattern_search_dirs)
  package_json: []                          # dependency gate (react uses this)

run:                       # lifecycle — OS overrides NESTED, not flat
  install:   { default: "mvn clean install -DskipTests -B" }
  reinstall: { default: null }
  start:     { default: "mvn spring-boot:run", unix: "./mvnw spring-boot:run" }
  stop:      { default: null }
  restart_delay_ms: 300    # was hardcoded for docker in process.rs
  app_resolution: null     # generalizes {main_app}; see monorepo example

logs:                      # output parsing (was mixed into commands)
  ready: "Started \\w+ in"
  error: "Application run failed"
  ports: ["Tomcat (?:started on|initialized with) port.*?(\\d+)", "..."]

config:                    # env/config files (was env_files)
  writer: spring           # NAMED STRATEGY: raw|spring|angular|... (registry)
  dir: src/main/resources
  main_file: application.yml
  patterns: ["application*.yml", "..."]
  pull_ignore: []
  exclude_dirs: null       # null = default [.git, node_modules]
  implicit_default_profile: true
  editable: true           # replaces the `repoType !== 'docker-infra'` front-end checks

enrich: [java_version]     # NAMED enrichment strategies (was `features`)

ui:
  icon: "🍃"
  color: "#22c55e"
  selectors: [{ label: "App:" }]
  install_check_dirs: [target]
  actions: []              # declared buttons; docker → [seed]
```

### Field mapping v1 → v2

| v1 | v2 |
|---|---|
| `detection.required_files` / `exclude_files` | `detect.files.required` / `.excluded` |
| `detection.allow_no_git: true` | `detect.git_required: false` |
| `heuristics.must_have_directories` / `must_not_have_directories` | `detect.dirs.required` / `.excluded` |
| `heuristics.must_match_patterns` | `detect.patterns.match` |
| `heuristics.pattern_search_dirs` | `detect.patterns.search_dirs` |
| `heuristics.must_match_package_json` | `detect.package_json` |
| `commands.install_cmd` + `windows_/unix_reinstall_cmd` | `run.install` / `run.reinstall` (nested `{default, windows, unix}`) |
| `commands.start_cmd` + `windows_/unix_start_cmd` | `run.start.{default, windows, unix}` |
| `commands.stop_cmd` | `run.stop.default` |
| `commands.ready_pattern` / `error_pattern` / `port_patterns` | `logs.ready` / `logs.error` / `logs.ports` |
| `env_files.config_writer_type` | `config.writer` |
| `env_files.default_dir` / `main_config_filename` | `config.dir` / `config.main_file` |
| `env_files.patterns` / `pull_ignore_patterns` / `exclude_dirs` | `config.patterns` / `pull_ignore` / `exclude_dirs` |
| `env_files.implicit_default_profile` | `config.implicit_default_profile` |
| `features` | `enrich` |
| `ui.install.check_dirs` | `ui.install_check_dirs` |
| *(hardcoded docker restart delay)* | `run.restart_delay_ms` |
| *(hardcoded docker config/env hiding)* | `config.editable` |
| *(hardcoded docker seed button)* | `ui.actions` |
| *(hardcoded Nx `apps/` + alphabetical)* | `run.app_resolution` |

### New-framework example (Go) — pure YAML, zero code

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

### Monorepo example — generalized app resolution

```yaml
run:
  start: { default: "turbo run dev --filter={main_app}" }
  app_resolution:
    placeholder: main_app
    scan_dir: apps                  # was hardcoded "apps/" in resolve_main_app()
    strategy: first_alphabetical    # first_alphabetical | single_dir | from_workspace_file
```

## Capability registry (the "no `if`s")

Each former `if repo_type ==` becomes a registry lookup. The registry is the single
extension point per behavior category.

### Config writers (Rust)

```rust
pub trait ConfigWriter: Send + Sync {
    fn name(&self) -> &str;
    fn write_active(&self, ctx: &WriteCtx) -> Result<(), AppError>;
}
// writers/mod.rs — the ONLY place writers are registered
fn registry() -> HashMap<&'static str, Box<dyn ConfigWriter>> {
    // RawWriter, SpringWriter, AngularWriter, + new ones here
}
```

`config.writer: "spring"` → lookup by name. Unknown name → validation error at load.
New writer = impl trait + one line in `registry()`.

### Enrichers (Rust)

```rust
pub trait Enricher: Send + Sync {
    fn name(&self) -> &str;
    fn run(&self, repo: &mut RepoInfo, path: &Path);
}
// builder.rs: for name in &def.enrich { registry[name].run(&mut repo, path) }
```

Replaces the `if has_feature("java_version")` / `if has_feature("docker_checkboxes")`
chain in `builder.rs`. Keeps `java_version` and `docker_checkboxes` as registered
enrichers. New enricher = impl + register.

### App resolution (Rust)

`run.app_resolution` (when present) drives `resolve_run_command`. The strategy
(`first_alphabetical | single_dir | from_workspace_file`) and `scan_dir` come from YAML
instead of the hardcoded `"apps/"` + alphabetical sort in `resolve_main_app()`.

### UI actions (Angular)

```ts
// action-registry.ts — the only place actions are registered
const ACTIONS = {
  seed: { icon: '🌱', cmd: CMD.dockerSeed, label: 'repo.action.seed' },
  // new actions here
};
// repo-card renders buttons from repo.uiConfig.actions, generically
```

Replaces `showSeedBtn: repoType === 'docker-infra'`. New action = one entry.

### Pure-data fields (no registry)

- `run.restart_delay_ms` — read in `process.rs` (default 300). Removes the
  `repo_type == "docker-infra"` branch at `process.rs:310`.
- `config.editable` — read in `repo-card.component.ts`. Removes the
  `repoType !== 'docker-infra'` branches (config button + env-row visibility).

## Hardcode elimination — acceptance

| Hardcode | Location | v2 mechanism |
|---|---|---|
| `repo_type == "docker-infra"` → 2000ms delay | `process.rs:310` | `run.restart_delay_ms` (data) |
| `showSeedBtn: repoType === 'docker-infra'` | `repo-card.component.ts` | `ui.actions: [seed]` + action registry |
| `showConfigBtn: ... !== 'docker-infra'` | `repo-card.component.ts` | `config.editable` (data) |
| env rows hidden for docker | `repo-card.component.ts` | `config.editable` (data) |
| `config_writer_type` closed enum | writers (Rust) | trait + open registry |
| `features` → `if has_feature(...)` | `builder.rs` | enrich registry |
| `{main_app}` + `"apps/"` Nx-only | `builder.rs:resolve_main_app` | `run.app_resolution` (named strategy) |

**Acceptance:** zero `if repo_type ==` / `repoType ===` in Rust and frontend after v2.
Framework knowledge lives in YAML or in a single-location registry.

## Validation & versioning

1. `schema_version: 2` mandatory. Loader rejects other/missing versions with a clear error.
2. **Validation at startup** (`detection/validate.rs`): today a bad YAML is silently
   dropped (`repo_types_loader.rs:87`). v2 collects and surfaces errors — unknown writer,
   unknown enricher, unknown app-resolution strategy, invalid regex, missing required
   fields, unknown UI action. Fails loud.
3. **No migrator.** The 6 bundled YAMLs are rewritten to v2. We assume no user overrides
   exist yet (app is 0.9.0).
4. `RepoTypeDef` (Rust) restructured into sub-structs mirroring the six blocks
   (`Detect`, `Run`, `Logs`, `ConfigSpec`, `Enrich`, `Ui`), `#[serde(rename_all = "camelCase")]`
   preserved on the wire types.

## Testing

- Round-trip parse of the 6 v2 YAMLs + priority ladder
  (spring-boot 60 > nx 50 > angular 40 > maven-lib 20 > react 10 > docker-infra 0).
- Validation tests: unknown writer/enricher/strategy/action and invalid regex → clear error.
- **Behavior-preservation tests** for every eliminated `if`: docker restart delay = 2000ms,
  seed action present, config/env hidden for docker, java_version enrichment runs for
  spring-boot/maven-lib, package_json gate still rejects non-react.
- Detection parity: classification results unchanged for the 6 shipped types.
- Frontend: `repo-card` renders action buttons from `uiConfig.actions`; respects
  `config.editable`.

## Out of scope (YAGNI)

- Plugin system (WASM / sidecar scripts) — rejected as over-engineering for a desktop
  dev tool.
- Fully declarative writers as templates / a config DSL — rejected as inner-platform.
- v1→v2 migrator — no users with overrides assumed.

## Files touched (expected)

- `config/repo-types/*.yml` — rewrite all 6 to v2.
- `src-tauri/src/domain/repo_type.rs` — restructured structs + tests.
- `src-tauri/src/config/repo_types_loader.rs` — `schema_version` gate, surface errors.
- `src-tauri/src/detection/validate.rs` — new validation module.
- `src-tauri/src/detection/builder.rs` — enrich registry, app_resolution, drop `has_feature` ifs.
- `src-tauri/src/detection/enrich.rs` — Enricher trait + impls registry.
- `src-tauri/src/config/writers/` — ConfigWriter trait + registry (extract from current writer code).
- `src-tauri/src/commands/process.rs` — read `restart_delay_ms`, drop docker branch.
- `src/app/core/ipc/tauri.types.ts` — v2 mirror types.
- `src/app/features/workspace/repo-card/` — action registry, `editable`, drop docker ifs.
- `docs/migration/ipc-contract.md`, `inventory-config-ci.md` — update contract docs.
