//! Capturing the optional "include config files" snapshots when a profile is
//! saved (inventory-backend.md §15.3: `_capture_config_files` /
//! `_capture_saved_environments`).
//!
//! The commands layer assembles the rest of each `RepoProfile` from the
//! frontend card state (branch/profile/custom command/java/selection) and
//! calls these to embed file contents.

use std::collections::BTreeMap;
use std::path::Path;

use crate::config::app_config::AppConfig;

use super::types::{ConfigFilesMap, SavedEnvironmentsMap};

/// Read every existing env file into the `config_files` snapshot, grouped by
/// repo-relative POSIX dir — `""` for the repo root (v1
/// `_capture_config_files`). Unreadable files are skipped silently.
pub fn capture_config_files(repo_path: &Path, environment_files: &[String]) -> ConfigFilesMap {
    let mut files_by_dir = ConfigFilesMap::new();
    for ef in environment_files {
        let path = Path::new(ef);
        if !path.is_file() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(path) else { continue };
        let Some(fname) = path.file_name() else { continue };
        let rel_dir = relative_config_dir(repo_path, path);
        files_by_dir
            .entry(rel_dir)
            .or_default()
            .insert(fname.to_string_lossy().into_owned(), content);
    }
    files_by_dir
}

/// Export the saved environments of every env-file module into the
/// `saved_environments` snapshot, keyed by the file's repo-relative POSIX
/// path (v1 `_capture_saved_environments`). Modules without saved
/// environments are omitted.
pub fn capture_saved_environments(
    config: &AppConfig,
    repo_name: &str,
    repo_path: &Path,
    environment_files: &[String],
) -> SavedEnvironmentsMap {
    let mut envs_by_file = SavedEnvironmentsMap::new();
    for ef in environment_files {
        let path = Path::new(ef);
        // v1 wrapped relpath in try/except ValueError → skip on failure.
        let Ok(rel) = path.strip_prefix(repo_path) else { continue };
        let rel_path = posix(rel);
        let dir = match rel_path.rsplit_once('/') {
            Some((dir, _)) if !dir.is_empty() && dir != "." => dir.to_string(),
            _ => "root".to_string(),
        };
        let config_key = format!("{repo_name}::{dir}");
        let configs: BTreeMap<String, String> = config.repo_configs_for(&config_key);
        if !configs.is_empty() {
            envs_by_file.insert(rel_path, configs);
        }
    }
    envs_by_file
}

/// Repo-relative POSIX directory of a config file; `""` at the root or when
/// the file is not under the repo (v1 `_relative_config_dir`).
fn relative_config_dir(repo_path: &Path, file: &Path) -> String {
    let Some(parent) = file.parent() else { return String::new() };
    match parent.strip_prefix(repo_path) {
        Ok(rel) => {
            let rel = posix(rel);
            if rel == "." { String::new() } else { rel }
        }
        Err(_) => String::new(),
    }
}

/// Path → forward-slash string (profiles are shared across OSes).
fn posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("dm2-capture-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src/main/resources")).unwrap();
        root
    }

    #[test]
    fn captures_files_grouped_by_relative_dir() {
        let repo = temp_repo("files");
        let nested = repo.join("src/main/resources/application.yml");
        let root_file = repo.join(".env");
        std::fs::write(&nested, "Y").unwrap();
        std::fs::write(&root_file, "X").unwrap();

        let files = capture_config_files(
            &repo,
            &[
                nested.to_string_lossy().into_owned(),
                root_file.to_string_lossy().into_owned(),
                repo.join("missing.yml").to_string_lossy().into_owned(), // skipped
            ],
        );
        assert_eq!(files["src/main/resources"]["application.yml"], "Y");
        assert_eq!(files[""][".env"], "X");
        assert_eq!(files.len(), 2);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn captures_saved_environments_keyed_by_rel_path() {
        let repo = temp_repo("envs");
        let mut cfg = AppConfig::default();
        cfg.set_repo_configs_for(
            "demo::src/main/resources",
            [("mysql".to_string(), "M".to_string())].into_iter().collect(),
        );
        cfg.set_repo_configs_for(
            "demo::root",
            [("local".to_string(), "L".to_string())].into_iter().collect(),
        );

        let nested = repo.join("src/main/resources/application.yml");
        let root_file = repo.join(".env");
        let outside = std::env::temp_dir().join("outside.yml");
        let envs = capture_saved_environments(
            &cfg,
            "demo",
            &repo,
            &[
                nested.to_string_lossy().into_owned(),
                root_file.to_string_lossy().into_owned(),
                outside.to_string_lossy().into_owned(), // not under repo → skipped
            ],
        );
        assert_eq!(envs["src/main/resources/application.yml"]["mysql"], "M");
        assert_eq!(envs[".env"]["local"], "L");
        assert_eq!(envs.len(), 2);
        let _ = std::fs::remove_dir_all(&repo);
    }
}
