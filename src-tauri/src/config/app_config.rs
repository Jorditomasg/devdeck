//! Typed serde model of the application config (`config.json`).
//!
//! Unknown keys are preserved through the flattened `extra` map so files
//! written by future versions round-trip losslessly.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Module key used in `"repo::module"` config keys when the env files live
/// in the repo root.
pub const ROOT_MODULE_KEY: &str = "root";

/// The default workspace group, used as the `last_profile_by_group` key when
/// no group is active.
pub const DEFAULT_GROUP_NAME: &str = "Default";

/// Saved environments: `repo → module-dir → env-name → full file content`.
pub type RepoConfigsMap = BTreeMap<String, BTreeMap<String, BTreeMap<String, String>>>;

/// The whole application configuration document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    /// UI language code (`en_EN`, `es_ES`). Applied on next start.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Minimize hides to system tray (v1 default: true — see
    /// [`AppConfig::minimize_to_tray_or_default`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimize_to_tray: Option<bool>,
    /// User-managed JDK registry: display label → JAVA_HOME path.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub java_versions: BTreeMap<String, String>,
    /// Last loaded profile per workspace group; `""` = none.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub last_profile_by_group: BTreeMap<String, String>,
    /// Named groups of workspace roots.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub workspace_groups: Vec<WorkspaceGroup>,
    /// Name of the active workspace group; may reference a group that no
    /// longer exists (e.g. deleted while active) — readers fall back to the
    /// first group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_group: Option<String>,
    /// Per-repo UI state keyed by repo name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub repo_state: BTreeMap<String, RepoState>,
    /// Currently-selected saved environment per config key
    /// (`"repo::module"`); absent key = none selected.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub active_configs: BTreeMap<String, String>,
    /// Saved alternative config-file contents ("environments"):
    /// `repo_configs[repo][module][name] = full raw file text`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub repo_configs: RepoConfigsMap,
    /// Env names flagged "dangerous" per config key (stored sorted; key
    /// removed when the set is empty).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub repo_config_danger: BTreeMap<String, Vec<String>>,
    /// Named start-command profiles per repo: `command_profiles[repo][name] = full command line`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub command_profiles: BTreeMap<String, BTreeMap<String, String>>,

    /// Recently used workspace roots (most recent first).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recent_workspaces: Vec<String>,
    /// Persisted window state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowState>,
    /// Shell command/path for new interactive terminals. `None` / empty
    /// → the per-platform default (`terminal::shell::default_shell`). Set from
    /// Settings; one of the detected shells or a custom path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_shell: Option<String>,
    /// Last app version the user saw the "What's new" popup for. `None`
    /// on a fresh install (suppresses the popup until the FIRST update).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whats_new_seen_version: Option<String>,
    /// User opted out of the "What's new" popup permanently.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whats_new_disabled: Option<bool>,

    /// Lossless passthrough of unknown keys (forward/backward compat).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One named workspace group.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceGroup {
    pub name: String,
    pub paths: Vec<String>,
}

/// Per-repo persisted UI state (`repo_state` values).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RepoState {
    /// Card checkbox.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    /// Active command-profile name; `None` = repo-type default command.
    /// (Profile lines live in `AppConfig::command_profiles`.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_profile: Option<String>,
    /// Selected JDK display label; `None` = system default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_version: Option<String>,
    /// Card expanded state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
    /// Manual list position. Fractional so a drag reorder persists ONE
    /// repo; `None` = unordered → sorts by the alphabetical baseline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<f64>,
    /// Lossless passthrough of unknown keys.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Persisted window state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    pub maximized: bool,
    pub fullscreen: bool,
}

impl AppConfig {
    /// `minimize_to_tray` with its default (`true`).
    pub fn minimize_to_tray_or_default(&self) -> bool {
        self.minimize_to_tray.unwrap_or(true)
    }

    /// Active saved-environment name for a config key (`None` when unset).
    pub fn active_config(&self, config_key: &str) -> Option<&str> {
        self.active_configs.get(config_key).map(String::as_str)
    }

    /// Saved environments for one config key (`{name: content}`).
    pub fn repo_configs_for(&self, config_key: &str) -> BTreeMap<String, String> {
        let (repo, module) = split_config_key(config_key);
        self.repo_configs
            .get(repo)
            .and_then(|modules| modules.get(module))
            .cloned()
            .unwrap_or_default()
    }

    /// Replace the saved environments of one config key wholesale. An empty
    /// map removes the module entry (and the repo entry when it becomes
    /// empty).
    pub fn set_repo_configs_for(
        &mut self,
        config_key: &str,
        configs: BTreeMap<String, String>,
    ) {
        let (repo, module) = split_config_key(config_key);
        if configs.is_empty() {
            if let Some(modules) = self.repo_configs.get_mut(repo) {
                modules.remove(module);
                if modules.is_empty() {
                    self.repo_configs.remove(repo);
                }
            }
            return;
        }
        self.repo_configs
            .entry(repo.to_string())
            .or_default()
            .insert(module.to_string(), configs);
    }

    /// Command profiles for one repo (`{name: command_line}`).
    pub fn command_profiles_for(&self, repo: &str) -> BTreeMap<String, String> {
        self.command_profiles.get(repo).cloned().unwrap_or_default()
    }

    /// Replace a repo's command profiles wholesale; an empty map removes the entry.
    pub fn set_command_profiles_for(&mut self, repo: &str, profiles: BTreeMap<String, String>) {
        if profiles.is_empty() {
            self.command_profiles.remove(repo);
        } else {
            self.command_profiles.insert(repo.to_string(), profiles);
        }
    }

    /// Smart merge used by profile import: incoming name absent → add;
    /// present with identical content → skip; present with different content
    /// → store under the first free `repetidoN` name. Returns
    /// `{original: stored_as}` for the renamed entries.
    pub fn merge_repo_configs(
        &mut self,
        config_key: &str,
        incoming: &BTreeMap<String, String>,
    ) -> BTreeMap<String, String> {
        let (repo, module) = split_config_key(config_key);
        let target = self
            .repo_configs
            .entry(repo.to_string())
            .or_default()
            .entry(module.to_string())
            .or_default();
        let mut renames = BTreeMap::new();
        for (name, content) in incoming {
            match target.get(name) {
                None => {
                    target.insert(name.clone(), content.clone());
                }
                Some(existing) if existing == content => {} // identical → skip
                Some(_) => {
                    let new_name = next_repetido_name(target);
                    target.insert(new_name.clone(), content.clone());
                    renames.insert(name.clone(), new_name);
                }
            }
        }
        renames
    }

    /// Danger-flagged environment names for a config key.
    pub fn danger_configs(&self, config_key: &str) -> Vec<String> {
        self.repo_config_danger
            .get(config_key)
            .cloned()
            .unwrap_or_default()
    }

    /// Store the danger set for a config key (sorted; key removed when
    /// empty).
    pub fn set_danger_configs(&mut self, config_key: &str, mut names: Vec<String>) {
        if names.is_empty() {
            self.repo_config_danger.remove(config_key);
        } else {
            names.sort();
            names.dedup();
            self.repo_config_danger
                .insert(config_key.to_string(), names);
        }
    }
}

/// Build the `"repo::module"` config key. An empty or `"."` module dir maps
/// to the literal `root`.
pub fn config_key(repo: &str, module_dir: &str) -> String {
    let module = if module_dir.is_empty() || module_dir == "." {
        ROOT_MODULE_KEY
    } else {
        module_dir
    };
    format!("{repo}::{module}")
}

/// Split a config key into `(repo, module)`. A key without `::` maps to
/// module `root` (defensive: keys arrive as free-form strings over IPC).
pub fn split_config_key(key: &str) -> (&str, &str) {
    match key.split_once("::") {
        Some((repo, module)) => (repo, module),
        None => (key, ROOT_MODULE_KEY),
    }
}

/// First free `repetidoN` name (N starting at 1) — the conflict-rename
/// strategy for imported saved environments.
fn next_repetido_name(existing: &BTreeMap<String, String>) -> String {
    let mut n: u32 = 1;
    loop {
        let candidate = format!("repetido{n}");
        if !existing.contains_key(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r##"{
      "repo_state": {
        "spring-petclinic": { "selected": true, "java_version": "Java 17 (jdk-17)" }
      },
      "active_configs": { "spring-petclinic::src/main/resources": "mysql" },
      "language": "es_ES",
      "java_versions": { "Java 17 (jdk-17)": "C:\\Program Files\\Java\\jdk-17" },
      "minimize_to_tray": true,
      "workspace_groups": [ { "name": "Default", "paths": ["C:\\Users\\Jordi\\PROYECTOS\\BOA2"] } ],
      "active_group": "Default",
      "last_profile_by_group": { "Default": "KLK2" },
      "repo_configs": {
        "spring-petclinic": {
          "src/main/resources": {
            "mysql": "# mysql content",
            "default": "# default content"
          }
        }
      },
      "repo_config_danger": { "spring-petclinic::src/main/resources": ["postgres"] }
    }"##;

    #[test]
    fn parses_the_full_schema() {
        let cfg: AppConfig = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(cfg.language.as_deref(), Some("es_ES"));
        assert_eq!(cfg.workspace_groups.len(), 1);
        assert_eq!(
            cfg.active_config("spring-petclinic::src/main/resources"),
            Some("mysql")
        );
        assert_eq!(
            cfg.repo_configs["spring-petclinic"]["src/main/resources"]["mysql"],
            "# mysql content"
        );
        assert_eq!(
            cfg.repo_config_danger["spring-petclinic::src/main/resources"],
            vec!["postgres"]
        );
    }

    #[test]
    fn round_trips_preserving_unknown_keys() {
        let raw = r#"{ "language": "en_EN", "some_future_key": {"a": 1} }"#;
        let cfg: AppConfig = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&cfg).unwrap();
        assert_eq!(out["some_future_key"]["a"], 1);
        let back: AppConfig = serde_json::from_value(out).unwrap();
        assert_eq!(cfg, back);
    }

    #[test]
    fn config_key_conventions() {
        assert_eq!(config_key("repo", "src/main/resources"), "repo::src/main/resources");
        assert_eq!(config_key("repo", ""), "repo::root");
        assert_eq!(config_key("repo", "."), "repo::root");
        assert_eq!(split_config_key("a::b/c"), ("a", "b/c"));
        assert_eq!(split_config_key("no-separator"), ("no-separator", "root"));
    }

    #[test]
    fn merge_repo_configs_repetido_strategy() {
        let mut cfg = AppConfig::default();
        let key = "repo::root";
        cfg.set_repo_configs_for(
            key,
            BTreeMap::from([("dev".to_string(), "A".to_string())]),
        );
        let incoming = BTreeMap::from([
            ("dev".to_string(), "B".to_string()),   // conflict → repetido1
            ("prod".to_string(), "P".to_string()),  // new → added
            ("same".to_string(), "S".to_string()),  // new → added
        ]);
        let renames = cfg.merge_repo_configs(key, &incoming);
        assert_eq!(renames, BTreeMap::from([("dev".to_string(), "repetido1".to_string())]));
        let stored = cfg.repo_configs_for(key);
        assert_eq!(stored["dev"], "A"); // original untouched
        assert_eq!(stored["repetido1"], "B");
        assert_eq!(stored["prod"], "P");

        // Identical content → skipped, no rename.
        let renames2 =
            cfg.merge_repo_configs(key, &BTreeMap::from([("same".to_string(), "S".to_string())]));
        assert!(renames2.is_empty());

        // Second conflict on the same name → repetido2.
        let renames3 =
            cfg.merge_repo_configs(key, &BTreeMap::from([("dev".to_string(), "C".to_string())]));
        assert_eq!(renames3["dev"], "repetido2");
    }

    #[test]
    fn danger_configs_sorted_and_removed_when_empty() {
        let mut cfg = AppConfig::default();
        cfg.set_danger_configs("r::root", vec!["z".into(), "a".into(), "a".into()]);
        assert_eq!(cfg.danger_configs("r::root"), vec!["a", "z"]);
        cfg.set_danger_configs("r::root", vec![]);
        assert!(cfg.repo_config_danger.is_empty());
    }

    #[test]
    fn minimize_to_tray_defaults_true() {
        assert!(AppConfig::default().minimize_to_tray_or_default());
    }

    #[test]
    fn command_profiles_roundtrip_per_repo() {
        let mut c = AppConfig::default();
        assert!(c.command_profiles_for("repoA").is_empty());
        let mut m = BTreeMap::new();
        m.insert("import".to_string(), "mvn spring-boot:run -Dargs=--job=import".to_string());
        c.set_command_profiles_for("repoA", m.clone());
        assert_eq!(c.command_profiles_for("repoA"), m);
    }

    #[test]
    fn empty_map_removes_repo_command_profiles_entry() {
        let mut c = AppConfig::default();
        let mut m = BTreeMap::new();
        m.insert("x".to_string(), "cmd".to_string());
        c.set_command_profiles_for("repoA", m);
        c.set_command_profiles_for("repoA", BTreeMap::new());
        assert!(!c.command_profiles.contains_key("repoA"));
    }
}
