//! Typed serde model of the application config (`config.json`).
//!
//! Field-for-field port of the v1 config schema
//! (inventory-backend.md §8.3, inventory-config-ci.md §4.1) plus the v2
//! additions (window state, recent workspaces). Unknown keys are preserved
//! through the flattened `extra` map so v1 files and future versions
//! round-trip losslessly.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// v1 Spanish sentinel meaning "no saved environment selected" — a persisted
/// MAGIC VALUE inside user config files (§22.8 backend). v2 normalizes it to
/// an absent key, but readers MUST keep accepting it forever
/// (architecture-v2.md §6).
pub const SENTINEL_NOT_SELECTED: &str = "- Sin Seleccionar -";

/// v1 Spanish sentinel meaning "system-default Java". v2 normalizes it to
/// `None`; readers keep accepting it forever.
pub const SENTINEL_SYSTEM_DEFAULT: &str = "Sistema (Por Defecto)";

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
    /// Legacy single workspace root (pre-groups); kept in sync for
    /// backward compatibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_dir: Option<String>,
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
    /// LEGACY last loaded profile name; folded into
    /// `last_profile_by_group["Default"]` by the migrator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_profile: Option<String>,
    /// Last loaded profile per workspace group; `""` = none.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub last_profile_by_group: BTreeMap<String, String>,
    /// Named groups of workspace roots. When empty, a virtual `Default`
    /// group is synthesized from `workspace_dir`
    /// (see [`AppConfig::workspace_groups_or_default`]).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub workspace_groups: Vec<WorkspaceGroup>,
    /// Name of the active workspace group; may reference a group that no
    /// longer exists (v1 tolerated this — readers must fall back to the
    /// first group, §8.3 backend).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_group: Option<String>,
    /// Per-repo UI state keyed by repo name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub repo_state: BTreeMap<String, RepoState>,
    /// Currently-selected saved environment per config key
    /// (`"repo::module"`). v1 stored the [`SENTINEL_NOT_SELECTED`] magic
    /// value for "none"; v2 drops the key instead (normalized on load).
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

    // ---- v2 additions -------------------------------------------------
    /// v2: recently used workspace roots (most recent first). v1 had no
    /// equivalent.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub recent_workspaces: Vec<String>,
    /// v2: persisted window state. v1 never persisted geometry
    /// (fixed 1300x900 — §8.3 backend note); v2 decides to persist it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowState>,
    /// v2: shell command/path for new interactive terminals. `None` / empty
    /// → the per-platform default (`terminal::shell::default_shell`). Set from
    /// Settings; one of the detected shells or a custom path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_shell: Option<String>,
    /// v2: last app version the user saw the "What's new" popup for. `None`
    /// on a fresh install (suppresses the popup until the FIRST update).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whats_new_seen_version: Option<String>,
    /// v2: user opted out of the "What's new" popup permanently.
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
    /// Selected JDK display label; `None` = system default. v1 persisted the
    /// [`SENTINEL_SYSTEM_DEFAULT`] string instead (normalized on load).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub java_version: Option<String>,
    /// Card expanded state (older v1 entries lack it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
    /// Lossless passthrough of unknown keys.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// v2 persisted window state.
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
    /// `minimize_to_tray` with the v1 default (`true`).
    pub fn minimize_to_tray_or_default(&self) -> bool {
        self.minimize_to_tray.unwrap_or(true)
    }

    /// Stored groups, or the synthesized virtual `Default` group built from
    /// `workspace_dir` (NOT persisted — v1 `get_workspace_groups`,
    /// §8.7 backend). Empty when neither exists.
    pub fn workspace_groups_or_default(&self) -> Vec<WorkspaceGroup> {
        if !self.workspace_groups.is_empty() {
            return self.workspace_groups.clone();
        }
        match &self.workspace_dir {
            Some(dir) if !dir.is_empty() => vec![WorkspaceGroup {
                name: "Default".to_string(),
                paths: vec![dir.clone()],
            }],
            _ => Vec::new(),
        }
    }

    /// The effective active group: `active_group` when it names an existing
    /// group, otherwise the first group (v1 tolerance for dangling
    /// `active_group` — §8.3 backend).
    pub fn effective_active_group(&self) -> Option<WorkspaceGroup> {
        let groups = self.workspace_groups_or_default();
        if let Some(name) = &self.active_group {
            if let Some(group) = groups.iter().find(|g| &g.name == name) {
                return Some(group.clone());
            }
        }
        groups.into_iter().next()
    }

    /// Normalize the v1 Spanish sentinels into typed absence
    /// (architecture-v2.md §6). Idempotent; called on every load and during
    /// migration. The raw sentinels remain accepted as input forever.
    pub fn normalize_sentinels(&mut self) {
        self.active_configs
            .retain(|_, v| v != SENTINEL_NOT_SELECTED);
        for state in self.repo_state.values_mut() {
            if state.java_version.as_deref() == Some(SENTINEL_SYSTEM_DEFAULT) {
                state.java_version = None;
            }
        }
    }

    /// Active saved-environment name for a config key (`None` when unset or
    /// when the v1 sentinel is stored).
    pub fn active_config(&self, config_key: &str) -> Option<&str> {
        self.active_configs
            .get(config_key)
            .map(String::as_str)
            .filter(|v| *v != SENTINEL_NOT_SELECTED)
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

    /// Replace the saved environments of one config key wholesale
    /// (v1 `save_repo_configs`, §8.6 backend). An empty map removes the
    /// module entry (and the repo entry when it becomes empty).
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

    /// Smart merge used by profile import (v1 `merge_repo_configs`,
    /// §8.6 backend): incoming name absent → add; present with identical
    /// content → skip; present with different content → store under the
    /// first free `repetidoN` name. Returns `{original: stored_as}` for the
    /// renamed entries.
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
    /// empty — v1 `save_danger_configs`, §8.8 backend).
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
/// to the literal `root` (inventory-config-ci.md §4.1).
pub fn config_key(repo: &str, module_dir: &str) -> String {
    let module = if module_dir.is_empty() || module_dir == "." {
        ROOT_MODULE_KEY
    } else {
        module_dir
    };
    format!("{repo}::{module}")
}

/// Split a config key into `(repo, module)`. A legacy key without `::` (v1
/// "flat" form) maps to module `root`.
pub fn split_config_key(key: &str) -> (&str, &str) {
    match key.split_once("::") {
        Some((repo, module)) => (repo, module),
        None => (key, ROOT_MODULE_KEY),
    }
}

/// First free `repetidoN` name (N starting at 1) — the v1 conflict-rename
/// strategy for imported saved environments (`_next_repetido_name`,
/// §8.6 backend).
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

    /// Sanitized real-file excerpt from inventory-config-ci.md §4.1.
    const V1_SAMPLE: &str = r##"{
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
            "mysql": "# mysql content",
            "default": "# default content"
          }
        }
      },
      "repo_config_danger": { "spring-petclinic::src/main/resources": ["postgres"] }
    }"##;

    #[test]
    fn parses_the_full_v1_schema() {
        let cfg: AppConfig = serde_json::from_str(V1_SAMPLE).unwrap();
        assert_eq!(cfg.language.as_deref(), Some("es_ES"));
        assert_eq!(cfg.last_profile.as_deref(), Some("ghf"));
        assert_eq!(cfg.workspace_groups.len(), 1);
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
    fn normalize_drops_spanish_sentinels_idempotently() {
        let mut cfg: AppConfig = serde_json::from_str(V1_SAMPLE).unwrap();
        cfg.normalize_sentinels();
        assert!(cfg.active_configs.is_empty());
        assert_eq!(
            cfg.repo_state["spring-petclinic"].java_version, None,
            "java sentinel must become None"
        );
        // Idempotent.
        let snapshot = cfg.clone();
        cfg.normalize_sentinels();
        assert_eq!(cfg, snapshot);
    }

    #[test]
    fn active_config_reader_tolerates_sentinel_forever() {
        let cfg: AppConfig = serde_json::from_str(V1_SAMPLE).unwrap();
        // Sentinel present in storage but reader reports "none selected".
        assert_eq!(cfg.active_config("spring-petclinic::src/main/resources"), None);
    }

    #[test]
    fn dangling_active_group_falls_back_to_first() {
        let cfg: AppConfig = serde_json::from_str(V1_SAMPLE).unwrap();
        // active_group = "Nuevo Grupo" does not exist in workspace_groups.
        let group = cfg.effective_active_group().expect("a group");
        assert_eq!(group.name, "Default");
    }

    #[test]
    fn groups_synthesized_from_workspace_dir() {
        let cfg = AppConfig {
            workspace_dir: Some("/ws".into()),
            ..Default::default()
        };
        let groups = cfg.workspace_groups_or_default();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Default");
        assert_eq!(groups[0].paths, vec!["/ws"]);
        // And it is virtual: serializing must not persist it.
        let json = serde_json::to_value(&cfg).unwrap();
        assert!(json.get("workspace_groups").is_none());
    }

    #[test]
    fn config_key_conventions() {
        assert_eq!(config_key("repo", "src/main/resources"), "repo::src/main/resources");
        assert_eq!(config_key("repo", ""), "repo::root");
        assert_eq!(config_key("repo", "."), "repo::root");
        assert_eq!(split_config_key("a::b/c"), ("a", "b/c"));
        assert_eq!(split_config_key("legacy-flat"), ("legacy-flat", "root"));
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
