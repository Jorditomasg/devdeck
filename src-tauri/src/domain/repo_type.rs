//! Serde model of the repo-type YAML definition schema (v2 six-block schema).
//!
//! Source of truth: `docs/superpowers/specs/2026-06-21-repo-types-v2-design.md`.
//! A definition is parsed from one `config/repo-types/*.yml` file and organized
//! into six declarative blocks: `detect / run / logs / config / enrich / ui`.
//! Behavior (config writers, repo enrichers, app-resolution strategies, UI
//! actions) is pluggable code selected BY NAME from these blocks via
//! single-location registries — no `if repo_type == "..."` hardcodes remain.
//!
//! `schema_version` MUST be 2; the loader rejects anything else (no v1
//! back-compat, no migrator — the app is 0.9.0). Every block/field has a
//! sensible default, so a minimal YAML still parses; a document whose `type`
//! is missing/empty is skipped by the loader (`config::repo_types_loader`).

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
    /// Strategy name: `first_alphabetical` | `single_dir`. Validation rejects
    /// any other value (see `detection::validate`).
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

#[cfg(test)]
mod tests {
    use super::*;

    const ANGULAR: &str = include_str!("../../../config/repo-types/angular.yml");
    const DOCKER_INFRA: &str = include_str!("../../../config/repo-types/docker-infra.yml");
    const MAVEN_LIB: &str = include_str!("../../../config/repo-types/maven-lib.yml");
    const NX_WORKSPACE: &str = include_str!("../../../config/repo-types/nx-workspace.yml");
    const REACT: &str = include_str!("../../../config/repo-types/react.yml");
    const SPRING_BOOT: &str = include_str!("../../../config/repo-types/spring-boot.yml");

    fn all_defs() -> Vec<(&'static str, RepoTypeDef)> {
        [
            ("angular", ANGULAR),
            ("docker-infra", DOCKER_INFRA),
            ("maven-lib", MAVEN_LIB),
            ("nx-workspace", NX_WORKSPACE),
            ("react", REACT),
            ("spring-boot", SPRING_BOOT),
        ]
        .into_iter()
        .map(|(name, src)| {
            let def: RepoTypeDef = serde_yaml_ng::from_str(src)
                .unwrap_or_else(|e| panic!("{name}.yml failed to parse: {e}"));
            (name, def)
        })
        .collect()
    }

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

    #[test]
    fn priority_ladder_is_explicit_and_unambiguous() {
        // architecture-v2.md §5: every shipped definition has an explicit,
        // unique priority; react gets 10 to break the v1 tie with
        // docker-infra (0).
        let mut priorities: Vec<(String, i32)> = all_defs()
            .into_iter()
            .map(|(_, d)| (d.type_id.clone(), d.priority))
            .collect();
        priorities.sort_by(|a, b| b.1.cmp(&a.1));
        let expected = [
            ("spring-boot", 60),
            ("nx-workspace", 50),
            ("angular", 40),
            ("maven-lib", 20),
            ("react", 10),
            ("docker-infra", 0),
        ];
        for ((ty, prio), (exp_ty, exp_prio)) in priorities.iter().zip(expected.iter()) {
            assert_eq!(ty, exp_ty);
            assert_eq!(prio, exp_prio);
        }
    }

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

    #[test]
    fn exclude_dirs_absent_vs_empty_distinction() {
        // maven-lib ships an explicit empty list → prune nothing.
        let defs = all_defs();
        let maven = &defs.iter().find(|(n, _)| *n == "maven-lib").expect("maven").1;
        assert_eq!(maven.config.exclude_dirs, Some(vec![]));
        assert!(maven.config.effective_exclude_dirs().is_empty());

        // Absent key → v1 default {".git", "node_modules"}.
        let bare: ConfigSpec = serde_yaml_ng::from_str("dir: '.'").unwrap();
        assert_eq!(bare.exclude_dirs, None);
        let mut dirs = bare.effective_exclude_dirs();
        dirs.sort();
        assert_eq!(dirs, vec![".git".to_string(), "node_modules".to_string()]);
    }

    #[test]
    fn document_without_type_yields_empty_type_id() {
        let def: RepoTypeDef = serde_yaml_ng::from_str("priority: 5").unwrap();
        assert!(def.type_id.is_empty()); // loader must skip it
    }

    #[test]
    fn os_command_resolution() {
        // unix override wins on POSIX, windows override wins on Windows, else default.
        let cmd = OsCommand {
            default: Some("mvn spring-boot:run".into()),
            unix: Some("./mvnw spring-boot:run".into()),
            windows: None,
        };
        if cfg!(windows) {
            assert_eq!(cmd.resolved().as_deref(), Some("mvn spring-boot:run"));
        } else {
            assert_eq!(cmd.resolved().as_deref(), Some("./mvnw spring-boot:run"));
        }
        // OS-agnostic default only.
        let plain = OsCommand {
            default: Some("npm i".into()),
            ..Default::default()
        };
        assert_eq!(plain.resolved().as_deref(), Some("npm i"));
        assert_eq!(OsCommand::default().resolved(), None);
    }

    #[test]
    fn writer_defaults_to_raw_and_editable_true() {
        let def: ConfigSpec = serde_yaml_ng::from_str("dir: '.'").unwrap();
        assert_eq!(def.writer, "raw");
        assert!(def.editable);
    }
}
