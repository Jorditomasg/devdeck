# Repo Types v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign DevDeck's repo-type system into a clean six-block YAML schema (`detect / run / logs / config / enrich / ui`) backed by named-strategy registries, eliminating every `if repo_type == "..."` hardcode in Rust and Angular.

**Architecture:** Approach A — declarative-first. Data (marker files, commands, log patterns, ports, restart delay, UI hints) lives in YAML; behavior (config writers, repo enrichers, monorepo app-resolution, UI actions) becomes pluggable code selected by name from YAML via single-location registries. No v1 back-compat, no migrator (app is 0.9.0, no user overrides assumed); `schema_version: 2` is mandatory and the loader rejects anything else.

**Tech Stack:** Rust (serde_yaml_ng, tokio), Tauri 2, Angular 22 (zoneless signals, vitest), YAML repo-type configs.

**Branch:** Work directly on `master` (per user instruction). Conventional commits, no AI attribution.

**Design doc:** `docs/superpowers/specs/2026-06-21-repo-types-v2-design.md`

**Verification commands:**
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml` (needs `npm run build` first if Tauri context is touched; pure unit tests usually run without it — if the test binary fails to link, run `npm run build` once)
- Frontend: `npm test`
- Cycles guard before frontend structural changes: `npx madge --circular --extensions ts src/app`

---

## File Structure

**Rust (`src-tauri/src/`):**
- `domain/repo_type.rs` — MODIFY: restructure `RepoTypeDef` into six sub-structs (`Detect`, `Run`, `Logs`, `ConfigSpec`, `Ui`) + helpers; update tests.
- `domain/repo_info.rs` — MODIFY: add `restart_delay_ms`, `config_editable`, keep `ui_config` carrying `actions`.
- `config/repo_types_loader.rs` — MODIFY: `schema_version` gate; collect+surface validation errors instead of silent skip.
- `detection/validate.rs` — CREATE: validation of a loaded `RepoTypeDef` set (unknown writer/enricher/strategy/action, invalid regex, missing required fields).
- `detection/pipeline.rs` — MODIFY: `matches_definition` reads new `detect` paths.
- `detection/builder.rs` — MODIFY: enricher registry loop, `app_resolution`, copy new RepoInfo fields, drop `has_feature` branches.
- `detection/enrich.rs` — MODIFY: add `Enricher` trait + impls + `enrichers()` registry (wrapping existing functions).
- `config/writers.rs` — MODIFY: `ConfigWriter` trait + `writers()` registry + `writer_exists`.
- `commands/process.rs` — MODIFY: `restart_delay` reads `repo.restart_delay_ms`; delete `RESTART_DELAY_DOCKER`.

**Frontend (`src/`):**
- `core/ipc/tauri.types.ts` — MODIFY: `UiConfig.actions`, `RepoInfo.restartDelayMs`, `RepoInfo.configEditable`.
- `features/workspace/repo-card/repo-card.actions.ts` — CREATE: action registry.
- `features/workspace/repo-card/repo-card.component.ts` — MODIFY: use `configEditable` + `actions`; drop `docker-infra` literals.

**Config (`config/repo-types/`):** rewrite all 6 `*.yml` to v2.

**Docs (`docs/migration/`):** `ipc-contract.md`, `inventory-config-ci.md` — update schema/contract.

---

## Phase 1 — Rust schema v2 structs

> The schema cutover (Phases 1–3) is one atomic green→green migration: `RepoTypeDef` is read everywhere, so the workspace will not compile mid-phase. Commit at the end of Phase 3 when `cargo test` is green. Phases 1–3 may be committed together if intermediate compilation is impossible; otherwise commit per phase where it compiles.

### Task 1.1: Define the v2 sub-structs

**Files:**
- Modify: `src-tauri/src/domain/repo_type.rs` (replace the struct definitions; keep the file's module doc + the test module — tests are rewritten in Phase 2)

- [ ] **Step 1: Replace the struct block**

Replace the existing `RepoTypeDef`, `DetectionRules`, `Heuristics`, `CommandsDef`, `EnvFilesDef`, `UiConfig`, `UiSelector`, `UiInstall` definitions with the v2 shapes below. `RepoTypeDef` keeps snake_case field names (it is parsed from YAML and NOT serialized to the frontend — only `RepoInfo` is).

```rust
use serde::{Deserialize, Serialize};

/// One repo-type definition (v2 schema). Parsed from a `config/repo-types/*.yml`
/// file. `schema_version` MUST be 2; the loader rejects anything else.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RepoTypeDef {
    pub schema_version: u32,
    #[serde(rename = "type")]
    pub type_id: String,
    pub priority: i32,
    pub detect: Detect,
    pub run: Run,
    pub logs: Logs,
    pub config: ConfigSpec,
    pub enrich: Vec<String>,
    pub ui: Ui,
}

/// `detect:` — everything about matching a directory to this type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Detect {
    pub git_required: bool,
    pub files: FileRules,
    pub dirs: DirRules,
    pub patterns: PatternRules,
    pub package_json: Vec<String>,
}

impl Default for Detect {
    fn default() -> Self {
        // git_required defaults to TRUE (only docker-infra opts out).
        Self {
            git_required: true,
            files: FileRules::default(),
            dirs: DirRules::default(),
            patterns: PatternRules::default(),
            package_json: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FileRules {
    pub required: Vec<String>,
    pub excluded: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DirRules {
    pub required: Vec<String>,
    pub excluded: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PatternRules {
    #[serde(rename = "match")]
    pub match_globs: Vec<String>,
    pub search_dirs: Vec<String>,
}

/// `run:` — lifecycle commands and process behavior.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Run {
    pub install: OsCommand,
    pub reinstall: OsCommand,
    pub start: OsCommand,
    pub stop: OsCommand,
    /// Card restart delay; `None` ⇒ caller's default (300 ms).
    pub restart_delay_ms: Option<u64>,
    pub app_resolution: Option<AppResolution>,
}

/// A command with optional per-OS overrides. `resolved()` picks the OS-specific
/// form when present, else `default`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OsCommand {
    pub default: Option<String>,
    pub windows: Option<String>,
    pub unix: Option<String>,
}

impl OsCommand {
    pub fn resolved(&self) -> Option<String> {
        let os = if cfg!(windows) {
            self.windows.as_ref()
        } else {
            self.unix.as_ref()
        };
        os.or(self.default.as_ref()).cloned()
    }
}

/// `run.app_resolution:` — generalizes the v1 Nx-only `{main_app}` substitution.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppResolution {
    /// Placeholder token in `run.start` to replace, e.g. `main_app`.
    pub placeholder: String,
    /// Directory scanned for candidate apps, e.g. `apps`.
    pub scan_dir: String,
    /// Strategy name: `first_alphabetical` | `single_dir` | `from_workspace_file`.
    pub strategy: String,
}

/// `logs:` — output parsing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Logs {
    pub ready: Option<String>,
    pub error: Option<String>,
    pub ports: Vec<String>,
}

/// `config:` — env/config file discovery + write strategy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ConfigSpec {
    /// Named writer strategy: `raw` | `spring` | `angular` | …
    pub writer: String,
    pub dir: String,
    pub main_file: String,
    pub patterns: Vec<String>,
    pub pull_ignore: Vec<String>,
    pub exclude_dirs: Option<Vec<String>>,
    pub implicit_default_profile: bool,
    /// Whether this type exposes editable env/config (docker-infra: false).
    pub editable: bool,
}

impl Default for ConfigSpec {
    fn default() -> Self {
        Self {
            writer: "raw".to_string(),
            dir: String::new(),
            main_file: String::new(),
            patterns: Vec::new(),
            pull_ignore: Vec::new(),
            exclude_dirs: None,
            implicit_default_profile: false,
            editable: true,
        }
    }
}

impl ConfigSpec {
    /// Absent `exclude_dirs` ⇒ default prune set (v1 parity).
    pub fn effective_exclude_dirs(&self) -> Vec<String> {
        match &self.exclude_dirs {
            Some(dirs) => dirs.clone(),
            None => vec![".git".to_string(), "node_modules".to_string()],
        }
    }
}

/// `ui:` — presentation hints; unknown keys round-trip via `extra`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Ui {
    pub icon: Option<String>,
    pub color: Option<String>,
    pub selectors: Vec<UiSelector>,
    pub install_check_dirs: Vec<String>,
    /// Declared action buttons, e.g. `["seed"]`; resolved by the frontend registry.
    pub actions: Vec<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiSelector {
    pub label: String,
}
```

- [ ] **Step 2: Confirm it compiles in isolation (will not yet — consumers break)**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | head -40`
Expected: errors ONLY in `pipeline.rs`, `builder.rs`, `repo_types_loader.rs`, `writers.rs`, `process.rs` (consumers using old field names). No errors inside `repo_type.rs` itself. This confirms the struct block is internally valid; consumers are fixed in Phases 2–3.

---

## Phase 2 — Rewrite the 6 YAMLs, version gate, validation

### Task 2.1: Rewrite the six bundled YAMLs to v2

**Files:**
- Modify: `config/repo-types/spring-boot.yml`
- Modify: `config/repo-types/nx-workspace.yml`
- Modify: `config/repo-types/angular.yml`
- Modify: `config/repo-types/maven-lib.yml`
- Modify: `config/repo-types/react.yml`
- Modify: `config/repo-types/docker-infra.yml`

- [ ] **Step 1: Write `spring-boot.yml`**

```yaml
schema_version: 2
type: "spring-boot"
priority: 60
detect:
  files:
    required: ["pom.xml"]
  dirs:
    required: ["src/main/resources"]
  patterns:
    match: ["application*.yml", "application*.yaml", "application*.properties"]
    search_dirs: ["src/main/resources"]
run:
  install: { default: "mvn clean install -DskipTests -B" }
  start: { default: "mvn spring-boot:run", unix: "./mvnw spring-boot:run" }
logs:
  ready: "Started \\w+ in"
  error: "Application run failed"
  ports:
    - "Tomcat (?:started on|initialized with) port.*?(\\d+)"
    - "http://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])[:\\s]+(\\d+)"
config:
  writer: "spring"
  dir: "src/main/resources"
  main_file: "application.yml"
  patterns: ["application*.yml", "application*.yaml", "application*.properties"]
  implicit_default_profile: true
enrich: ["java_version"]
ui:
  icon: "🍃"
  color: "#22c55e"
  selectors: [{ label: "App:" }]
  install_check_dirs: ["target"]
```

- [ ] **Step 2: Write `nx-workspace.yml`**

```yaml
schema_version: 2
type: "nx-workspace"
priority: 50
detect:
  files:
    required: ["package.json", "nx.json"]
run:
  install: { default: "npm i" }
  reinstall: { unix: "rm -rf node_modules && npm i" }
  start: { default: "npx nx serve {main_app}" }
  app_resolution:
    placeholder: "main_app"
    scan_dir: "apps"
    strategy: "first_alphabetical"
logs:
  ready: "localhost:\\d+|Local:.*http|compiled|Listening on"
  ports:
    - "Local:\\s*http://localhost:(\\d+)"
    - "http://localhost:(\\d+)"
    - "Listening on.*?(\\d+)"
config:
  writer: "angular"
  dir: "apps/default/src/environments"
  patterns: ["environment*.ts", ".env", ".env.*"]
ui:
  icon: "🅰"
  color: "#ef4444"
```

- [ ] **Step 3: Write `angular.yml`**

```yaml
schema_version: 2
type: "angular"
priority: 40
detect:
  files:
    required: ["package.json", "angular.json"]
run:
  install: { default: "npm i" }
  start: { default: "npx ng serve" }
logs:
  ready: "compiled successfully|build at"
  ports:
    - "Local:\\s*http://localhost:(\\d+)"
    - "http://localhost:(\\d+)"
config:
  writer: "angular"
  dir: "src/environments"
  patterns: ["environment*.ts"]
ui:
  icon: "🅰"
  color: "#ef4444"
```

- [ ] **Step 4: Write `maven-lib.yml`**

```yaml
schema_version: 2
type: "maven-lib"
priority: 20
detect:
  files:
    required: ["pom.xml"]
  dirs:
    required: ["src"]
    excluded: ["src/main/resources"]
run:
  install: { default: "mvn clean install -DskipTests -B" }
  start: { default: "mvn clean install -DskipTests -B" }
logs:
  ready: "BUILD SUCCESS"
  error: "BUILD FAILURE"
config:
  exclude_dirs: []
enrich: ["java_version"]
ui:
  icon: "📦"
  color: "#f97316"
  install_check_dirs: ["target"]
```

- [ ] **Step 5: Write `react.yml`**

```yaml
schema_version: 2
type: "react"
priority: 10
detect:
  files:
    required: ["package.json"]
    excluded: ["angular.json", "nx.json"]
  package_json: ["react", "react-dom"]
run:
  install: { default: "npm ci" }
  start: { default: "npm start" }
logs:
  ready: "compiled successfully|Compiled|localhost:\\d+"
  ports:
    - "Local:\\s*http://localhost:(\\d+)"
    - "http://(?:localhost|127\\.0\\.0\\.1):(\\d+)"
    - "(?:listening on|bound to).*?port\\s+(\\d+)"
config:
  writer: "raw"
  dir: "."
  patterns: [".env*"]
ui:
  icon: "⚛️"
  color: "#61dafb"
```

- [ ] **Step 6: Write `docker-infra.yml`**

```yaml
schema_version: 2
type: "docker-infra"
priority: 0
detect:
  git_required: false
  patterns:
    match: ["docker-compose*.yml", "docker-compose*.yaml"]
run:
  install: { default: "" }
  start: { default: "docker-compose up -d" }
  stop: { default: "docker-compose down" }
  restart_delay_ms: 2000
config:
  writer: "raw"
  dir: "."
  patterns: [".env"]
  editable: false
enrich: ["docker_checkboxes"]
ui:
  icon: "🐳"
  color: "#3b82f6"
  actions: ["seed"]
```

### Task 2.2: Rewrite the round-trip + priority tests

**Files:**
- Modify: `src-tauri/src/domain/repo_type.rs` (the `#[cfg(test)] mod tests` block, ~lines 245–382)

- [ ] **Step 1: Update the fixture loader and round-trip test**

The `include_str!` constants and `all_defs()` stay as-is (same 6 paths). Replace the round-trip test body to also assert `schema_version == 2`, and add field-level assertions for the v2 shape:

```rust
#[test]
fn all_six_definitions_parse_and_round_trip() {
    for (name, def) in all_defs() {
        assert_eq!(def.type_id, name, "type id mismatch in {name}.yml");
        assert_eq!(def.schema_version, 2, "{name}.yml must be schema_version 2");
        let serialized = serde_yaml_ng::to_string(&def)
            .unwrap_or_else(|e| panic!("{name} failed to serialize: {e}"));
        let reparsed: RepoTypeDef = serde_yaml_ng::from_str(&serialized)
            .unwrap_or_else(|e| panic!("{name} round-trip parse failed: {e}"));
        assert_eq!(def, reparsed, "{name}.yml does not round-trip");
    }
}
```

- [ ] **Step 2: Keep the priority ladder test (unchanged ladder), add v2 field assertions**

The `priority_ladder_is_explicit_and_unambiguous` test stays as-is. Add a new test asserting the v2-specific fields that the design promises:

```rust
#[test]
fn v2_fields_match_design() {
    let defs: std::collections::HashMap<String, RepoTypeDef> = all_defs()
        .into_iter()
        .map(|(n, d)| (n.to_string(), d))
        .collect();

    // docker-infra: no git, restart delay carried as data, seed action, not editable.
    let docker = &defs["docker-infra"];
    assert!(!docker.detect.git_required);
    assert_eq!(docker.run.restart_delay_ms, Some(2000));
    assert!(!docker.config.editable);
    assert_eq!(docker.ui.actions, vec!["seed".to_string()]);
    assert_eq!(docker.run.stop.default.as_deref(), Some("docker-compose down"));

    // spring-boot: spring writer, java_version enricher, implicit default profile.
    let spring = &defs["spring-boot"];
    assert_eq!(spring.config.writer, "spring");
    assert!(spring.config.implicit_default_profile);
    assert_eq!(spring.enrich, vec!["java_version".to_string()]);
    assert_eq!(
        spring.run.start.unix.as_deref(),
        Some("./mvnw spring-boot:run")
    );

    // react: package_json gate present.
    assert_eq!(
        defs["react"].detect.package_json,
        vec!["react".to_string(), "react-dom".to_string()]
    );

    // nx: app_resolution generalizes {main_app}.
    let nx = defs["nx-workspace"].run.app_resolution.clone().unwrap();
    assert_eq!(nx.placeholder, "main_app");
    assert_eq!(nx.scan_dir, "apps");
    assert_eq!(nx.strategy, "first_alphabetical");

    // maven-lib: explicit empty exclude_dirs (prune nothing).
    assert_eq!(defs["maven-lib"].config.exclude_dirs, Some(vec![]));
    // editable defaults true when omitted.
    assert!(defs["maven-lib"].config.editable);
    // git_required defaults true when omitted.
    assert!(defs["maven-lib"].detect.git_required);
}
```

- [ ] **Step 3: Run the repo_type tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml domain::repo_type 2>&1 | tail -30`
Expected: these tests PASS (the rest of the crate may still fail to compile — that is fixed in Phase 3; if the crate does not compile yet, this step is deferred to the end of Phase 3 and you proceed to Task 2.3).

### Task 2.3: Schema-version gate + validation module

**Files:**
- Create: `src-tauri/src/detection/validate.rs`
- Modify: `src-tauri/src/config/repo_types_loader.rs` (parse loop ~lines 61–99)
- Modify: `src-tauri/src/detection/mod.rs` (add `pub mod validate;`)

- [ ] **Step 1: Write the validation module with a failing test**

Create `src-tauri/src/detection/validate.rs`:

```rust
//! Validation of loaded repo-type definitions. Unlike v1 (which silently
//! dropped broken YAML), v2 surfaces precise errors: wrong schema version,
//! unknown writer/enricher/app-resolution strategy/UI action, invalid regex.

use crate::config::writers::writer_exists;
use crate::detection::enrich::enricher_exists;
use crate::domain::repo_type::RepoTypeDef;

const KNOWN_STRATEGIES: &[&str] = &["first_alphabetical", "single_dir", "from_workspace_file"];
const KNOWN_ACTIONS: &[&str] = &["seed"];

/// A single validation problem, tied to the offending type id.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidationError {
    pub type_id: String,
    pub message: String,
}

/// Validate one definition. Returns all problems found (does not short-circuit).
pub fn validate_def(def: &RepoTypeDef) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    let err = |msg: String| ValidationError {
        type_id: def.type_id.clone(),
        message: msg,
    };

    if def.schema_version != 2 {
        errors.push(err(format!(
            "schema_version must be 2, got {}",
            def.schema_version
        )));
    }
    if def.type_id.is_empty() {
        errors.push(err("missing `type`".to_string()));
    }
    if !writer_exists(&def.config.writer) {
        errors.push(err(format!("unknown config writer '{}'", def.config.writer)));
    }
    for name in &def.enrich {
        if !enricher_exists(name) {
            errors.push(err(format!("unknown enricher '{name}'")));
        }
    }
    for action in &def.ui.actions {
        if !KNOWN_ACTIONS.contains(&action.as_str()) {
            errors.push(err(format!("unknown ui action '{action}'")));
        }
    }
    if let Some(ar) = &def.run.app_resolution {
        if !KNOWN_STRATEGIES.contains(&ar.strategy.as_str()) {
            errors.push(err(format!(
                "unknown app_resolution strategy '{}'",
                ar.strategy
            )));
        }
    }
    for re in def
        .logs
        .ports
        .iter()
        .chain(def.logs.ready.iter())
        .chain(def.logs.error.iter())
    {
        if let Err(e) = regex::Regex::new(re) {
            errors.push(err(format!("invalid regex '{re}': {e}")));
        }
    }
    errors
}

/// Validate a whole set; returns the flattened error list.
pub fn validate_all(defs: &[RepoTypeDef]) -> Vec<ValidationError> {
    defs.iter().flat_map(validate_def).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::repo_type::RepoTypeDef;

    fn base() -> RepoTypeDef {
        RepoTypeDef {
            schema_version: 2,
            type_id: "x".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn rejects_wrong_schema_version() {
        let mut def = base();
        def.schema_version = 1;
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("schema_version")));
    }

    #[test]
    fn rejects_unknown_writer() {
        let mut def = base();
        def.config.writer = "toml".to_string();
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("unknown config writer")));
    }

    #[test]
    fn rejects_unknown_enricher_and_action_and_strategy() {
        let mut def = base();
        def.enrich = vec!["bogus".to_string()];
        def.ui.actions = vec!["nope".to_string()];
        def.run.app_resolution = Some(crate::domain::repo_type::AppResolution {
            placeholder: "x".into(),
            scan_dir: "apps".into(),
            strategy: "weird".into(),
        });
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("unknown enricher")));
        assert!(errs.iter().any(|e| e.message.contains("unknown ui action")));
        assert!(errs.iter().any(|e| e.message.contains("app_resolution strategy")));
    }

    #[test]
    fn rejects_invalid_regex() {
        let mut def = base();
        def.logs.ports = vec!["(".to_string()];
        let errs = validate_def(&def);
        assert!(errs.iter().any(|e| e.message.contains("invalid regex")));
    }

    #[test]
    fn accepts_clean_default() {
        // writer "raw" is known; no enrich/actions/strategy.
        assert!(validate_def(&base()).is_empty());
    }
}
```

> NOTE: `writer_exists` and `enricher_exists` are created in Phases 4 and 5. If implementing strictly in order, temporarily stub them as `pub fn writer_exists(_: &str) -> bool { true }` etc., then tighten in Phases 4–5. The validation tests for writer/enricher will then be completed in those phases.

- [ ] **Step 2: Register the module**

In `src-tauri/src/detection/mod.rs`, add:

```rust
pub mod validate;
```

- [ ] **Step 3: Add the version gate + error surfacing in the loader**

In `src-tauri/src/config/repo_types_loader.rs`, change the `match serde_yaml_ng::from_str` arm in `load_defs_from_dir` so a parsed def with `schema_version != 2` is logged as an error (not silently kept):

```rust
match serde_yaml_ng::from_str::<RepoTypeDef>(&raw) {
    Ok(def) if def.type_id.is_empty() => {
        log::warn!("repo-type file {} has no `type` — skipped", path.display());
    }
    Ok(def) if def.schema_version != 2 => {
        log::error!(
            "repo-type file {} has unsupported schema_version {} (expected 2) — skipped",
            path.display(),
            def.schema_version
        );
    }
    Ok(def) => defs.push(def),
    Err(e) => {
        log::error!("invalid repo-type file {}: {e}", path.display());
    }
}
```

- [ ] **Step 4: Surface validation errors after load**

In `load_repo_type_defs` (the public entry that merges bundled + user dirs and returns the Vec), after building the merged Vec, run validation and log each error. Add near the end, before returning:

```rust
let errors = crate::detection::validate::validate_all(&defs);
for e in &errors {
    log::error!("repo-type '{}' invalid: {}", e.type_id, e.message);
}
// Drop invalid defs so detection never matches a broken type.
let invalid: std::collections::HashSet<String> =
    errors.iter().map(|e| e.type_id.clone()).collect();
defs.retain(|d| !invalid.contains(&d.type_id));
```

> If `load_repo_type_defs` currently returns from a `BTreeMap`, collect to a `Vec` first (it already sorts later via `sort_by_priority`), then apply the retain.

- [ ] **Step 5: Run validation tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml validate 2>&1 | tail -30`
Expected: PASS (with stubs if Phases 4–5 not yet done).

---

## Phase 3 — Update Rust consumers to v2 field paths

### Task 3.1: Detection pipeline reads new `detect` paths

**Files:**
- Modify: `src-tauri/src/detection/pipeline.rs` (`matches_definition`, `check_pattern_heuristics`, `check_package_json`)

- [ ] **Step 1: Update `matches_definition`**

Replace the v1 field accesses with v2 paths (behavior identical):

```rust
pub fn matches_definition(
    repo_root: &Path,
    files_in_root: &HashSet<String>,
    def: &RepoTypeDef,
) -> bool {
    // 1. Git gate — `.git` dir required unless git_required: false.
    if def.detect.git_required && !repo_root.join(".git").is_dir() {
        return false;
    }
    // 2. required files.
    if !def.detect.files.required.iter().all(|f| files_in_root.contains(f)) {
        return false;
    }
    // 3. excluded files.
    if def.detect.files.excluded.iter().any(|f| files_in_root.contains(f)) {
        return false;
    }
    // 4. directory rules.
    if !def.detect.dirs.required.iter().all(|d| repo_root.join(d).is_dir()) {
        return false;
    }
    if def.detect.dirs.excluded.iter().any(|d| repo_root.join(d).is_dir()) {
        return false;
    }
    // 5. pattern heuristics (with search_dirs fallback).
    if !check_pattern_heuristics(repo_root, files_in_root, &def.detect.patterns) {
        return false;
    }
    // 6. package.json gate.
    if !check_package_json(repo_root, &def.detect.package_json) {
        return false;
    }
    true
}
```

- [ ] **Step 2: Update `check_pattern_heuristics` signature to take `&PatternRules`**

```rust
fn check_pattern_heuristics(
    repo_root: &Path,
    files_in_root: &HashSet<String>,
    patterns: &crate::domain::repo_type::PatternRules,
) -> bool {
    let globs = &patterns.match_globs;
    if globs.is_empty() {
        return true;
    }
    if files_in_root.iter().any(|f| globs.iter().any(|p| fnmatch(f, p))) {
        return true;
    }
    for dir in &patterns.search_dirs {
        let target = repo_root.join(dir);
        if !target.is_dir() {
            continue;
        }
        if plain_file_names(&target)
            .iter()
            .any(|f| globs.iter().any(|p| fnmatch(f, p)))
        {
            return true;
        }
    }
    false
}
```

`check_package_json` is unchanged (still takes `&[String]`).

- [ ] **Step 3: Run detection tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml detection::pipeline 2>&1 | tail -30`
Expected: existing detection tests PASS unchanged (same classification behavior). If the test fixtures referenced old field names, update them to the new paths.

### Task 3.2: Builder reads v2 paths, copies new RepoInfo fields, app-resolution

**Files:**
- Modify: `src-tauri/src/domain/repo_info.rs` (add fields)
- Modify: `src-tauri/src/detection/builder.rs`

- [ ] **Step 1: Add new fields to `RepoInfo`**

In `src-tauri/src/domain/repo_info.rs`, add to the `RepoInfo` struct (camelCase wire names preserved via the struct's existing `#[serde(rename_all = "camelCase")]`):

```rust
    /// Card restart delay in ms; `None` ⇒ default 300 (was hardcoded per-type).
    pub restart_delay_ms: Option<u64>,
    /// Whether this repo exposes editable env/config (docker-infra: false).
    pub config_editable: bool,
```

> `config_editable` must default to `true` for any code path that constructs `RepoInfo::default()`. If `RepoInfo` derives `Default`, add a manual `Default` impl OR set it explicitly in `build_repo_info` (done below) — and audit other `RepoInfo` constructors (tests) to set it. Simplest: keep `Default` deriving (so it is `false` by default) but always set it in `build_repo_info`; update test fixtures that rely on it.

- [ ] **Step 2: Update `build_repo_info` to v2 paths + new fields + enricher loop**

Rewrite the body of `build_repo_info` in `builder.rs`:

```rust
pub fn build_repo_info(name: &str, path: &Path, def: &RepoTypeDef) -> RepoInfo {
    let scan = resolve_env_files(path, &def.config);

    let mut repo = RepoInfo {
        name: name.to_string(),
        path: path.display().to_string(),
        repo_type: def.type_id.clone(),
        run_install_cmd: def.run.install.resolved(),
        run_reinstall_cmd: def.run.reinstall.resolved(),
        run_command: resolve_run_command(path, &def.run),
        stop_command: def.run.stop.resolved(),
        restart_delay_ms: def.run.restart_delay_ms,
        config_editable: def.config.editable,
        ready_pattern: def.logs.ready.clone(),
        error_pattern: def.logs.error.clone(),
        port_patterns: def.logs.ports.clone(),
        ui_config: def.ui.clone(),
        features: def.enrich.clone(),
        environment_files: scan.files,
        profiles: scan.profiles,
        modules: scan.modules,
        env_default_dir: def.config.dir.clone(),
        env_config_writer_type: def.config.writer.clone(),
        env_pull_ignore_patterns: def.config.pull_ignore.clone(),
        env_main_config_filename: def.config.main_file.clone(),
        env_patterns: def.config.patterns.clone(),
        ..Default::default()
    };

    // Enrichers — registry-driven (replaces the v1 has_feature branches).
    for name in &def.enrich {
        if let Some(enricher) = enrich::enricher(name) {
            enricher.run(&mut repo, path);
        }
    }

    // Legacy unconditional enrichments (§22.4): Spring static info + git remote.
    let spring = enrich::spring_server_info(&repo.environment_files);
    repo.server_port = spring.port;
    repo.context_path = spring.context_path;
    repo.git_remote_url = enrich::git_remote_url(path);

    repo
}
```

> `repo.features` keeps carrying the enricher names (the frontend reads `repo.features.includes('java_version')` / `'docker_checkboxes'` for UI sections — see Phase 7; we keep that wiring but the SOURCE is now `def.enrich`). The field is renamed conceptually but the wire name `features` stays for now to avoid a frontend break beyond the planned ones.

- [ ] **Step 3: Update `resolve_run_command` / `resolve_main_app` for `app_resolution`**

Replace `resolve_run_command` and `resolve_main_app` in `builder.rs`:

```rust
pub fn resolve_run_command(repo_root: &Path, run: &Run) -> Option<String> {
    let cmd = run.start.resolved()?;
    let Some(ar) = &run.app_resolution else {
        return Some(cmd);
    };
    let token = format!("{{{}}}", ar.placeholder); // e.g. "{main_app}"
    if !cmd.contains(&token) {
        return Some(cmd);
    }
    let app = resolve_app(repo_root, ar);
    Some(cmd.replace(&token, &format!("\"{app}\"")))
}

/// Resolve the app name for a monorepo, by the declared strategy.
fn resolve_app(repo_root: &Path, ar: &AppResolution) -> String {
    let scan = repo_root.join(&ar.scan_dir);
    let mut dirs: Vec<String> = match std::fs::read_dir(&scan) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect(),
        Err(_) => return "app".to_string(),
    };
    match ar.strategy.as_str() {
        "single_dir" => dirs.into_iter().next().unwrap_or_else(|| "app".to_string()),
        // first_alphabetical (default) and any unhandled strategy:
        _ => {
            dirs.sort();
            dirs.into_iter().next().unwrap_or_else(|| "app".to_string())
        }
    }
}
```

> `from_workspace_file` is declared as a known strategy for forward-compat but not yet implemented; it falls through to alphabetical. That is acceptable — no shipped YAML uses it. (If you prefer, add a `log::warn!` for unimplemented strategies.)

- [ ] **Step 4: Update `resolve_env_files` signature**

`resolve_env_files` currently takes `&EnvFilesDef`. Change it to take `&ConfigSpec` and update its internal field reads (`default_dir`→`dir`, `patterns`→`patterns`, `effective_exclude_dirs()` unchanged, `implicit_default_profile` unchanged, `main_config_filename`→`main_file`). Update its signature and call site.

- [ ] **Step 5: Run builder/detection tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml detection 2>&1 | tail -40`
Expected: PASS. Add/adjust a test asserting `build_repo_info` for docker-infra sets `restart_delay_ms == Some(2000)` and `config_editable == false`, and for spring-boot sets `config_editable == true`.

### Task 3.3: process.rs restart delay from data

**Files:**
- Modify: `src-tauri/src/commands/process.rs` (constants ~25–30, `restart_delay` ~307–315)

- [ ] **Step 1: Replace the resolver and drop the docker constant**

```rust
/// Card restart delay for ordinary processes (inventory-gui.md §28).
pub(crate) const RESTART_DELAY: Duration = Duration::from_millis(300);

// RESTART_DELAY_DOCKER deleted — the value now lives in docker-infra.yml
// as run.restart_delay_ms.

/// Restart delay for a repo: the type's declared `restart_delay_ms`, else 300 ms.
pub(crate) fn restart_delay(repo: &RepoInfo) -> Duration {
    repo.restart_delay_ms
        .map(Duration::from_millis)
        .unwrap_or(RESTART_DELAY)
}
```

- [ ] **Step 2: Add a behavior-parity test**

Add to the `process.rs` test module (or wherever `restart_delay` is tested; create one if absent):

```rust
#[test]
fn restart_delay_uses_declared_value_then_default() {
    let mut repo = RepoInfo { restart_delay_ms: Some(2000), ..Default::default() };
    assert_eq!(restart_delay(&repo), Duration::from_millis(2000));
    repo.restart_delay_ms = None;
    assert_eq!(restart_delay(&repo), Duration::from_millis(300));
}
```

- [ ] **Step 3: Verify no `repo_type == "docker-infra"` remains in Rust**

Run: `rg 'repo_type\s*==\s*"docker-infra"' src-tauri/src`
Expected: NO matches.

- [ ] **Step 4: Full Rust test suite green (end of schema cutover)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -30`
Expected: PASS. (If link errors mention Tauri context, run `npm run build` once, then re-run.)

- [ ] **Step 5: Commit Phases 1–3**

```bash
git add -A
git commit -m "refactor(repo-types): v2 six-block schema + version gate + validation"
```

---

## Phase 4 — Config writers registry

**Files:**
- Modify: `src-tauri/src/config/writers.rs`

- [ ] **Step 1: Write a failing test for `writer_exists`**

Add to the `writers.rs` test module:

```rust
#[test]
fn known_writers_registered() {
    assert!(writer_exists("raw"));
    assert!(writer_exists("spring"));
    assert!(writer_exists("angular"));
    assert!(!writer_exists("toml"));
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml writers::tests::known_writers_registered 2>&1 | tail -10`
Expected: FAIL — `writer_exists` not defined.

- [ ] **Step 2: Introduce the trait + registry, keep behavior identical**

Refactor `writers.rs`. Keep `write_spring_config` / `write_config_file_raw` as-is (they are the implementations). Add:

```rust
/// A named strategy for writing the ACTIVE environment/config file.
pub trait ConfigWriter: Sync {
    fn name(&self) -> &'static str;
    fn write_active(&self, target_file: &Path, profile: &str, content: &str) -> DomainResult<()>;
}

struct RawWriter;
impl ConfigWriter for RawWriter {
    fn name(&self) -> &'static str { "raw" }
    fn write_active(&self, target_file: &Path, _profile: &str, content: &str) -> DomainResult<()> {
        write_config_file_raw(target_file, content)
    }
}

struct AngularWriter;
impl ConfigWriter for AngularWriter {
    fn name(&self) -> &'static str { "angular" }
    fn write_active(&self, target_file: &Path, _profile: &str, content: &str) -> DomainResult<()> {
        write_config_file_raw(target_file, content)
    }
}

struct SpringWriter;
impl ConfigWriter for SpringWriter {
    fn name(&self) -> &'static str { "spring" }
    fn write_active(&self, target_file: &Path, profile: &str, content: &str) -> DomainResult<()> {
        let resources_dir = target_file.parent().ok_or_else(|| {
            DomainError::Configuration(format!(
                "spring target '{}' has no parent dir",
                target_file.display()
            ))
        })?;
        write_spring_config(resources_dir, profile, content)
    }
}

/// THE single place writers are registered. Add new writers here.
fn writers() -> &'static [&'static dyn ConfigWriter] {
    &[&RawWriter, &AngularWriter, &SpringWriter]
}

/// Look up a writer by name; unknown names fall back to `raw` (v1 parity).
fn writer_for(name: &str) -> &'static dyn ConfigWriter {
    writers()
        .iter()
        .copied()
        .find(|w| w.name() == name)
        .unwrap_or(&RawWriter)
}

/// True when `name` is a registered writer (used by validation).
pub fn writer_exists(name: &str) -> bool {
    writers().iter().any(|w| w.name() == name)
}
```

Then rewrite the public dispatch to use the registry:

```rust
pub fn write_active_environment(
    writer_type: &str,
    target_file: &Path,
    profile: &str,
    content: &str,
) -> DomainResult<()> {
    writer_for(writer_type).write_active(target_file, profile, content)
}
```

> `&RawWriter` etc. as `&'static dyn ConfigWriter` requires the writer structs to be zero-sized unit structs with `'static` references — `&RawWriter` of a unit struct is a `'static` reference to a const-promotable value, which Rust allows. If the borrow checker objects, declare `static RAW: RawWriter = RawWriter;` and reference `&RAW`.

- [ ] **Step 3: Tighten `validate.rs` (remove the `writer_exists` stub)**

If you stubbed `writer_exists` in Phase 2, it is now the real one — delete the stub. The validation test `rejects_unknown_writer` should now pass.

- [ ] **Step 4: Run writer + validation tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml writers 2>&1 | tail -20 && cargo test --manifest-path src-tauri/Cargo.toml validate 2>&1 | tail -20`
Expected: PASS, including the spring-YAML-validation behavior preserved (the existing `write_spring_config` invalid-YAML test still passes).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(repo-types): config writers as a named-strategy registry"
```

---

## Phase 5 — Enrichers registry

**Files:**
- Modify: `src-tauri/src/detection/enrich.rs`

- [ ] **Step 1: Write a failing test for `enricher_exists`**

Add to the `enrich.rs` test module:

```rust
#[test]
fn known_enrichers_registered() {
    assert!(enricher_exists("java_version"));
    assert!(enricher_exists("docker_checkboxes"));
    assert!(!enricher_exists("bogus"));
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml enrich::tests::known_enrichers_registered 2>&1 | tail -10`
Expected: FAIL — not defined.

- [ ] **Step 2: Add the `Enricher` trait + impls wrapping existing functions**

Keep `java_version_for_repo`, `find_docker_compose_files`, `spring_server_info`, `git_remote_url` exactly as-is. Add:

```rust
use crate::domain::repo_info::RepoInfo;

/// A named enrichment applied to a `RepoInfo` after detection.
pub trait Enricher: Sync {
    fn name(&self) -> &'static str;
    fn run(&self, repo: &mut RepoInfo, path: &Path);
}

struct JavaVersionEnricher;
impl Enricher for JavaVersionEnricher {
    fn name(&self) -> &'static str { "java_version" }
    fn run(&self, repo: &mut RepoInfo, path: &Path) {
        repo.java_version = java_version_for_repo(path);
    }
}

struct DockerCheckboxesEnricher;
impl Enricher for DockerCheckboxesEnricher {
    fn name(&self) -> &'static str { "docker_checkboxes" }
    fn run(&self, repo: &mut RepoInfo, path: &Path) {
        repo.docker_compose_files = find_docker_compose_files(path);
    }
}

/// THE single place enrichers are registered. Add new enrichers here.
fn enrichers() -> &'static [&'static dyn Enricher] {
    &[&JavaVersionEnricher, &DockerCheckboxesEnricher]
}

/// Look up an enricher by name (used by the builder).
pub fn enricher(name: &str) -> Option<&'static dyn Enricher> {
    enrichers().iter().copied().find(|e| e.name() == name)
}

/// True when `name` is a registered enricher (used by validation).
pub fn enricher_exists(name: &str) -> bool {
    enrichers().iter().any(|e| e.name() == name)
}
```

- [ ] **Step 3: Confirm the builder uses `enrich::enricher(...)` (done in Phase 3.2)**

Verify `build_repo_info` already loops `for name in &def.enrich { if let Some(e) = enrich::enricher(name) { e.run(&mut repo, path); } }` and that no `has_feature` branch remains.

Run: `rg 'has_feature' src-tauri/src`
Expected: only the `RepoInfo::has_feature` definition may remain (it can stay; it is harmless). NO call sites in `builder.rs`.

- [ ] **Step 4: Tighten `validate.rs` (remove `enricher_exists` stub) and run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml enrich 2>&1 | tail -20 && cargo test --manifest-path src-tauri/Cargo.toml detection::builder 2>&1 | tail -20`
Expected: PASS. Add a test asserting `build_repo_info` runs the java_version enricher for a fixture repo with a pom declaring `<java.version>17`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(repo-types): repo enrichers as a named-strategy registry"
```

---

## Phase 6 — App-resolution parity check

> The mechanism was implemented in Phase 3.2. This phase only adds a focused parity test proving the Nx behavior is preserved.

**Files:**
- Modify: `src-tauri/src/detection/builder.rs` (test module)

- [ ] **Step 1: Add a parity test using a temp dir**

```rust
#[test]
fn app_resolution_first_alphabetical_matches_v1() {
    let tmp = tempfile::tempdir().unwrap();
    let apps = tmp.path().join("apps");
    std::fs::create_dir_all(apps.join("zeta")).unwrap();
    std::fs::create_dir_all(apps.join("alpha")).unwrap();
    std::fs::create_dir_all(apps.join(".hidden")).unwrap();

    let run = Run {
        start: OsCommand { default: Some("npx nx serve {main_app}".into()), ..Default::default() },
        app_resolution: Some(AppResolution {
            placeholder: "main_app".into(),
            scan_dir: "apps".into(),
            strategy: "first_alphabetical".into(),
        }),
        ..Default::default()
    };
    let cmd = resolve_run_command(tmp.path(), &run).unwrap();
    assert_eq!(cmd, "npx nx serve \"alpha\"");
}
```

> If `tempfile` is not already a dev-dependency, check `src-tauri/Cargo.toml [dev-dependencies]`. The repo likely already uses it for detection tests (the explore found temp-dir-based tests). If absent, add `tempfile` to dev-dependencies.

- [ ] **Step 2: Run + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml app_resolution 2>&1 | tail -10`
Expected: PASS.

```bash
git add -A
git commit -m "test(repo-types): app-resolution parity for monorepo {main_app}"
```

---

## Phase 7 — Frontend: editable + action registry, drop docker literals

### Task 7.1: Extend IPC types

**Files:**
- Modify: `src/app/core/ipc/tauri.types.ts`

- [ ] **Step 1: Add `actions` to `UiConfig`, new fields to `RepoInfo`**

In `UiConfig`:

```typescript
export interface UiConfig {
  readonly icon?: string;
  readonly color?: string;
  readonly selectors: readonly UiSelector[];
  readonly install: UiInstall;
  /** Declared action buttons (e.g. ["seed"]); resolved by the repo-card action registry. */
  readonly actions?: readonly string[];
  readonly [extra: string]: unknown;
}
```

In `RepoInfo`, add:

```typescript
  /** Card restart delay in ms; absent ⇒ backend default. */
  readonly restartDelayMs?: number;
  /** Whether this repo exposes editable env/config (docker-infra: false). */
  readonly configEditable: boolean;
```

> Update the `repo()` test factory in `src/app/core/state/repos.store.spec.ts` to include `configEditable: true` so existing specs still compile.

### Task 7.2: Action registry

**Files:**
- Create: `src/app/features/workspace/repo-card/repo-card.actions.ts`

- [ ] **Step 1: Create the action registry**

```typescript
import { CMD, type IpcCommandName } from '../../../core/ipc/commands';

/** Metadata for one declarable repo-card action button. */
export interface RepoCardAction {
  readonly key: string;
  readonly icon: string;
  /** i18n key for the button label/tooltip. */
  readonly labelKey: string;
  readonly command: IpcCommandName;
}

/** THE single place repo-card actions are registered. Add new actions here. */
export const REPO_CARD_ACTIONS: Readonly<Record<string, RepoCardAction>> = {
  seed: {
    key: 'seed',
    icon: '🌱',
    labelKey: 'repo.action.seed',
    command: CMD.runFlywaySeeds,
  },
};

/** Resolve declared action keys to their metadata, skipping unknown keys. */
export function resolveActions(keys: readonly string[] | undefined): RepoCardAction[] {
  return (keys ?? [])
    .map((k) => REPO_CARD_ACTIONS[k])
    .filter((a): a is RepoCardAction => !!a);
}
```

> Confirm `IpcCommandName` is the exported type for command names in `commands.ts`. If the exported type has a different name (e.g. the `CMD` const's value union), use that. `CMD.runFlywaySeeds` was confirmed present (`run_flyway_seeds`).
> Add the i18n key `repo.action.seed` to BOTH `src/assets/i18n/en.json` and `src/assets/i18n/es.json` (identical key structure is enforced). EN: `"seed": "Seed"`, ES: `"seed": "Sembrar"` under a `repo.action` group.

### Task 7.3: repo-card uses `configEditable` + actions

**Files:**
- Modify: `src/app/features/workspace/repo-card/repo-card.component.ts` (the `expandVm` computed, ~lines 320–419)

- [ ] **Step 1: Replace docker-infra literals with data**

In `expandVm`:
- `const hasEnvRows = repo.environmentFiles.length > 0 && repo.repoType !== 'docker-infra';`
  → `const hasEnvRows = repo.environmentFiles.length > 0 && repo.configEditable;`
- `showConfigBtn: !hasEnvRows && repo.repoType !== 'docker-infra',`
  → `showConfigBtn: !hasEnvRows && repo.configEditable,`
- `showSeedBtn: repo.repoType === 'docker-infra',`
  → replace with a resolved-actions list:
  ```typescript
  actions: resolveActions(repo.uiConfig.actions).map((a) => ({
    key: a.key,
    icon: a.icon,
    label: this.i18n.t(a.labelKey),
    command: a.command,
  })),
  ```
  and remove `showSeedBtn`. The template renders an `@for` over `branch.actions` (or wherever the seed button lived), invoking `a.command` via the existing IPC bridge call used by the old seed handler.
- `cmd: repo.repoType !== 'docker-infra' ? {...} : null,`
  → `cmd: repo.configEditable ? {...} : null,`

> Import `resolveActions` and `RepoCardAction` at the top of the component. Update the `CardExpandVm` type (and the `branch` sub-type) to replace `showSeedBtn: boolean` with `actions: { key: string; icon: string; label: string; command: string }[]`.
> Find the existing seed-button click handler (it calls `CMD.runFlywaySeeds` via the bridge). Generalize it to `runAction(command: string)` that invokes the given command for this repo. Keep the same args the old handler passed (likely `{ serviceId }` / repo name — match the existing call exactly).

- [ ] **Step 2: Verify no docker-infra literal remains in frontend**

Run: `rg "docker-infra" src/app`
Expected: NO matches (or only in tests that assert generic behavior — there should be none in component logic).

- [ ] **Step 3: Cycle guard + tests**

Run: `npx madge --circular --extensions ts src/app`
Expected: no new cycles.

Run: `npm test`
Expected: PASS. Add/adjust a `repo-card` spec asserting: a repo with `configEditable: false` hides the config button and env rows; a repo with `uiConfig.actions: ['seed']` renders one action button whose command is `run_flyway_seeds`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(repo-card): drive config/actions from data, drop docker-infra literals"
```

---

## Phase 8 — Docs

**Files:**
- Modify: `docs/migration/ipc-contract.md`
- Modify: `docs/migration/inventory-config-ci.md`

- [ ] **Step 1: Update the contract docs**

In `ipc-contract.md`: update the `RepoInfo` shape to include `restartDelayMs?` and `configEditable`, and note `UiConfig.actions`. In `inventory-config-ci.md`: replace the v1 YAML schema description (§1.2–§1.6) with the v2 six-block schema, the field-mapping table from the design doc, and the "adding a framework = pure YAML; adding a behavior = one registry entry" extensibility statement. Reference the registries (`config/writers.rs`, `detection/enrich.rs`, `detection/validate.rs`, `repo-card.actions.ts`) as the single extension points.

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "docs(migration): document repo-types v2 schema and capability registries"
```

---

## Final verification

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — all green
- [ ] `npm test` — all green
- [ ] `npx madge --circular --extensions ts src/app` — no cycles
- [ ] `rg 'repo_type\s*==\s*"docker-infra"' src-tauri/src` — no matches
- [ ] `rg "'docker-infra'|\"docker-infra\"" src/app` — no matches in component logic
- [ ] Manual smoke (optional, native): `npm run tauri dev`, scan a workspace, confirm spring/angular/nx/react/maven/docker cards detect, docker card shows the seed button and hides config, restart timing unchanged.
- [ ] Add a brand-new framework YAML (e.g. `go-service.yml` from the design doc) into `config/repo-types/`, rescan, confirm a Go repo is detected with ZERO code changes — this is the acceptance proof for "scalable".

## Self-review notes (author)

- **Spec coverage:** schema v2 (P1–P2), version gate + validation (P2), writers registry (P4), enrichers registry (P5), app-resolution (P3/P6), restart-delay data (P3), frontend editable+actions (P7), docs (P8). All design sections mapped.
- **Irreducible code:** new writer/enricher/action still needs one registry entry — by design (the isolated 10%).
- **Risk:** Phases 1–3 are a non-compiling window; committed together. Acceptable for a no-back-compat redesign.
