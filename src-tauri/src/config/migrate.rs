//! One-shot v1 → v2 data migration (architecture-v2.md §6).
//!
//! Runs on first launch only (the OS config dir has no `config.json` yet):
//! 1. Locate the v1 install (the directory holding
//!    `devops_manager_config.json` — probe candidates are supplied by the
//!    commands layer: CLI arg, the workspace-parent convention of v1
//!    `main.py` §1, a user-picked folder).
//! 2. Translate `devops_manager_config.json` → `config.json` with the key
//!    normalizations: Spanish sentinels → typed absence (readers keep
//!    accepting the raw sentinels forever), legacy `last_profile` folded into
//!    `last_profile_by_group["Default"]`, `workspace_dir` materialized into a
//!    `Default` workspace group when no groups exist.
//! 3. Copy `.devops-profiles/` → `dirs::data_dir()/devops-manager/profiles/`
//!    preserving the per-group subdirectory layout (§15.1 backend).
//! 4. Stamp `migratedFrom` / `migratedAt` markers for support.
//!
//! The migration is READ-ONLY on the v1 side — v1 stays fully usable during
//! the transition.

use crate::config::app_config::AppConfig;
use crate::config::store::{ConfigStore, APP_CONFIG_DIR_NAME};
use crate::domain::{DomainError, DomainResult};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// v1 config file name, located in the v1 INSTALL directory
/// (inventory-backend.md §8.2).
pub const V1_CONFIG_FILE_NAME: &str = "devops_manager_config.json";

/// v1 profiles directory name, sibling of the v1 config file
/// (inventory-backend.md §15.1).
pub const V1_PROFILES_DIR_NAME: &str = ".devops-profiles";

/// v2 profiles directory name under `dirs::data_dir()/devops-manager/`.
pub const PROFILES_DIR_NAME: &str = "profiles";

/// The workspace group legacy single-group data is folded into.
pub const DEFAULT_GROUP_NAME: &str = "Default";

/// Outcome of a completed migration.
///
/// Serializes camelCase — this is the wire shape of the `migrate_from_v1`
/// command result (ipc-contract.md §2.5 #36; TS mirror `MigrationReport` in
/// `tauri.types.ts`). Derive added by the commands-integration task as the
/// contract requires.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    /// v1 install directory the data came from.
    pub source: String,
    /// Whether a v1 config file was found and imported (a v1 install may
    /// have profiles but no config, or vice versa).
    pub config_imported: bool,
    /// Number of profile `.json` files copied.
    pub profiles_copied: usize,
    /// ISO-8601 UTC timestamp stamped into the new config.
    pub migrated_at: String,
}

/// v2 profiles directory: `dirs::data_dir()/devops-manager/profiles`.
pub fn default_profiles_dir() -> DomainResult<PathBuf> {
    let base = dirs::data_dir().ok_or(DomainError::NoOsDirectory("data"))?;
    Ok(base.join(APP_CONFIG_DIR_NAME).join(PROFILES_DIR_NAME))
}

/// First candidate directory that contains a v1 config file.
pub fn find_v1_install(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|dir| dir.join(V1_CONFIG_FILE_NAME).is_file())
        .cloned()
}

/// Run the one-shot migration.
///
/// Idempotent: returns `Ok(None)` (no-op) when the v2 config file already
/// exists, or when the v1 root has neither a config file nor a profiles dir.
/// An unparsable v1 config is a [`DomainError::Migration`] — surfaced so the
/// commands layer can warn instead of silently starting fresh.
pub fn migrate_from_v1(
    store: &ConfigStore,
    v1_root: &Path,
    profiles_dest: &Path,
) -> DomainResult<Option<MigrationReport>> {
    if store.exists() {
        return Ok(None); // already migrated / fresh v2 config present
    }
    let v1_config = v1_root.join(V1_CONFIG_FILE_NAME);
    let v1_profiles = v1_root.join(V1_PROFILES_DIR_NAME);
    let has_config = v1_config.is_file();
    if !has_config && !v1_profiles.is_dir() {
        return Ok(None); // nothing to migrate
    }

    let mut config = if has_config {
        let raw = fs::read_to_string(&v1_config)
            .map_err(|e| DomainError::io(v1_config.display().to_string(), e))?;
        serde_json::from_str::<AppConfig>(&raw).map_err(|e| {
            DomainError::Migration(format!(
                "cannot parse v1 config '{}': {e}",
                v1_config.display()
            ))
        })?
    } else {
        AppConfig::default()
    };

    // Normalizations (architecture-v2.md §6 step 2).
    config.normalize_sentinels();
    fold_legacy_last_profile(&mut config);
    materialize_default_group(&mut config);

    let migrated_at = iso8601_utc_now();
    config.migrated_from = Some(v1_root.display().to_string());
    config.migrated_at = Some(migrated_at.clone());

    let profiles_copied = copy_profiles(&v1_profiles, profiles_dest)?;
    store.save(&config)?;

    Ok(Some(MigrationReport {
        source: v1_root.display().to_string(),
        config_imported: has_config,
        profiles_copied,
        migrated_at,
    }))
}

/// Fold the legacy `last_profile` into `last_profile_by_group["Default"]`
/// when the latter has no `Default` entry — the same migration v1 performed
/// at runtime (gui/app.py:82-88, §8.3 backend). The legacy key is dropped.
fn fold_legacy_last_profile(config: &mut AppConfig) {
    if let Some(last) = config.last_profile.take() {
        if !last.is_empty()
            && !config
                .last_profile_by_group
                .contains_key(DEFAULT_GROUP_NAME)
        {
            config
                .last_profile_by_group
                .insert(DEFAULT_GROUP_NAME.to_string(), last);
        }
    }
}

/// Materialize the virtual `Default` group from `workspace_dir` when no
/// groups exist — v1 synthesized it on every read (config_manager.py:323-333);
/// the migrator makes it explicit once (architecture-v2.md §6).
fn materialize_default_group(config: &mut AppConfig) {
    if config.workspace_groups.is_empty() {
        config.workspace_groups = config.workspace_groups_or_default();
    }
}

/// Recursively copy the v1 profiles tree (per-group subdirs + `<name>.json`
/// files, §15.1 backend). Returns the number of `.json` files copied.
/// Missing source → 0 (nothing to do).
fn copy_profiles(src: &Path, dest: &Path) -> DomainResult<usize> {
    if !src.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(dest).map_err(|e| DomainError::io(dest.display().to_string(), e))?;
    let mut copied = 0usize;
    let entries =
        fs::read_dir(src).map_err(|e| DomainError::io(src.display().to_string(), e))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let name = entry.file_name();
        let to = dest.join(&name);
        if from.is_dir() {
            copied += copy_profiles(&from, &to)?;
        } else if from.is_file() {
            fs::copy(&from, &to)
                .map_err(|e| DomainError::io(from.display().to_string(), e))?;
            if from.extension().and_then(|e| e.to_str()) == Some("json") {
                copied += 1;
            }
        }
    }
    Ok(copied)
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ` — std-only (no chrono in the
/// dependency set), using the standard civil-from-days algorithm.
fn iso8601_utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso8601_from_unix_secs(secs)
}

fn iso8601_from_unix_secs(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days-since-epoch → (year, month, day), proleptic Gregorian
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::app_config::{SENTINEL_NOT_SELECTED, SENTINEL_SYSTEM_DEFAULT};
    use crate::config::store::CONFIG_FILE_NAME;

    fn temp_dir(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dm2-migrate-{}-{}",
            std::process::id(),
            test
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn v1_config_json() -> String {
        format!(
            r#"{{
              "workspace_dir": "/ws/boa2",
              "language": "es_ES",
              "last_profile": "ghf",
              "repo_state": {{
                "svc": {{ "selected": true, "java_version": "{SENTINEL_SYSTEM_DEFAULT}" }}
              }},
              "active_configs": {{
                "svc::src/main/resources": "{SENTINEL_NOT_SELECTED}",
                "front::root": "dev"
              }},
              "java_versions": {{ "Java 17 (jdk-17)": "/opt/jdk-17" }}
            }}"#
        )
    }

    fn setup_v1(root: &Path) {
        fs::write(root.join(V1_CONFIG_FILE_NAME), v1_config_json()).unwrap();
        let profiles = root.join(V1_PROFILES_DIR_NAME);
        fs::create_dir_all(profiles.join("Nuevo_Grupo")).unwrap();
        fs::write(profiles.join("base.json"), r#"{"repos":{}}"#).unwrap();
        fs::write(profiles.join("Nuevo_Grupo/feat.json"), r#"{"repos":{}}"#).unwrap();
        fs::write(profiles.join("notes.txt"), "ignore me in the count").unwrap();
    }

    #[test]
    fn migrates_config_and_profiles_with_normalizations() {
        let root = temp_dir("full");
        setup_v1(&root);
        let store = ConfigStore::with_path(root.join("v2").join(CONFIG_FILE_NAME));
        let dest = root.join("v2-profiles");

        let report = migrate_from_v1(&store, &root, &dest).unwrap().expect("ran");
        assert!(report.config_imported);
        assert_eq!(report.profiles_copied, 2, "only .json files counted");
        assert!(report.migrated_at.ends_with('Z'));

        let cfg = store.load().unwrap();
        // Sentinels normalized; real values kept.
        assert_eq!(cfg.active_configs.get("front::root").map(String::as_str), Some("dev"));
        assert!(!cfg.active_configs.contains_key("svc::src/main/resources"));
        assert_eq!(cfg.repo_state["svc"].java_version, None);
        // last_profile folded into the Default group and dropped.
        assert_eq!(cfg.last_profile, None);
        assert_eq!(
            cfg.last_profile_by_group.get(DEFAULT_GROUP_NAME).map(String::as_str),
            Some("ghf")
        );
        // Default group materialized from workspace_dir.
        assert_eq!(cfg.workspace_groups.len(), 1);
        assert_eq!(cfg.workspace_groups[0].name, DEFAULT_GROUP_NAME);
        assert_eq!(cfg.workspace_groups[0].paths, vec!["/ws/boa2"]);
        // Markers stamped.
        assert_eq!(cfg.migrated_from.as_deref(), Some(root.display().to_string().as_str()));
        assert!(cfg.migrated_at.is_some());
        // Profile tree copied preserving the per-group layout.
        assert!(dest.join("base.json").is_file());
        assert!(dest.join("Nuevo_Grupo/feat.json").is_file());
        // v1 left untouched.
        assert!(root.join(V1_CONFIG_FILE_NAME).is_file());
        assert!(root.join(V1_PROFILES_DIR_NAME).join("base.json").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn idempotent_when_v2_config_exists() {
        let root = temp_dir("idempotent");
        setup_v1(&root);
        let store = ConfigStore::with_path(root.join("v2").join(CONFIG_FILE_NAME));
        let dest = root.join("v2-profiles");
        assert!(migrate_from_v1(&store, &root, &dest).unwrap().is_some());
        // Second run: config exists → no-op.
        assert!(migrate_from_v1(&store, &root, &dest).unwrap().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn noop_when_nothing_to_migrate() {
        let root = temp_dir("empty");
        let store = ConfigStore::with_path(root.join("v2").join(CONFIG_FILE_NAME));
        let result = migrate_from_v1(&store, &root, &root.join("dest")).unwrap();
        assert!(result.is_none());
        assert!(!store.exists(), "no config written for an empty source");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn profiles_only_install_still_migrates() {
        let root = temp_dir("profiles-only");
        let profiles = root.join(V1_PROFILES_DIR_NAME);
        fs::create_dir_all(&profiles).unwrap();
        fs::write(profiles.join("solo.json"), r#"{"repos":{}}"#).unwrap();
        let store = ConfigStore::with_path(root.join("v2").join(CONFIG_FILE_NAME));
        let report = migrate_from_v1(&store, &root, &root.join("dest"))
            .unwrap()
            .expect("ran");
        assert!(!report.config_imported);
        assert_eq!(report.profiles_copied, 1);
        assert!(store.exists(), "markers persisted even without a v1 config");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_v1_config_is_a_migration_error() {
        let root = temp_dir("corrupt");
        fs::write(root.join(V1_CONFIG_FILE_NAME), "{ not json").unwrap();
        let store = ConfigStore::with_path(root.join("v2").join(CONFIG_FILE_NAME));
        let err = migrate_from_v1(&store, &root, &root.join("dest")).unwrap_err();
        assert_eq!(err.kind(), "migration");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_last_profile_by_group_wins_over_legacy() {
        let root = temp_dir("fold");
        fs::write(
            root.join(V1_CONFIG_FILE_NAME),
            r#"{ "last_profile": "old", "last_profile_by_group": { "Default": "new" } }"#,
        )
        .unwrap();
        let store = ConfigStore::with_path(root.join("v2").join(CONFIG_FILE_NAME));
        migrate_from_v1(&store, &root, &root.join("dest")).unwrap();
        let cfg = store.load().unwrap();
        assert_eq!(
            cfg.last_profile_by_group.get("Default").map(String::as_str),
            Some("new")
        );
        assert_eq!(cfg.last_profile, None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn find_v1_install_probes_candidates_in_order() {
        let a = temp_dir("probe-a");
        let b = temp_dir("probe-b");
        fs::write(b.join(V1_CONFIG_FILE_NAME), "{}").unwrap();
        assert_eq!(
            find_v1_install(&[a.clone(), b.clone()]),
            Some(b.clone())
        );
        assert_eq!(find_v1_install(&[a.clone()]), None);
        let _ = fs::remove_dir_all(a);
        let _ = fs::remove_dir_all(b);
    }

    #[test]
    fn iso8601_known_timestamps() {
        assert_eq!(iso8601_from_unix_secs(0), "1970-01-01T00:00:00Z");
        // 2026-06-11 00:00:00 UTC (20615 days × 86400)
        assert_eq!(iso8601_from_unix_secs(1_781_136_000), "2026-06-11T00:00:00Z");
        // Leap-day check: 2024-02-29 12:34:56 UTC
        assert_eq!(iso8601_from_unix_secs(1_709_210_096), "2024-02-29T12:34:56Z");
    }
}
