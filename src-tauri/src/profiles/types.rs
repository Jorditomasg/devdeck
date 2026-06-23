//! Profile document model — the v1 `.devops-profiles/<name>.json` schema
//! (inventory-backend.md §15.3, inventory-config-ci.md §4.2), serde-typed
//! with lossless passthrough of unknown keys so v1 files round-trip.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::config::app_config::SENTINEL_SYSTEM_DEFAULT;

/// `config_files` snapshot: repo-relative POSIX dir (`""` for the repo root)
/// → filename → full raw content (v1 `_capture_config_files`).
pub type ConfigFilesMap = BTreeMap<String, BTreeMap<String, String>>;

/// `saved_environments` snapshot: repo-relative POSIX path of the env FILE →
/// env name → full raw content (v1 `_capture_saved_environments`).
pub type SavedEnvironmentsMap = BTreeMap<String, BTreeMap<String, String>>;

/// Renames produced by a saved-environment merge:
/// `config_key → {original_name → stored_as}` (v1 `repetidoN` strategy,
/// inventory-backend.md §8.6, §15.4).
pub type RenamesByKey = BTreeMap<String, BTreeMap<String, String>>;

/// Errors of the profile store / import-export paths.
#[derive(Debug, Error)]
pub enum ProfileError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid profile JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// v1 `import_profile_from_file` rejected files without a `repos` key.
    #[error("not a profile file: missing 'repos' key")]
    MissingReposKey,
    /// `dirs::data_dir()` unavailable (headless/odd platform).
    #[error("no OS data directory available")]
    NoDataDir,
}

/// One whole-workspace profile (v1 `build_profile_data` + the keys
/// `save_profile` injects).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfileDocument {
    /// Injected on save (v1 `config['name'] = name`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// ISO-8601 timestamp injected on save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    /// Per-repo snapshot, keyed by repo name. REQUIRED on import (§15.2).
    pub repos: BTreeMap<String, RepoProfile>,
    /// Lossless passthrough of unknown keys (v1 profiles carried extras like
    /// DB presets at times — never drop them).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Per-repo entry of a profile (§15.3 schema).
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
    /// Selected JDK display label. v1 persisted the Spanish sentinel
    /// `"Sistema (Por Defecto)"` for the system default — readers must keep
    /// accepting it forever (architecture-v2.md §6); use
    /// [`RepoProfile::effective_java_version`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_version: Option<String>,
    /// Card checkbox.
    pub selected: bool,
    /// Active compose files of a docker-capable card
    /// (gui/repo_card/_base.py `get_docker_compose_active` → `list`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_compose_active: Option<Vec<String>>,
    /// Compose services auto-started with the card: file → service list
    /// (gui/repo_card/_base.py `get_docker_profile_services` → `dict`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docker_profile_services: Option<BTreeMap<String, Vec<String>>>,
    /// Raw config-file snapshot — only when "include config files" (§15.3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_files: Option<ConfigFilesMap>,
    /// Saved-environment snapshot — only when "include config files".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_environments: Option<SavedEnvironmentsMap>,
    /// Lossless passthrough of unknown keys.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl RepoProfile {
    /// Java label with the v1 `"Sistema (Por Defecto)"` sentinel folded into
    /// `None` (system default). The raw field keeps the sentinel so v1 files
    /// round-trip byte-compatibly.
    pub fn effective_java_version(&self) -> Option<&str> {
        self.java_version
            .as_deref()
            .filter(|v| *v != SENTINEL_SYSTEM_DEFAULT && !v.is_empty())
    }
}

/// A profile repo missing from the workspace — feeds the clone-missing flow
/// (v1 `get_missing_repos`). `branch` defaults to `main` (v1 §15.4).
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

    /// Shape taken from inventory-config-ci.md §4.2 / a real v1 export.
    const V1_PROFILE: &str = r##"{
      "name": "KLK2",
      "created": "2024-11-08T10:30:00.123456",
      "repos": {
        "spring-petclinic": {
          "git_url": "https://github.com/org/spring-petclinic.git",
          "branch": "develop",
          "type": "spring-boot",
          "profile": "mysql",
          "profile_tracked": ["src/main/resources/application.yml"],
          "custom_command": "",
          "java_version": "Sistema (Por Defecto)",
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
          "custom_command": "",
          "java_version": "Java 17 (jdk-17)",
          "selected": false,
          "docker_compose_active": ["docker-compose.mysql.yml"],
          "docker_profile_services": { "docker-compose.mysql.yml": ["mysqldb"] }
        }
      }
    }"##;

    #[test]
    fn v1_profile_round_trips() {
        let doc: ProfileDocument = serde_json::from_str(V1_PROFILE).unwrap();
        assert_eq!(doc.name.as_deref(), Some("KLK2"));
        assert_eq!(doc.repos.len(), 2);

        let spring = &doc.repos["spring-petclinic"];
        assert_eq!(spring.repo_type, "spring-boot");
        assert_eq!(spring.branch.as_deref(), Some("develop"));
        assert_eq!(spring.java_version.as_deref(), Some("Sistema (Por Defecto)"));
        assert_eq!(spring.effective_java_version(), None, "sentinel → system default");
        assert_eq!(
            spring.config_files.as_ref().unwrap()["src/main/resources"]["application.yml"],
            "server:\n  port: 8080\n"
        );

        let infra = &doc.repos["infra"];
        assert_eq!(infra.branch, None);
        assert_eq!(infra.effective_java_version(), Some("Java 17 (jdk-17)"));
        assert_eq!(
            infra.docker_compose_active.as_deref(),
            Some(&["docker-compose.mysql.yml".to_string()][..])
        );
        assert_eq!(
            infra.docker_profile_services.as_ref().unwrap()["docker-compose.mysql.yml"],
            vec!["mysqldb"]
        );

        // Round-trip: serialize and parse back, sentinel preserved verbatim.
        let json = serde_json::to_value(&doc).unwrap();
        assert_eq!(json["repos"]["spring-petclinic"]["java_version"], "Sistema (Por Defecto)");
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
