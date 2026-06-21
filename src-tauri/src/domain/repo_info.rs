//! Detected repository metadata.

use crate::domain::repo_type::Ui;
use serde::{Deserialize, Serialize};

/// All detected metadata for one repository.
///
/// Superset of v1 `domain/models/repo_info.py` (inventory-backend.md §2):
/// the v2 unified detector also populates the fields the v1 main path never
/// filled (`java_version`, `server_port`, `context_path`, `git_remote_url` —
/// the §22.4 "enrichment gap"), plus the v2 additions `modules`,
/// `stop_command` and `danger_flags`.
///
/// Serialized camelCase on the IPC wire to match the TypeScript mirror types
/// in `src/app/core/ipc/`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoInfo {
    /// Directory basename.
    pub name: String,
    /// Absolute repo path.
    pub path: String,
    /// Matching repo-type id (`RepoTypeDef.type_id`).
    pub repo_type: String,
    /// Detected env/profile names (Spring profiles, Angular env names),
    /// sorted alphabetically.
    pub profiles: Vec<String>,
    /// Origin remote URL, SSH form normalized to HTTPS (v1 `get_remote_url`
    /// conversion, inventory-backend.md §10.2). Read from `.git/config`.
    pub git_remote_url: Option<String>,
    /// Current branch — NOT set by detection; the git layer fills it on
    /// demand (kept for v1 field parity).
    pub current_branch: Option<String>,
    /// YAML `commands.install_cmd`.
    pub run_install_cmd: Option<String>,
    /// OS-resolved reinstall command.
    pub run_reinstall_cmd: Option<String>,
    /// Resolved start command (OS-specific override + `{main_app}`
    /// substitution applied).
    pub run_command: Option<String>,
    /// YAML `commands.stop_cmd` — v2: enforced by the process layer
    /// (graceful stop before/instead of tree-kill).
    pub stop_command: Option<String>,
    /// Absolute paths of matched env/config files (flat, v1-compatible;
    /// see `modules` for the grouped view).
    pub environment_files: Vec<String>,
    /// v2: env files grouped per repo-relative directory — the unit behind
    /// the `"repo::module"` config-key convention (inventory-config-ci.md §4.1).
    pub modules: Vec<RepoModule>,
    /// YAML `env_files.default_dir`.
    pub env_default_dir: String,
    /// YAML `env_files.config_writer_type` (`raw`/`spring`/`angular`).
    pub env_config_writer_type: String,
    /// Globs of files ignored for git-dirty checks during pull.
    pub env_pull_ignore_patterns: Vec<String>,
    /// YAML `env_files.main_config_filename`.
    pub env_main_config_filename: String,
    /// YAML `env_files.patterns` (fnmatch globs).
    pub env_patterns: Vec<String>,
    /// Whole YAML `ui` block (icon, color, selectors, install_check_dirs, actions).
    pub ui_config: Ui,
    /// YAML `enrich` list (`java_version`, `docker_checkboxes`) — kept on the
    /// `features` wire name for the frontend.
    pub features: Vec<String>,
    /// Card restart delay in ms; `None` ⇒ default 300 (was hardcoded per-type).
    pub restart_delay_ms: Option<u64>,
    /// Whether this repo exposes editable env/config (docker-infra: false).
    pub config_editable: bool,
    /// Recommended Java version extracted from `pom.xml`
    /// (`<java.version>` / `<maven.compiler.source>`) when the
    /// `java_version` feature is declared.
    pub java_version: Option<String>,
    /// Static Spring `server.port` from the main application config;
    /// updated live from log lines at runtime by the process layer.
    pub server_port: Option<u16>,
    /// Spring `server.servlet.context-path` from the main application config.
    pub context_path: Option<String>,
    /// Regex: log line meaning "service ready".
    pub ready_pattern: Option<String>,
    /// Regex: log line meaning "startup failed".
    pub error_pattern: Option<String>,
    /// Regexes with one capture group = port number.
    pub port_patterns: Vec<String>,
    /// Absolute paths of `docker-compose*.yml/.yaml` at the repo root
    /// (sorted), populated when the `docker_checkboxes` feature is declared.
    pub docker_compose_files: Vec<String>,
    /// Optional metadata, unused in practice (v1 parity).
    pub detected_framework: String,
    /// Env names flagged "dangerous" for this repo (UI shows a warning).
    /// Empty at detection time — the config layer fills it from
    /// `repo_config_danger` when assembling the frontend payload.
    pub danger_flags: Vec<String>,
}

impl RepoInfo {
    /// True when the repo type declares the given feature.
    pub fn has_feature(&self, feature: &str) -> bool {
        self.features.iter().any(|f| f == feature)
    }
}

/// One "module" of a repository: the env/config files living in one
/// directory. The module key is the repo-relative POSIX dir of the env files
/// (e.g. `src/main/resources`, `apps/cart/src/environments`) or the literal
/// `root` for the repo root — exactly the `"repo::module"` convention of
/// `active_configs` / `repo_configs` (inventory-config-ci.md §4.1).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoModule {
    /// Module key: repo-relative POSIX dir, or `"root"` for the repo root.
    pub key: String,
    /// Repo-relative POSIX dir (`""` for the repo root).
    pub dir: String,
    /// Absolute paths of the env files in this module.
    pub env_files: Vec<String>,
    /// Profiles extracted from this module's filenames, sorted.
    pub profiles: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case() {
        let repo = RepoInfo {
            name: "demo".into(),
            repo_type: "spring-boot".into(),
            server_port: Some(8080),
            ..Default::default()
        };
        let json = serde_json::to_value(&repo).unwrap();
        assert_eq!(json["repoType"], "spring-boot");
        assert_eq!(json["serverPort"], 8080);
        assert!(json.get("repo_type").is_none());
    }

    #[test]
    fn round_trips_through_json() {
        let repo = RepoInfo {
            name: "demo".into(),
            path: "/ws/demo".into(),
            repo_type: "angular".into(),
            profiles: vec!["default".into(), "prod".into()],
            modules: vec![RepoModule {
                key: "src/environments".into(),
                dir: "src/environments".into(),
                env_files: vec!["/ws/demo/src/environments/environment.ts".into()],
                profiles: vec!["default".into()],
            }],
            ..Default::default()
        };
        let json = serde_json::to_string(&repo).unwrap();
        let back: RepoInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(repo, back);
    }

    #[test]
    fn has_feature_works() {
        let repo = RepoInfo {
            features: vec!["java_version".into()],
            ..Default::default()
        };
        assert!(repo.has_feature("java_version"));
        assert!(!repo.has_feature("docker_checkboxes"));
    }
}
