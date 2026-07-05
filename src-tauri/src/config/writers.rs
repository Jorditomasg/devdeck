//! Config-file readers/writers and env auto-import helpers.
//!
//! Port of the file-IO half of `core/config_manager.py`:
//! - Spring config IO (§8.4 backend): `write_spring_config` targets
//!   `application.yml` / `application-{profile}.yml` (the low-level per-profile
//!   writer, still used for reads). NOTE: the ACTIVE-write path (`SpringWriter`)
//!   now stamps the selected env into the BASE running file only — see its doc
//!   (Model B, design doc 2026-07-05-env-drift-deselection);
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
use std::path::{Path, PathBuf};

/// Spring profile filename with an explicit extension: `default`/empty →
/// `application.{ext}`, else `application-{p}.{ext}`.
fn spring_profile_filename(profile: &str, ext: &str) -> String {
    if profile.is_empty() || profile == "default" {
        format!("application.{ext}")
    } else {
        format!("application-{profile}.{ext}")
    }
}

/// Spring config filename for one profile (config_manager.py:73-78):
/// `default` (or empty) → `application.yml`, else `application-{p}.yml`.
pub fn spring_config_filename(profile: &str) -> String {
    spring_profile_filename(profile, "yml")
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

/// A named strategy for writing the ACTIVE environment/config file. Each repo
/// type's `config.writer` selects one of these by [`ConfigWriter::name`].
pub trait ConfigWriter: Sync {
    fn name(&self) -> &'static str;
    /// The file this writer actually writes (and reads back) for `profile` —
    /// the "active" environment file. For `raw`/`angular` it is `target_file`;
    /// for `spring` it is the profile file inside the resources dir. The
    /// read-side counterpart of [`ConfigWriter::write_active`], used to detect
    /// a user editing the file out of sync with the selected environment.
    fn active_path(&self, target_file: &Path, profile: &str) -> DomainResult<PathBuf>;
    fn write_active(&self, target_file: &Path, profile: &str, content: &str) -> DomainResult<()>;
}

/// `raw` — writes the saved-environment content verbatim to `target_file`
/// (e.g. `.env`); v1 default behavior.
struct RawWriter;
impl ConfigWriter for RawWriter {
    fn name(&self) -> &'static str {
        "raw"
    }
    fn active_path(&self, target_file: &Path, _profile: &str) -> DomainResult<PathBuf> {
        Ok(target_file.to_path_buf())
    }
    fn write_active(&self, target_file: &Path, _profile: &str, content: &str) -> DomainResult<()> {
        write_config_file_raw(target_file, content)
    }
}

/// `angular` — writes verbatim to `target_file` (`environment.ts`); identical
/// IO to `raw`, kept distinct so the YAML can name intent.
struct AngularWriter;
impl ConfigWriter for AngularWriter {
    fn name(&self) -> &'static str {
        "angular"
    }
    fn active_path(&self, target_file: &Path, _profile: &str) -> DomainResult<PathBuf> {
        Ok(target_file.to_path_buf())
    }
    fn write_active(&self, target_file: &Path, _profile: &str, content: &str) -> DomainResult<()> {
        write_config_file_raw(target_file, content)
    }
}

/// `spring` — stamps the selected environment into the BASE config file that
/// actually runs (`application.{ext}`, NO profile suffix), inside the resources
/// dir (the parent of `target_file`). This mirrors the `raw`/`angular` writers,
/// which target their single running file: `mvn spring-boot:run` loads
/// `application.properties`/`.yml` by default, so writing to
/// `application-{profile}.*` had no runtime effect (design doc
/// 2026-07-05-env-drift-deselection, Model B). The per-profile
/// `application-{p}.*` files remain as preset SOURCES only.
///
/// The FORMAT is honored: a `.properties` base is written verbatim (properties
/// are NOT YAML — validating them broke petclinic-style repos, user report
/// 2026-07-03); a `.yml` base keeps the YAML validation.
struct SpringWriter;
impl ConfigWriter for SpringWriter {
    fn name(&self) -> &'static str {
        "spring"
    }
    fn active_path(&self, target_file: &Path, _profile: &str) -> DomainResult<PathBuf> {
        let resources_dir = target_file.parent().ok_or_else(|| {
            DomainError::Configuration(format!(
                "spring target '{}' has no parent dir",
                target_file.display()
            ))
        })?;
        let ext = if target_file
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("properties"))
        {
            "properties"
        } else {
            "yml"
        };
        // Model B: always the base file (`application.{ext}`), regardless of the
        // selected profile — that is the file Spring runs by default.
        Ok(resources_dir.join(spring_profile_filename("default", ext)))
    }
    fn write_active(&self, target_file: &Path, profile: &str, content: &str) -> DomainResult<()> {
        let path = self.active_path(target_file, profile)?;
        // `.properties` are NOT YAML — validating them broke petclinic-style
        // repos (user report 2026-07-03); `.yml` keeps the YAML validation.
        if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("properties"))
        {
            return write_config_file_raw(&path, content);
        }
        serde_yaml_ng::from_str::<serde_yaml_ng::Value>(content).map_err(|e| {
            DomainError::YamlParse {
                path: path.display().to_string(),
                message: e.to_string(),
            }
        })?;
        write_config_file_raw(&path, content)
    }
}

/// THE single place writers are registered. Add new writers here.
/// NOTE: impls must stay zero-sized / const-constructible — this relies on
/// static promotion of `&Impl`. One holding runtime state (Regex, String)
/// won't promote; switch to a `OnceLock<Vec<Box<dyn ConfigWriter>>>` if that day comes.
fn writers() -> &'static [&'static dyn ConfigWriter] {
    &[&RawWriter, &AngularWriter, &SpringWriter]
}

/// Look up a writer by name; unknown names fall back to `raw` (v1 parity —
/// any unknown future type writes verbatim).
fn writer_for(name: &str) -> &'static dyn ConfigWriter {
    writers()
        .iter()
        .copied()
        .find(|w| w.name() == name)
        .unwrap_or(&RawWriter)
}

/// True when `name` is a registered config writer (used by validation).
pub fn writer_exists(name: &str) -> bool {
    writers().iter().any(|w| w.name() == name)
}

/// Write the ACTIVE saved-environment content through the repo type's
/// `config_writer_type` (inventory-config-ci.md §1.5), dispatching through the
/// writers registry: `spring` validates YAML and targets the profile file
/// inside the resources dir; `angular`/`raw` (and any unknown type) write
/// verbatim to `target_file` (`environment.ts` / `.env`).
pub fn write_active_environment(
    writer_type: &str,
    target_file: &Path,
    profile: &str,
    content: &str,
) -> DomainResult<()> {
    writer_for(writer_type).write_active(target_file, profile, content)
}

/// Resolve the file that [`write_active_environment`] writes for `profile`
/// (the single source of truth for that mapping). `spring` targets the profile
/// file inside the resources dir; `angular`/`raw` (and unknown types) → the
/// target file itself.
pub fn resolve_active_file(
    writer_type: &str,
    target_file: &Path,
    profile: &str,
) -> DomainResult<PathBuf> {
    writer_for(writer_type).active_path(target_file, profile)
}

/// Read the current content of the active environment file (the read-side
/// counterpart of [`write_active_environment`]). Missing file → `Ok("")`.
/// Used to detect that a user edited the file out of sync with the selected
/// saved environment (drift → deselect).
pub fn read_active_environment(
    writer_type: &str,
    target_file: &Path,
    profile: &str,
) -> DomainResult<String> {
    read_config_file_raw(&resolve_active_file(writer_type, target_file, profile)?)
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
    fn known_writers_registered() {
        assert!(writer_exists("raw"));
        assert!(writer_exists("spring"));
        assert!(writer_exists("angular"));
        assert!(!writer_exists("toml"));
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
        // Model B: stamps into the BASE file, NOT application-dev.yml.
        write_active_environment("spring", &resources.join("application.yml"), "dev", "a: 1")
            .unwrap();
        assert!(resources.join("application.yml").is_file());
        assert!(!resources.join("application-dev.yml").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_and_read_active_file() {
        let dir = temp_dir("resolve");
        // raw/angular: the active file IS the target.
        let env = dir.join(".env");
        assert_eq!(resolve_active_file("raw", &env, "local").unwrap(), env);
        assert_eq!(resolve_active_file("angular", &env, "prod").unwrap(), env);
        // unknown writer falls back to raw → target.
        assert_eq!(resolve_active_file("toml", &env, "x").unwrap(), env);

        // spring (Model B): ANY profile resolves to the BASE running file
        // (application.{ext}), never the per-profile file. The ext follows the
        // target file's extension.
        let resources = dir.join("src/main/resources");
        fs::create_dir_all(&resources).unwrap();
        let yml_target = resources.join("application.yml");
        assert_eq!(
            resolve_active_file("spring", &yml_target, "dev").unwrap(),
            resources.join("application.yml")
        );
        assert_eq!(
            resolve_active_file("spring", &yml_target, "default").unwrap(),
            resources.join("application.yml")
        );
        // A per-profile target still resolves to the base — .properties format.
        let props_target = resources.join("application-mysql.properties");
        assert_eq!(
            resolve_active_file("spring", &props_target, "mysql").unwrap(),
            resources.join("application.properties")
        );

        // read_active_environment returns the base file's content; missing → "".
        write_active_environment("spring", &yml_target, "dev", "a: 1\n").unwrap();
        assert_eq!(
            read_active_environment("spring", &yml_target, "dev").unwrap(),
            "a: 1\n"
        );
        // Same base file regardless of the profile queried.
        assert_eq!(
            read_active_environment("spring", &yml_target, "prod").unwrap(),
            "a: 1\n"
        );
        assert_eq!(read_active_environment("raw", &env, "local").unwrap(), "");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn spring_writer_honors_properties_repos() {
        let dir = temp_dir("spring-props");
        let resources = dir.join("src/main/resources");
        fs::create_dir_all(&resources).unwrap();
        // Real-world properties content that is NOT valid YAML (petclinic's
        // `#---` document separators broke the YAML validation, 2026-07-03).
        let content = "database=mysql\nspring.datasource.url=${MYSQL_URL:jdbc:mysql://x/y}\n#---\nspring.sql.init.mode=always\n";
        // Model B: selecting "mysql" stamps into the BASE application.properties
        // (the running file), verbatim, no YAML validation — NOT the per-profile
        // application-mysql.properties.
        write_active_environment(
            "spring",
            &resources.join("application-mysql.properties"),
            "mysql",
            content,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(resources.join("application.properties")).unwrap(),
            content,
            "verbatim into the base .properties file, no YAML validation"
        );
        assert!(
            !resources.join("application-mysql.properties").exists(),
            "the per-profile file is not written on apply"
        );
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
