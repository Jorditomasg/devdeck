//! Repo-type definition loading: bundled resources + user overrides.
//!
//! v1 loaded `<install>/config/repo_types/*.yml` only (inventory-backend.md
//! §6.1). v2 (architecture-v2.md §5):
//! 1. Load the bundled definitions (shipped as Tauri resources from
//!    `v2/config/repo-types/`).
//! 2. Load the user-override dir `dirs::config_dir()/devdeck/repo-types/`;
//!    a user file with the same `type` REPLACES the bundled one, new types add.
//! 3. Sort descending by `priority`, ties broken by `type` ascending so the
//!    result never depends on filesystem enumeration order (the v1
//!    react/docker-infra tie bug, inventory-config-ci.md §1.8.3).
//!
//! v1 tolerances kept: missing dir → no definitions from it; a document
//! without a `type` key is silently skipped; an unparsable file is skipped
//! with a warning (v1's `YamlParser.load` returned `None`).

use crate::domain::RepoTypeDef;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// User-override directory: `dirs::config_dir()/devdeck/repo-types`.
pub fn user_repo_types_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(super::store::APP_CONFIG_DIR_NAME).join("repo-types"))
}

/// Load and merge repo-type definitions.
///
/// `bundled_dir` is the resolved Tauri resource directory holding the shipped
/// YAMLs; `user_dir` is the optional override directory (pass
/// [`user_repo_types_dir`] in production, something else in tests).
/// Returns the merged set sorted by priority (descending, ties by type id).
pub fn load_repo_type_defs(bundled_dir: &Path, user_dir: Option<&Path>) -> Vec<RepoTypeDef> {
    let mut by_type: BTreeMap<String, RepoTypeDef> = BTreeMap::new();
    for def in load_defs_from_dir(bundled_dir) {
        by_type.insert(def.type_id.clone(), def);
    }
    if let Some(dir) = user_dir {
        for def in load_defs_from_dir(dir) {
            // Same `type` replaces bundled; new types add.
            by_type.insert(def.type_id.clone(), def);
        }
    }
    let mut defs: Vec<RepoTypeDef> = by_type.into_values().collect();
    sort_by_priority(&mut defs);

    let errors = crate::detection::validate::validate_all(&defs);
    for e in &errors {
        log::error!("repo-type '{}' invalid: {}", e.type_id, e.message);
    }
    // Drop invalid defs so detection never matches a broken type.
    let invalid: std::collections::HashSet<String> =
        errors.iter().map(|e| e.type_id.clone()).collect();
    defs.retain(|d| !invalid.contains(&d.type_id));
    defs
}

/// Priority-descending, ties broken by type id ascending (deterministic).
pub fn sort_by_priority(defs: &mut [RepoTypeDef]) {
    defs.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.type_id.cmp(&b.type_id))
    });
}

/// Load every `*.yml`/`*.yaml` definition in one directory. Never fails:
/// missing/unreadable dirs and broken documents are skipped (with a log
/// warning), mirroring v1's tolerance.
fn load_defs_from_dir(dir: &Path) -> Vec<RepoTypeDef> {
    let mut defs = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return defs, // missing dir → empty (v1 behavior)
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && matches!(
                    p.extension().and_then(|e| e.to_str()),
                    Some("yml") | Some("yaml")
                )
        })
        .collect();
    paths.sort(); // deterministic load order
    for path in paths {
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) => {
                log::warn!("skipping unreadable repo-type file {}: {e}", path.display());
                continue;
            }
        };
        match serde_yaml_ng::from_str::<RepoTypeDef>(&raw) {
            Ok(def) if def.type_id.is_empty() => {
                log::warn!("repo-type file {} has no `type` — skipped", path.display());
            }
            Ok(def) if def.schema_version != 2 => {
                log::error!(
                    "repo-type file {} has unsupported schema_version {} (expected 2) — skipped",
                    path.display(),
                    def.schema_version
                );
            }
            Ok(def) => defs.push(def),
            Err(e) => {
                log::error!("invalid repo-type file {}: {e}", path.display());
            }
        }
    }
    defs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dm2-rtloader-{}-{}",
            std::process::id(),
            test
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_def(dir: &Path, file: &str, content: &str) {
        fs::write(dir.join(file), content).unwrap();
    }

    #[test]
    fn loads_and_sorts_by_priority_desc() {
        let dir = temp_dir("sort");
        write_def(&dir, "low.yml", "schema_version: 2\ntype: low\npriority: 1");
        write_def(&dir, "high.yaml", "schema_version: 2\ntype: high\npriority: 99");
        write_def(&dir, "mid.yml", "schema_version: 2\ntype: mid\npriority: 50");
        let defs = load_repo_type_defs(&dir, None);
        let order: Vec<&str> = defs.iter().map(|d| d.type_id.as_str()).collect();
        assert_eq!(order, vec!["high", "mid", "low"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn equal_priority_ties_break_by_type_id_not_fs_order() {
        let dir = temp_dir("tie");
        // Filenames deliberately ordered against type ids.
        write_def(&dir, "a-file.yml", "schema_version: 2\ntype: zeta\npriority: 0");
        write_def(&dir, "z-file.yml", "schema_version: 2\ntype: alpha\npriority: 0");
        let defs = load_repo_type_defs(&dir, None);
        let order: Vec<&str> = defs.iter().map(|d| d.type_id.as_str()).collect();
        assert_eq!(order, vec!["alpha", "zeta"]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn user_override_replaces_bundled_by_type() {
        let bundled = temp_dir("ovr-bundled");
        let user = temp_dir("ovr-user");
        write_def(&bundled, "react.yml", "schema_version: 2\ntype: react\npriority: 10");
        write_def(&bundled, "angular.yml", "schema_version: 2\ntype: angular\npriority: 40");
        write_def(
            &user,
            "my-react.yml",
            "schema_version: 2\ntype: react\npriority: 70\nrun:\n  start:\n    default: vite",
        );
        write_def(&user, "custom.yml", "schema_version: 2\ntype: custom\npriority: 5");
        let defs = load_repo_type_defs(&bundled, Some(&user));
        assert_eq!(defs.len(), 3);
        let react = defs.iter().find(|d| d.type_id == "react").unwrap();
        assert_eq!(react.priority, 70, "user file must replace bundled");
        assert_eq!(react.run.start.default.as_deref(), Some("vite"));
        assert!(defs.iter().any(|d| d.type_id == "custom"));
        let _ = fs::remove_dir_all(bundled);
        let _ = fs::remove_dir_all(user);
    }

    #[test]
    fn skips_invalid_and_typeless_documents_and_missing_dirs() {
        let dir = temp_dir("skip");
        write_def(&dir, "broken.yml", "::: not yaml {{{");
        write_def(&dir, "no-type.yml", "schema_version: 2\npriority: 7");
        write_def(&dir, "ok.yml", "schema_version: 2\ntype: ok");
        write_def(&dir, "ignored.txt", "schema_version: 2\ntype: nope");
        let defs = load_repo_type_defs(&dir, Some(Path::new("/nonexistent/dir")));
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].type_id, "ok");
        assert_eq!(defs[0].priority, 0, "missing priority defaults to 0");
        let _ = fs::remove_dir_all(dir);
    }
}
