//! Applying profiles — missing-repo planning, config-file overwrite, and the
//! saved-environment merge with `repetidoN` renames + `active_configs`
//! repointing (inventory-backend.md §15.4, §8.6).
//!
//! All merge functions mutate an in-memory [`AppConfig`] — the commands
//! layer wraps them in `ConfigStore::update` so the read-modify-write is a
//! single guarded transaction (the v1 cache-mutation hazard §22.9 cannot
//! reappear).

use std::collections::BTreeMap;
use std::path::Path;

use crate::config::app_config::AppConfig;

use super::types::{ConfigFilesMap, MissingRepo, ProfileDocument, RenamesByKey, SavedEnvironmentsMap};

/// Module key for env files at the repo root (v1 used the literal `root`).
const ROOT_MODULE: &str = "root";

/// Repos in the profile whose `<workspace>/<name>` directory does not exist
/// (v1 `get_missing_repos`) — feeds the clone-missing-repos flow.
/// `branch` defaults to `main`.
pub fn get_missing_repos(workspace_dir: &Path, doc: &ProfileDocument) -> Vec<MissingRepo> {
    doc.repos
        .iter()
        .filter(|(name, _)| !workspace_dir.join(name).is_dir())
        .map(|(name, repo)| MissingRepo {
            name: name.clone(),
            git_url: repo.git_url.clone(),
            branch: repo.branch.clone().unwrap_or_else(|| "main".to_string()),
        })
        .collect()
}

/// Overwrite config files on disk from a profile snapshot
/// (v1 `apply_config_files`): creates directories as needed; per-file errors
/// are swallowed, exactly like v1.
pub fn apply_config_files(repo_path: &Path, config_files: &ConfigFilesMap) {
    for (rel_dir, files) in config_files {
        let dir_path = if rel_dir.is_empty() {
            repo_path.to_path_buf()
        } else {
            // rel_dir is POSIX-form; PathBuf::join handles `/` on Windows too.
            repo_path.join(rel_dir)
        };
        if std::fs::create_dir_all(&dir_path).is_err() {
            continue;
        }
        for (fname, content) in files {
            let _ = std::fs::write(dir_path.join(fname), content);
        }
    }
}

/// Module key of a saved-environment FILE path: its parent dir, `root` when
/// at the repo root (v1 `apply_saved_environments` key derivation).
pub fn module_dir_of_rel_path(rel_path: &str) -> String {
    match rel_path.rsplit_once('/') {
        Some((dir, _)) if !dir.is_empty() && dir != "." => dir.to_string(),
        _ => ROOT_MODULE.to_string(),
    }
}

/// Merge a profile's saved environments into `repo_configs`
/// (v1 `apply_saved_environments` → `merge_repo_configs` §8.6):
/// new name → added; identical content → skipped; conflicting content →
/// stored as the first free `repetidoN`. Returns
/// `{config_key: {original: renamed}}` for the conflicts.
pub fn apply_saved_environments(
    config: &mut AppConfig,
    repo_name: &str,
    saved_environments: &SavedEnvironmentsMap,
) -> RenamesByKey {
    let mut all_renames = RenamesByKey::new();
    for (rel_path, configs) in saved_environments {
        if configs.is_empty() {
            continue;
        }
        let config_key = format!("{repo_name}::{}", module_dir_of_rel_path(rel_path));
        let renames = config.merge_repo_configs(&config_key, configs);
        if !renames.is_empty() {
            all_renames.insert(config_key, renames);
        }
    }
    all_renames
}

/// Alternative import converting an on-disk `config_files` snapshot into
/// saved environments (v1 `apply_config_files_to_repo_configs`): the env
/// name of each file is derived from its filename. Same `repetidoN` merge.
pub fn apply_config_files_to_repo_configs(
    config: &mut AppConfig,
    repo_name: &str,
    config_files: &ConfigFilesMap,
) -> RenamesByKey {
    let mut all_renames = RenamesByKey::new();
    for (rel_dir, files) in config_files {
        let module = if rel_dir.is_empty() { ROOT_MODULE } else { rel_dir };
        let config_key = format!("{repo_name}::{module}");
        let incoming: BTreeMap<String, String> = files
            .iter()
            .map(|(fname, content)| (derive_profile_name_from_filename(fname), content.clone()))
            .collect();
        if incoming.is_empty() {
            continue;
        }
        let renames = config.merge_repo_configs(&config_key, &incoming);
        if !renames.is_empty() {
            all_renames.insert(config_key, renames);
        }
    }
    all_renames
}

/// Repoint `active_configs` entries whose selected name was renamed during
/// import (v1 `update_active_configs_for_renames`). Returns whether anything
/// changed (the caller persists only then).
pub fn update_active_configs_for_renames(
    config: &mut AppConfig,
    renames_by_key: &RenamesByKey,
) -> bool {
    let mut changed = false;
    for (config_key, renames) in renames_by_key {
        if let Some(current) = config.active_configs.get(config_key) {
            if let Some(renamed) = renames.get(current) {
                config
                    .active_configs
                    .insert(config_key.clone(), renamed.clone());
                changed = true;
            }
        }
    }
    changed
}

/// Heuristically derive an env/profile name from a config filename
/// (v1 `_derive_profile_name_from_filename`):
/// strip one known extension (`.yml/.yaml/.ts/.js/.properties/.json`), strip
/// a leading dot, then strip a known prefix (`application-`, `application.`,
/// `environment.`, `environment-`, `env-`, `env.`) — the remainder is the
/// name (empty → `default`); bare `application`/`environment`/`env` →
/// `default`; anything else → `default`.
pub fn derive_profile_name_from_filename(filename: &str) -> String {
    let mut base = filename.to_string();
    for ext in [".yml", ".yaml", ".ts", ".js", ".properties", ".json"] {
        if base.to_lowercase().ends_with(ext) {
            base.truncate(base.len() - ext.len());
            break;
        }
    }
    if let Some(stripped) = base.strip_prefix('.') {
        base = stripped.to_string();
    }
    let lower = base.to_lowercase();
    for prefix in [
        "application-",
        "application.",
        "environment.",
        "environment-",
        "env-",
        "env.",
    ] {
        if lower.starts_with(prefix) {
            let rest = &base[prefix.len()..];
            return if rest.is_empty() { "default".to_string() } else { rest.to_string() };
        }
    }
    "default".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::app_config::AppConfig;

    // ---- name derivation ----------------------------------------------

    #[test]
    fn derive_profile_names_match_v1_examples() {
        assert_eq!(derive_profile_name_from_filename("application.yml"), "default");
        assert_eq!(derive_profile_name_from_filename("application-local.yml"), "local");
        assert_eq!(derive_profile_name_from_filename("application-dev.yml"), "dev");
        assert_eq!(derive_profile_name_from_filename("environment.ts"), "default");
        assert_eq!(derive_profile_name_from_filename("environment.local.ts"), "local");
        assert_eq!(derive_profile_name_from_filename(".env"), "default");
        assert_eq!(derive_profile_name_from_filename(".env.local"), "local");
        assert_eq!(derive_profile_name_from_filename("application.properties"), "default");
        assert_eq!(derive_profile_name_from_filename("whatever.txt"), "default");
        assert_eq!(derive_profile_name_from_filename("random.json"), "default");
    }

    #[test]
    fn module_dir_derivation() {
        assert_eq!(module_dir_of_rel_path("src/main/resources/application.yml"), "src/main/resources");
        assert_eq!(module_dir_of_rel_path(".env"), "root");
        assert_eq!(module_dir_of_rel_path("application.yml"), "root");
    }

    // ---- missing repos --------------------------------------------------

    #[test]
    fn missing_repos_default_branch_main() {
        let mut doc = ProfileDocument::default();
        doc.repos.insert(
            "ghost-repo".to_string(),
            super::super::types::RepoProfile {
                git_url: "https://example.com/ghost.git".to_string(),
                branch: None,
                ..Default::default()
            },
        );
        let missing = get_missing_repos(Path::new("/definitely/not/a/workspace"), &doc);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].name, "ghost-repo");
        assert_eq!(missing[0].branch, "main", "v1 default branch");
        assert_eq!(missing[0].git_url, "https://example.com/ghost.git");
    }

    // ---- saved-environment merge + repointing --------------------------

    fn saved(rel_path: &str, entries: &[(&str, &str)]) -> SavedEnvironmentsMap {
        let mut map = SavedEnvironmentsMap::new();
        map.insert(
            rel_path.to_string(),
            entries.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        );
        map
    }

    #[test]
    fn saved_envs_merge_with_repetido_renames_and_repoint() {
        let mut cfg = AppConfig::default();
        let key = "petclinic::src/main/resources";
        cfg.set_repo_configs_for(
            key,
            [("dev".to_string(), "EXISTING".to_string())].into_iter().collect(),
        );
        cfg.active_configs.insert(key.to_string(), "dev".to_string());

        // Incoming profile: conflicting "dev", identical-later "same", new "prod".
        let incoming = saved(
            "src/main/resources/application.yml",
            &[("dev", "DIFFERENT"), ("prod", "P")],
        );
        let renames = apply_saved_environments(&mut cfg, "petclinic", &incoming);
        assert_eq!(renames[key]["dev"], "repetido1");

        let stored = cfg.repo_configs_for(key);
        assert_eq!(stored["dev"], "EXISTING", "original untouched");
        assert_eq!(stored["repetido1"], "DIFFERENT");
        assert_eq!(stored["prod"], "P");

        // active_configs pointed at "dev" — the IMPORTED dev got renamed, and
        // v1 repoints the active selection to the renamed entry.
        let changed = update_active_configs_for_renames(&mut cfg, &renames);
        assert!(changed);
        assert_eq!(cfg.active_configs[key], "repetido1");

        // Re-import of identical content: no renames, no repoint.
        let incoming2 = saved("src/main/resources/application.yml", &[("prod", "P")]);
        let renames2 = apply_saved_environments(&mut cfg, "petclinic", &incoming2);
        assert!(renames2.is_empty());
        assert!(!update_active_configs_for_renames(&mut cfg, &renames2));
    }

    #[test]
    fn config_files_import_derives_names_and_merges() {
        let mut cfg = AppConfig::default();
        let mut files = ConfigFilesMap::new();
        files.insert(
            "src/main/resources".to_string(),
            [
                ("application.yml".to_string(), "BASE".to_string()),
                ("application-dev.yml".to_string(), "DEV".to_string()),
            ]
            .into_iter()
            .collect(),
        );
        files.insert(
            "".to_string(), // repo root → module "root"
            [(".env.local".to_string(), "LOCAL".to_string())].into_iter().collect(),
        );

        let renames = apply_config_files_to_repo_configs(&mut cfg, "petclinic", &files);
        assert!(renames.is_empty());
        let spring = cfg.repo_configs_for("petclinic::src/main/resources");
        assert_eq!(spring["default"], "BASE");
        assert_eq!(spring["dev"], "DEV");
        let root = cfg.repo_configs_for("petclinic::root");
        assert_eq!(root["local"], "LOCAL");
    }

    // ---- config files on disk -------------------------------------------

    #[test]
    fn apply_config_files_writes_and_creates_dirs() {
        let repo = std::env::temp_dir().join(format!("dm2-apply-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        let mut files = ConfigFilesMap::new();
        files.insert(
            "src/main/resources".to_string(),
            [("application.yml".to_string(), "server:\n  port: 1\n".to_string())]
                .into_iter()
                .collect(),
        );
        files.insert(
            "".to_string(),
            [(".env".to_string(), "X=1".to_string())].into_iter().collect(),
        );
        apply_config_files(&repo, &files);
        assert_eq!(
            std::fs::read_to_string(repo.join("src/main/resources/application.yml")).unwrap(),
            "server:\n  port: 1\n"
        );
        assert_eq!(std::fs::read_to_string(repo.join(".env")).unwrap(), "X=1");
        let _ = std::fs::remove_dir_all(&repo);
    }
}
