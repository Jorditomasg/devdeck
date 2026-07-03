//! Profile document model — the `.devops-profiles/<name>.json` schema,
//! serde-typed with lossless passthrough of unknown keys.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// `config_files` snapshot: repo-relative POSIX dir (`""` for the repo root)
/// → filename → full raw content.
pub type ConfigFilesMap = BTreeMap<String, BTreeMap<String, String>>;

/// `saved_environments` snapshot: repo-relative POSIX path of the env FILE →
/// env name → full raw content.
pub type SavedEnvironmentsMap = BTreeMap<String, BTreeMap<String, String>>;

/// Renames produced by a saved-environment merge:
/// `config_key → {original_name → stored_as}` (`repetidoN` strategy).
pub type RenamesByKey = BTreeMap<String, BTreeMap<String, String>>;

/// Errors of the profile store / import-export paths.
#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid profile JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// Import rejects files without a `repos` key.
    #[error("not a profile file: missing 'repos' key")]
    MissingReposKey,
    /// `dirs::data_dir()` unavailable (headless/odd platform).
    #[error("no OS data directory available")]
    NoDataDir,
}

/// One whole-workspace profile (plus the keys `save_profile` injects).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfileDocument {
    /// Injected on save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// ISO-8601 timestamp injected on save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    /// Per-repo snapshot, keyed by repo name. REQUIRED on import.
    pub repos: BTreeMap<String, RepoProfile>,
    /// Lossless passthrough of unknown keys — never drop them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Per-repo entry of a profile.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RepoProfile {
    /// Origin remote URL (`""` if none) — used to clone missing repos.
    pub git_url: String,
    /// `None` = branch not tracked by this profile.
    pub branch: Option<String>,
    /// Repo-type id (`spring-boot`, `angular`, …). Serialized as `type`.
    #[serde(rename = "type")]
    pub repo_type: String,
    /// Selected env/config profile; `None` = not tracked.
    pub profile: Option<String>,
    /// Card's tracked file list.
    pub profile_tracked: Vec<String>,
    /// Active command-profile name; `None` = repo default.
    pub command_profile: Option<String>,
    /// Selected JDK display label; `None` = system default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_version: Option<String>,
    /// Card checkbox.
    pub selected: bool,
    /// Active compose files of a docker-capable card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_compose_active: Option<Vec<String>>,
    /// Compose services auto-started with the card: file → service list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_profile_services: Option<BTreeMap<String, Vec<String>>>,
    /// Raw config-file snapshot — only when "include config files".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_files: Option<ConfigFilesMap>,
    /// Saved-environment snapshot — only when "include config files".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_environments: Option<SavedEnvironmentsMap>,
    /// Lossless passthrough of unknown keys.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A profile repo missing from the workspace — feeds the clone-missing flow.
/// `branch` defaults to `main`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingRepo {
    pub name: String,
    pub git_url: String,
    pub branch: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROFILE: &str = r##"{
      "name": "KLK2",
      "created": "2024-11-08T10:30:00.123456",
      "repos": {
        "spring-petclinic": {
          "git_url": "https://github.com/org/spring-petclinic.git",
          "branch": "develop",
          "type": "spring-boot",
          "profile": "mysql",
          "profile_tracked": ["src/main/resources/application.yml"],
          "java_version": "Java 17 (jdk-17)",
          "selected": true,
          "config_files": {
            "src/main/resources": { "application.yml": "server:\n  port: 8080\n" }
          },
          "saved_environments": {
            "src/main/resources/application.yml": { "mysql": "# mysql" }
          }
        },
        "infra": {
          "git_url": "",
          "branch": null,
          "type": "docker-infra",
          "profile": null,
          "profile_tracked": [],
          "selected": false,
          "docker_compose_active": ["docker-compose.mysql.yml"],
          "docker_profile_services": { "docker-compose.mysql.yml": ["mysqldb"] }
        }
      }
    }"##;

    #[test]
    fn profile_round_trips() {
        let doc: ProfileDocument = serde_json::from_str(PROFILE).unwrap();
        assert_eq!(doc.name.as_deref(), Some("KLK2"));
        assert_eq!(doc.repos.len(), 2);

        let spring = &doc.repos["spring-petclinic"];
        assert_eq!(spring.repo_type, "spring-boot");
        assert_eq!(spring.branch.as_deref(), Some("develop"));
        assert_eq!(spring.java_version.as_deref(), Some("Java 17 (jdk-17)"));
        assert_eq!(
            spring.config_files.as_ref().unwrap()["src/main/resources"]["application.yml"],
            "server:\n  port: 8080\n"
        );

        let infra = &doc.repos["infra"];
        assert_eq!(infra.branch, None);
        assert_eq!(infra.java_version, None);
        assert_eq!(
            infra.docker_compose_active.as_deref(),
            Some(&["docker-compose.mysql.yml".to_string()][..])
        );
        assert_eq!(
            infra.docker_profile_services.as_ref().unwrap()["docker-compose.mysql.yml"],
            vec!["mysqldb"]
        );

        // Round-trip: serialize and parse back.
        let json = serde_json::to_value(&doc).unwrap();
        assert_eq!(json["repos"]["spring-petclinic"]["type"], "spring-boot");
        let back: ProfileDocument = serde_json::from_value(json).unwrap();
        assert_eq!(doc, back);
    }

    #[test]
    fn unknown_keys_pass_through() {
        let raw = r#"{ "repos": {}, "db_presets": {"local": "x"} }"#;
        let doc: ProfileDocument = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&doc).unwrap();
        assert_eq!(out["db_presets"]["local"], "x");
    }
}
