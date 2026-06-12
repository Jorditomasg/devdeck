//! Config-file readers/writers and env auto-import helpers.
//!
//! Port of the file-IO half of `core/config_manager.py`:
//! - Spring YAML config IO (§8.4 backend): profile `default` ⇒
//!   `application.yml`, otherwise `application-{profile}.yml` — always `.yml`
//!   (v1 never wrote `.yaml`/`.properties`);
//! - raw config-file IO (§8.5): used by the `angular` and `raw`
//!   `config_writer_type`s, which write the saved-environment content
//!   verbatim into `main_config_filename` (inventory-config-ci.md §1.5);
//! - profile-name derivation + env auto-import (§8.6:
//!   `_profile_name_from_file` / `auto_import_configs`).
//!
//! v2 differences vs v1: read failures other than "missing file" surface as
//! errors instead of silently returning `''`/`False`; writes create missing
//! parent directories.

use crate::domain::{DomainError, DomainResult};
use regex::Regex;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Spring config filename for one profile (config_manager.py:73-78):
/// `default` (or empty) → `application.yml`, else `application-{p}.yml`.
pub fn spring_config_filename(profile: &str) -> String {
    if profile.is_empty() || profile == "default" {
        "application.yml".to_string()
    } else {
        format!("application-{profile}.yml")
    }
}

/// Read the Spring config file for a profile as raw text. Missing file →
/// `Ok("")` (v1 returned `{}`); other IO errors surface.
pub fn read_spring_config(resources_dir: &Path, profile: &str) -> DomainResult<String> {
    read_config_file_raw(&resources_dir.join(spring_config_filename(profile)))
}

/// Write the Spring config for a profile. The content is validated as YAML
/// first (v1 parsed/re-dumped, §8.4 — a saved environment that is not valid
/// YAML must not silently corrupt `application.yml`), then written VERBATIM,
/// preserving the user's comments and formatting (v1's re-dump dropped them;
/// keeping the raw text is strictly better and round-trips with how
/// `repo_configs` snapshots are captured — raw file text, §8.3).
pub fn write_spring_config(
    resources_dir: &Path,
    profile: &str,
    content: &str,
) -> DomainResult<()> {
    let target = resources_dir.join(spring_config_filename(profile));
    serde_yaml_ng::from_str::<serde_yaml_ng::Value>(content).map_err(|e| {
        DomainError::YamlParse {
            path: target.display().to_string(),
            message: e.to_string(),
        }
    })?;
    write_config_file_raw(&target, content)
}

/// Raw read (config_manager.py:115-122). Missing file → `Ok("")`.
pub fn read_config_file_raw(path: &Path) -> DomainResult<String> {
    if !path.is_file() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|e| DomainError::io(path.display().to_string(), e))
}

/// Raw write (config_manager.py:104-112, 125-130); creates parent dirs.
pub fn write_config_file_raw(path: &Path, content: &str) -> DomainResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| DomainError::io(parent.display().to_string(), e))?;
    }
    fs::write(path, content).map_err(|e| DomainError::io(path.display().to_string(), e))
}

/// Write the ACTIVE saved-environment content through the repo type's
/// `config_writer_type` (inventory-config-ci.md §1.5): `spring` validates
/// YAML and targets the profile file inside the resources dir; `angular` and
/// `raw` write verbatim to `target_file` (`environment.ts` / `.env`).
pub fn write_active_environment(
    writer_type: &str,
    target_file: &Path,
    profile: &str,
    content: &str,
) -> DomainResult<()> {
    match writer_type {
        "spring" => {
            let resources_dir = target_file
                .parent()
                .ok_or_else(|| {
                    DomainError::Configuration(format!(
                        "spring target '{}' has no parent dir",
                        target_file.display()
                    ))
                })?;
            write_spring_config(resources_dir, profile, content)
        }
        // `angular` and `raw` (and any unknown future type) write verbatim —
        // v1 default behavior.
        _ => write_config_file_raw(target_file, content),
    }
}

/// Derive a profile/environment name from a filename using the repo-type
/// glob patterns (v1 `_profile_name_from_file`, config_manager.py:257-287):
/// first pattern that fnmatch-es wins; the glob is escaped to a regex with
/// `\*` → `(.*)`, the wildcard capture is stripped of leading `-._`; empty or
/// no match → `default`. Examples: `application-dev.yml` → `dev`,
/// `environment.production.ts` → `production`, `.env.local` → `local`.
pub fn profile_name_from_file(basename: &str, env_patterns: &[String]) -> String {
    for pattern in env_patterns {
        if !crate::detection::glob::fnmatch(basename, pattern) {
            continue;
        }
        let escaped = regex::escape(pattern).replace(r"\*", "(.*)");
        let Ok(re) = Regex::new(&format!("^{escaped}$")) else {
            continue;
        };
        let Some(caps) = re.captures(basename) else {
            continue;
        };
        let wildcard = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let name = wildcard.trim_start_matches(['-', '.', '_']);
        return if name.is_empty() {
            "default".to_string()
        } else {
            name.to_string()
        };
    }
    "default".to_string()
}

/// Scan existing env files and import them as saved environments
/// (v1 `auto_import_configs`, config_manager.py:290-317): returns
/// `{profile_name: content}`; empty content and missing files are skipped.
/// The caller must pre-scope `environment_files` to ONE directory (module)
/// to avoid name collisions — that is exactly what [`crate::domain::RepoModule`]
/// provides.
pub fn auto_import_configs(
    environment_files: &[String],
    env_patterns: &[String],
) -> BTreeMap<String, String> {
    let mut imported = BTreeMap::new();
    if environment_files.is_empty() || env_patterns.is_empty() {
        return imported;
    }
    for file in environment_files {
        let path = Path::new(file);
        if !path.is_file() {
            continue;
        }
        let Some(basename) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let name = profile_name_from_file(&basename, env_patterns);
        match read_config_file_raw(path) {
            Ok(content) if !content.is_empty() => {
                imported.insert(name, content);
            }
            _ => {}
        }
    }
    imported
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dm2-writers-{}-{}",
            std::process::id(),
            test
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn spring_filename_convention() {
        assert_eq!(spring_config_filename("default"), "application.yml");
        assert_eq!(spring_config_filename(""), "application.yml");
        assert_eq!(spring_config_filename("mysql"), "application-mysql.yml");
    }

    #[test]
    fn spring_writer_validates_yaml_and_preserves_text() {
        let dir = temp_dir("spring");
        let content = "# my comment\nserver:\n  port: 8080\n";
        write_spring_config(&dir, "default", content).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("application.yml")).unwrap(),
            content,
            "comments/formatting preserved"
        );
        // Invalid YAML must NOT touch the file. (Note: `:::{bad` would be a
        // VALID plain scalar — use an unclosed flow sequence instead.)
        let err = write_spring_config(&dir, "default", "a: [unclosed").unwrap_err();
        assert_eq!(err.kind(), "yaml_parse");
        assert_eq!(fs::read_to_string(dir.join("application.yml")).unwrap(), content);
        // Profile targets application-{p}.yml; read round-trips.
        write_spring_config(&dir, "mysql", "a: 1\n").unwrap();
        assert_eq!(read_spring_config(&dir, "mysql").unwrap(), "a: 1\n");
        assert_eq!(read_spring_config(&dir, "missing").unwrap(), "");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn raw_writer_creates_parents_and_round_trips() {
        let dir = temp_dir("raw");
        let target = dir.join("src/environments/environment.ts");
        write_config_file_raw(&target, "export const environment = {};").unwrap();
        assert_eq!(
            read_config_file_raw(&target).unwrap(),
            "export const environment = {};"
        );
        assert_eq!(read_config_file_raw(&dir.join("nope")).unwrap(), "");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn active_environment_dispatches_by_writer_type() {
        let dir = temp_dir("dispatch");
        let env = dir.join(".env");
        write_active_environment("raw", &env, "local", "KEY=1").unwrap();
        assert_eq!(fs::read_to_string(&env).unwrap(), "KEY=1");

        let resources = dir.join("src/main/resources");
        fs::create_dir_all(&resources).unwrap();
        write_active_environment("spring", &resources.join("application.yml"), "dev", "a: 1")
            .unwrap();
        assert!(resources.join("application-dev.yml").is_file());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn profile_name_derivation_matches_v1_examples() {
        // §8.6 examples.
        assert_eq!(
            profile_name_from_file("application-dev.yml", &["application*.yml".into()]),
            "dev"
        );
        assert_eq!(
            profile_name_from_file("environment.production.ts", &["environment*.ts".into()]),
            "production"
        );
        assert_eq!(profile_name_from_file(".env.local", &[".env*".into()]), "local");
        // No extra segment → default; no matching pattern → default.
        assert_eq!(
            profile_name_from_file("application.yml", &["application*.yml".into()]),
            "default"
        );
        assert_eq!(profile_name_from_file("random.txt", &[".env*".into()]), "default");
    }

    #[test]
    fn auto_import_skips_empty_and_missing() {
        let dir = temp_dir("autoimport");
        fs::write(dir.join("application-dev.yml"), "a: 1").unwrap();
        fs::write(dir.join("application-empty.yml"), "").unwrap();
        let files = vec![
            dir.join("application-dev.yml").display().to_string(),
            dir.join("application-empty.yml").display().to_string(),
            dir.join("application-gone.yml").display().to_string(),
        ];
        let imported = auto_import_configs(&files, &["application*.yml".into()]);
        assert_eq!(imported.len(), 1);
        assert_eq!(imported["dev"], "a: 1");
        // No patterns → nothing imported (v1 guard).
        assert!(auto_import_configs(&files, &[]).is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
