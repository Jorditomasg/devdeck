//! Serde model of the repo-type YAML definition schema.
//!
//! Source of truth: inventory-config-ci.md §1.2 (v1 schema) extended with the
//! v2 schema flags decided in architecture-v2.md §5:
//! - `detection.allow_no_git` — replaces the hardcoded `docker-infra` git
//!   exemption (inventory-config-ci.md §1.3 step 1);
//! - `heuristics.pattern_search_dirs` — replaces the hardcoded spring-boot
//!   `src/main/resources` pattern fallback (§1.3 step 5);
//! - `env_files.implicit_default_profile` — replaces the hardcoded Spring
//!   `default` profile injection (§1.5);
//! - `commands.windows_reinstall_cmd` / `unix_reinstall_cmd` — v1 shipped
//!   Windows-only reinstall commands with no OS split (§22.7 backend).
//!
//! The two formerly-dead v1 keys round-trip AND are now enforced:
//! - `heuristics.must_match_package_json` — enforced by `detection/`
//!   (architecture-v2.md §7 fix 3);
//! - `commands.stop_cmd` — enforced by `process/` (§7 fix 4).
//!
//! Every block/field is optional with v1-compatible defaults, so any YAML a
//! user wrote for v1 still loads. A document whose `type` is missing/empty is
//! skipped by the loader (`config::repo_types_loader`), mirroring v1.

use serde::{Deserialize, Serialize};

/// One repo-type definition (one YAML file in `config/repo-types/`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RepoTypeDef {
    /// REQUIRED unique id (`spring-boot`, `angular`, ...). Empty means the
    /// document is invalid and must be skipped by the loader.
    #[serde(rename = "type")]
    pub type_id: String,

    /// Match order: higher priority is evaluated first; first match wins.
    /// Missing in YAML defaults to 0 (v1 behavior). All v2 shipped files set
    /// it explicitly (architecture-v2.md §5).
    pub priority: i32,

    pub detection: DetectionRules,
    pub heuristics: Heuristics,
    pub commands: CommandsDef,
    pub env_files: EnvFilesDef,
    pub ui: UiConfig,

    /// Known values: `"java_version"`, `"docker_checkboxes"`
    /// (inventory-config-ci.md §1.6).
    pub features: Vec<String>,
}

/// `detection:` block — file-existence gates on the repo root.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DetectionRules {
    /// Exact filenames that MUST all exist as plain files in the repo root.
    pub required_files: Vec<String>,
    /// Exact filenames none of which may exist in the repo root.
    pub exclude_files: Vec<String>,
    /// v2 flag: when true the candidate does not need a `.git` directory.
    /// Replaces the v1 hardcoded `docker-infra` exemption.
    pub allow_no_git: bool,
}

/// `heuristics:` block — structural checks beyond plain file existence.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Heuristics {
    /// Relative dirs that must all exist (e.g. `src/main/resources`).
    pub must_have_directories: Vec<String>,
    /// Relative dirs none of which may exist.
    pub must_not_have_directories: Vec<String>,
    /// fnmatch globs; at least one root file must match at least one glob.
    pub must_match_patterns: Vec<String>,
    /// v2 flag: extra dirs (relative) whose plain files are also tried when
    /// no root file matched `must_match_patterns`. Replaces the hardcoded
    /// spring-boot `src/main/resources` fallback.
    pub pattern_search_dirs: Vec<String>,
    /// Package names that must ALL appear in `dependencies` or
    /// `devDependencies` of the repo root `package.json`.
    /// Dead in v1 (declared in react.yml, never read — §22.5 backend);
    /// ENFORCED in v2 by `detection/` (architecture-v2.md §7 fix 3).
    pub must_match_package_json: Vec<String>,
}

/// `commands:` block — install/start/stop commands and log-driven status
/// detection patterns.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CommandsDef {
    /// Dependency install command (`npm i`, `mvn clean install ...`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_cmd: Option<String>,
    /// Used instead of `install_cmd` when the repo is already installed
    /// (all `ui.install.check_dirs` exist).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reinstall_cmd: Option<String>,
    /// v2: overrides `reinstall_cmd` on Windows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_reinstall_cmd: Option<String>,
    /// v2: overrides `reinstall_cmd` on POSIX (v1 shipped Windows-only
    /// `rmdir /s /q node_modules & npm i` — §22.7 backend).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unix_reinstall_cmd: Option<String>,
    /// Default start command.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_cmd: Option<String>,
    /// Overrides `start_cmd` on Windows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub windows_start_cmd: Option<String>,
    /// Overrides `start_cmd` on POSIX.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unix_start_cmd: Option<String>,
    /// Graceful stop command. Dead in v1 (declared in docker-infra.yml, never
    /// read — §22.6 backend); ENFORCED in v2 by `process/`: when declared,
    /// stop runs it (with timeout) instead of/before the tree-kill
    /// (architecture-v2.md §7 fix 4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_cmd: Option<String>,
    /// Regex: a log line matching it transitions `Starting → Running`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_pattern: Option<String>,
    /// Regex: a log line matching it transitions `Starting → Error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_pattern: Option<String>,
    /// Regexes with ONE capture group = detected port number.
    pub port_patterns: Vec<String>,
}

impl CommandsDef {
    /// OS-resolved start command (before `{main_app}` substitution, which is
    /// filesystem-dependent and therefore lives in `detection/`).
    /// `windows_start_cmd` wins on Windows, `unix_start_cmd` on POSIX,
    /// otherwise `start_cmd` (inventory-config-ci.md §1.4).
    pub fn resolved_start_cmd(&self) -> Option<String> {
        let override_cmd = if cfg!(windows) {
            self.windows_start_cmd.as_ref()
        } else {
            self.unix_start_cmd.as_ref()
        };
        override_cmd.or(self.start_cmd.as_ref()).cloned()
    }

    /// OS-resolved reinstall command (v2 extension; falls back to the
    /// OS-agnostic `reinstall_cmd`).
    pub fn resolved_reinstall_cmd(&self) -> Option<String> {
        let override_cmd = if cfg!(windows) {
            self.windows_reinstall_cmd.as_ref()
        } else {
            self.unix_reinstall_cmd.as_ref()
        };
        override_cmd.or(self.reinstall_cmd.as_ref()).cloned()
    }
}

/// `env_files:` block — how environment/config files are discovered and
/// written for this repo type (inventory-config-ci.md §1.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EnvFilesDef {
    /// Preferred dir for env/config files (`"."` = repo root). When set and
    /// existing, ONLY that dir is scanned (non-recursive); the tree walk is
    /// the fallback.
    pub default_dir: String,
    /// `"spring"` | `"angular"` | `"raw"` — how the GUI writes the active
    /// environment content. Default `"raw"`.
    pub config_writer_type: String,
    /// Globs of env files ignored in git-dirty checks before pull.
    pub pull_ignore_patterns: Vec<String>,
    /// File the ACTIVE environment content is written into.
    pub main_config_filename: String,
    /// fnmatch globs identifying env files; empty disables env handling.
    pub patterns: Vec<String>,
    /// Dirs pruned during the recursive env scan. `None` (key absent) means
    /// the v1 default `{".git", "node_modules"}`; an explicit empty list
    /// means "prune nothing" (v1 distinction — project_analyzer.py:257).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_dirs: Option<Vec<String>>,
    /// v2 flag: add the `default` profile when a base
    /// `application.yml|yaml|properties` env file is present. Replaces the
    /// v1 hardcoded spring-boot special case.
    pub implicit_default_profile: bool,
}

impl Default for EnvFilesDef {
    fn default() -> Self {
        EnvFilesDef {
            default_dir: String::new(),
            config_writer_type: "raw".to_string(),
            pull_ignore_patterns: Vec::new(),
            main_config_filename: String::new(),
            patterns: Vec::new(),
            exclude_dirs: None,
            implicit_default_profile: false,
        }
    }
}

impl EnvFilesDef {
    /// The dir names pruned during the recursive env walk, applying the v1
    /// "default only when the key is absent" rule.
    pub fn effective_exclude_dirs(&self) -> Vec<String> {
        match &self.exclude_dirs {
            Some(dirs) => dirs.clone(),
            None => vec![".git".to_string(), "node_modules".to_string()],
        }
    }
}

/// `ui:` block — passed through to the frontend essentially verbatim
/// (v1 stored the raw dict on `RepoInfo.ui_config`). Unknown keys are
/// preserved through `extra` so user YAMLs round-trip losslessly.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiConfig {
    /// Emoji shown on the card header.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Hex accent color for the type label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `selectors[0].label` = caption of the env/profile combo (default "App").
    pub selectors: Vec<UiSelector>,
    pub install: UiInstall,
    /// Forward-compat passthrough of any extra `ui` keys.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One entry of `ui.selectors`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiSelector {
    pub label: String,
}

/// `ui.install` — install-state heuristics.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiInstall {
    /// Dirs whose existence == "dependencies installed" (all must exist;
    /// with no check_dirs the repo always counts as installed —
    /// §22.17 backend).
    pub check_dirs: Vec<String>,
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
    fn formerly_dead_keys_round_trip() {
        let defs = all_defs();
        let react = &defs.iter().find(|(n, _)| *n == "react").expect("react").1;
        assert_eq!(
            react.heuristics.must_match_package_json,
            vec!["react".to_string(), "react-dom".to_string()]
        );
        let docker = &defs
            .iter()
            .find(|(n, _)| *n == "docker-infra")
            .expect("docker-infra")
            .1;
        assert_eq!(docker.commands.stop_cmd.as_deref(), Some("docker-compose down"));
        assert!(docker.detection.allow_no_git);
    }

    #[test]
    fn v2_schema_flags_present_on_spring_boot() {
        let defs = all_defs();
        let spring = &defs
            .iter()
            .find(|(n, _)| *n == "spring-boot")
            .expect("spring-boot")
            .1;
        assert_eq!(
            spring.heuristics.pattern_search_dirs,
            vec!["src/main/resources".to_string()]
        );
        assert!(spring.env_files.implicit_default_profile);
        assert_eq!(spring.env_files.config_writer_type, "spring");
    }

    #[test]
    fn exclude_dirs_absent_vs_empty_distinction() {
        // maven-lib ships an explicit empty list → prune nothing.
        let defs = all_defs();
        let maven = &defs.iter().find(|(n, _)| *n == "maven-lib").expect("maven").1;
        assert_eq!(maven.env_files.exclude_dirs, Some(vec![]));
        assert!(maven.env_files.effective_exclude_dirs().is_empty());

        // Absent key → v1 default {".git", "node_modules"}.
        let bare: EnvFilesDef = serde_yaml_ng::from_str("default_dir: '.'").unwrap();
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
    fn reinstall_cmd_os_resolution() {
        let defs = all_defs();
        let angular = &defs.iter().find(|(n, _)| *n == "angular").expect("ng").1;
        let resolved = angular.commands.resolved_reinstall_cmd().expect("some");
        if cfg!(windows) {
            assert!(resolved.contains("rmdir"));
        } else {
            assert!(resolved.contains("rm -rf"));
        }
    }

    #[test]
    fn writer_type_defaults_to_raw() {
        let def: EnvFilesDef = serde_yaml_ng::from_str("default_dir: '.'").unwrap();
        assert_eq!(def.config_writer_type, "raw");
    }
}
