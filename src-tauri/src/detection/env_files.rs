//! Environment/config file resolution + profile-name extraction.
//!
//! Port of `_resolve_env_files` / `_scan_default_dir_env_files` /
//! `_walk_env_files` / `_extract_profile_from_filename`
//! (project_analyzer.py:239-304, inventory-backend.md §6.6):
//! - no `env_files.patterns` → no env files, no profiles;
//! - fast path: when `default_dir` is set (`"."` = repo root) and exists,
//!   ONLY that directory is scanned (non-recursive, first matching pattern
//!   per file wins — `break` after match); anything found there short-circuits
//!   the tree walk;
//! - fallback: full top-down walk from the repo root, pruning
//!   `exclude_dirs` by directory NAME; every (file, pattern) match appends —
//!   a file matching two patterns is listed twice (v1 parity);
//! - the v1 hardcoded Spring `default` profile injection is driven by the v2
//!   schema flag `env_files.implicit_default_profile` (architecture-v2.md §5):
//!   profile `default` is added when any matched file's name ends with
//!   `application.yml|yaml|properties`;
//! - profiles returned sorted alphabetically.
//!
//! v2 addition: matched files are also grouped into [`RepoModule`]s by their
//! repo-relative directory — the unit behind the `"repo::module"` config-key
//! convention (inventory-config-ci.md §4.1).

use crate::detection::glob::fnmatch;
use crate::domain::{EnvFilesDef, RepoModule};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Result of the env-file resolution for one repository.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnvScan {
    /// Absolute paths of matched env files (flat, v1-compatible — may contain
    /// duplicates when a file matched several patterns on the walk path).
    pub files: Vec<String>,
    /// Profile names extracted from the matched filenames, sorted, deduped.
    pub profiles: Vec<String>,
    /// v2: env files grouped per repo-relative directory.
    pub modules: Vec<RepoModule>,
}

/// `environment\.?(.*)\.ts` — verbatim from project_analyzer.py:297
/// (anchored at the start: v1 used `re.match`).
fn environment_ts_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^environment\.?(.*)\.ts").expect("static regex"))
}

/// `application-(.+)\.(yml|yaml|properties)$` — verbatim from
/// project_analyzer.py:301 (anchored at the start: v1 used `re.match`).
fn application_profile_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^application-(.+)\.(yml|yaml|properties)$").expect("static regex")
    })
}

/// Extract a profile name from an env filename, keyed by the glob pattern
/// that matched it (project_analyzer.py:295-304):
/// - pattern containing `environment` → `environment\.?(.*)\.ts`, empty
///   capture → `default` (`environment.ts` → `default`,
///   `environment.prod.ts` → `prod`);
/// - pattern containing `application` →
///   `application-(.+)\.(yml|yaml|properties)$`, group 1
///   (plain `application.yml` adds nothing here — the implicit-default flag
///   handles it);
/// - any other pattern (e.g. `.env*`) → no profile.
pub fn extract_profile_from_filename(filename: &str, pattern: &str) -> Option<String> {
    if pattern.contains("environment") {
        let caps = environment_ts_re().captures(filename)?;
        let group = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        Some(if group.is_empty() {
            "default".to_string()
        } else {
            group.to_string()
        })
    } else if pattern.contains("application") {
        let caps = application_profile_re().captures(filename)?;
        Some(caps[1].to_string())
    } else {
        None
    }
}

/// True when the filename is a base Spring config — drives the
/// `implicit_default_profile` injection (v1 `_has_spring_default`,
/// project_analyzer.py:267-271 used `str.endswith` on the full path, which is
/// equivalent to a suffix check on the basename).
fn is_base_spring_config(filename: &str) -> bool {
    filename.ends_with("application.yml")
        || filename.ends_with("application.yaml")
        || filename.ends_with("application.properties")
}

/// Resolve env files for one repository per the repo-type `env_files` block.
pub fn resolve_env_files(repo_root: &Path, def: &EnvFilesDef) -> EnvScan {
    if def.patterns.is_empty() {
        return EnvScan::default();
    }

    // Fast path: scan ONLY default_dir when set and existing.
    if !def.default_dir.is_empty() {
        let target = if def.default_dir == "." {
            repo_root.to_path_buf()
        } else {
            repo_root.join(&def.default_dir)
        };
        if target.is_dir() {
            let matched = scan_default_dir(&target, &def.patterns);
            if !matched.is_empty() {
                return build_scan(repo_root, matched, def.implicit_default_profile);
            }
        }
    }

    // Fallback: full walk with exclude_dirs pruning.
    let exclude = def.effective_exclude_dirs();
    let matched = walk_env_files(repo_root, &def.patterns, &exclude);
    build_scan(repo_root, matched, def.implicit_default_profile)
}

/// One matched env file: absolute path + the profile its (filename, pattern)
/// pair yielded, if any.
type Matched = (PathBuf, Option<String>);

/// Non-recursive scan of one directory; FIRST matching pattern per file wins
/// (project_analyzer.py:239-252 breaks after the first match).
fn scan_default_dir(target: &Path, patterns: &[String]) -> Vec<Matched> {
    let mut found = Vec::new();
    for path in sorted_entries(target) {
        if !path.is_file() {
            continue;
        }
        let Some(name) = file_name(&path) else {
            continue;
        };
        for pattern in patterns {
            if fnmatch(&name, pattern) {
                let profile = extract_profile_from_filename(&name, pattern);
                found.push((path.clone(), profile));
                break; // first matching pattern wins
            }
        }
    }
    found
}

/// Top-down walk from the repo root, pruning excluded dir NAMES; every
/// (file, pattern) match appends — NO break (project_analyzer.py:254-265).
fn walk_env_files(repo_root: &Path, patterns: &[String], exclude: &[String]) -> Vec<Matched> {
    let mut found = Vec::new();
    let mut queue: Vec<PathBuf> = vec![repo_root.to_path_buf()];
    let mut next = 0usize;
    while next < queue.len() {
        let dir = queue[next].clone();
        next += 1;
        for path in sorted_entries(&dir) {
            if path.is_dir() {
                if let Some(name) = file_name(&path) {
                    if !exclude.iter().any(|e| *e == name) {
                        queue.push(path);
                    }
                }
            } else if path.is_file() {
                let Some(name) = file_name(&path) else {
                    continue;
                };
                for pattern in patterns {
                    if fnmatch(&name, pattern) {
                        let profile = extract_profile_from_filename(&name, pattern);
                        found.push((path.clone(), profile));
                        // no break — duplicate appends are v1 behavior
                    }
                }
            }
        }
    }
    found
}

/// Assemble the flat file list, the sorted profile set and the v2 module
/// grouping from the matched (file, profile) pairs.
fn build_scan(repo_root: &Path, matched: Vec<Matched>, implicit_default: bool) -> EnvScan {
    let mut files: Vec<String> = Vec::with_capacity(matched.len());
    let mut profiles: BTreeSet<String> = BTreeSet::new();

    // module dir → (deduped files, profiles, saw a base application.* file)
    let mut by_dir: BTreeMap<String, (Vec<String>, BTreeSet<String>, bool)> = BTreeMap::new();

    for (path, profile) in &matched {
        let abs = path.display().to_string();
        files.push(abs.clone());
        if let Some(p) = profile {
            profiles.insert(p.clone());
        }
        let dir = module_dir(repo_root, path);
        let entry = by_dir.entry(dir).or_default();
        if !entry.0.contains(&abs) {
            entry.0.push(abs);
        }
        if let Some(p) = profile {
            entry.1.insert(p.clone());
        }
        if file_name(path).is_some_and(|n| is_base_spring_config(&n)) {
            entry.2 = true;
        }
    }

    if implicit_default && by_dir.values().any(|(_, _, base)| *base) {
        profiles.insert("default".to_string());
        for entry in by_dir.values_mut() {
            if entry.2 {
                entry.1.insert("default".to_string());
            }
        }
    }

    let modules = by_dir
        .into_iter()
        .map(|(dir, (env_files, mod_profiles, _))| RepoModule {
            key: if dir.is_empty() {
                crate::config::app_config::ROOT_MODULE_KEY.to_string()
            } else {
                dir.clone()
            },
            dir,
            env_files,
            profiles: mod_profiles.into_iter().collect(),
        })
        .collect();

    EnvScan {
        files,
        profiles: profiles.into_iter().collect(),
        modules,
    }
}

/// Repo-relative POSIX directory of an env file (`""` for the repo root).
fn module_dir(repo_root: &Path, file: &Path) -> String {
    let parent = file.parent().unwrap_or(repo_root);
    let rel = parent.strip_prefix(repo_root).unwrap_or_else(|_| Path::new(""));
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Directory entries sorted by name (deterministic scan order — v1 relied on
/// unspecified `os.listdir`/`os.walk` order; v2 fixes the order).
fn sorted_entries(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd.flatten().map(|e| e.path()).collect(),
        Err(_) => return Vec::new(),
    };
    entries.sort();
    entries
}

fn file_name(path: &Path) -> Option<String> {
    path.file_name().map(|n| n.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::EnvFilesDef;

    fn temp_repo(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dm2-envfiles-{}-{}",
            std::process::id(),
            test
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(root: &Path, rel: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x=1").unwrap();
    }

    fn spring_def() -> EnvFilesDef {
        EnvFilesDef {
            default_dir: "src/main/resources".into(),
            patterns: vec![
                "application*.yml".into(),
                "application*.yaml".into(),
                "application*.properties".into(),
            ],
            exclude_dirs: Some(vec!["node_modules".into(), ".git".into(), "target".into()]),
            implicit_default_profile: true,
            ..Default::default()
        }
    }

    #[test]
    fn profile_extraction_regexes_match_inventory_examples() {
        // §6.6 examples, verbatim semantics.
        assert_eq!(
            extract_profile_from_filename("environment.prod.ts", "environment*.ts"),
            Some("prod".into())
        );
        assert_eq!(
            extract_profile_from_filename("environment.ts", "environment*.ts"),
            Some("default".into())
        );
        assert_eq!(
            extract_profile_from_filename("application-dev.yml", "application*.yml"),
            Some("dev".into())
        );
        assert_eq!(
            extract_profile_from_filename("application-pre.properties", "application*.properties"),
            Some("pre".into())
        );
        // Plain application.yml adds nothing via the regex path.
        assert_eq!(
            extract_profile_from_filename("application.yml", "application*.yml"),
            None
        );
        // `.env*` patterns never extract profiles in the analyzer.
        assert_eq!(extract_profile_from_filename(".env.local", ".env*"), None);
    }

    #[test]
    fn empty_patterns_disable_env_handling() {
        let root = temp_repo("nopatterns");
        touch(&root, "application.yml");
        let scan = resolve_env_files(&root, &EnvFilesDef::default());
        assert_eq!(scan, EnvScan::default());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fast_path_scans_only_default_dir_and_short_circuits() {
        let root = temp_repo("fastpath");
        touch(&root, "src/main/resources/application.yml");
        touch(&root, "src/main/resources/application-dev.yml");
        // This one must be IGNORED: fast path found files, walk is skipped.
        touch(&root, "submodule/src/main/resources/application-prod.yml");
        let scan = resolve_env_files(&root, &spring_def());
        assert_eq!(scan.files.len(), 2);
        assert!(scan.files.iter().all(|f| !f.contains("submodule")));
        // dev from the filename + default from the implicit flag.
        assert_eq!(scan.profiles, vec!["default", "dev"]);
        assert_eq!(scan.modules.len(), 1);
        assert_eq!(scan.modules[0].key, "src/main/resources");
        assert_eq!(scan.modules[0].dir, "src/main/resources");
        assert_eq!(scan.modules[0].profiles, vec!["default", "dev"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn walk_fallback_prunes_excluded_dirs() {
        let root = temp_repo("walk");
        // default_dir missing → walk path.
        touch(&root, "config/application-prod.yaml");
        touch(&root, "node_modules/dep/application-evil.yml");
        touch(&root, "target/application-stale.yml");
        touch(&root, ".git/application-internal.yml");
        let scan = resolve_env_files(&root, &spring_def());
        assert_eq!(scan.files.len(), 1);
        assert!(scan.files[0].contains("config"));
        assert_eq!(scan.profiles, vec!["prod"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn walk_appends_per_pattern_match_v1_parity() {
        let root = temp_repo("dup");
        touch(&root, "conf/.env.local");
        let def = EnvFilesDef {
            // nx-workspace ships ".env" and ".env.*"; a `.env.local` file
            // matches ".env.*" only — but a custom def with overlapping
            // patterns duplicates entries on the walk path (v1 behavior).
            patterns: vec![".env*".into(), ".env.*".into()],
            ..Default::default()
        };
        let scan = resolve_env_files(&root, &def);
        assert_eq!(scan.files.len(), 2, "one append per matching pattern");
        // The module view is deduped (v2 addition, clean by design).
        assert_eq!(scan.modules.len(), 1);
        assert_eq!(scan.modules[0].env_files.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fast_path_first_pattern_wins_no_duplicates() {
        let root = temp_repo("fastdup");
        touch(&root, ".env.local");
        let def = EnvFilesDef {
            default_dir: ".".into(),
            patterns: vec![".env*".into(), ".env.*".into()],
            ..Default::default()
        };
        let scan = resolve_env_files(&root, &def);
        assert_eq!(scan.files.len(), 1, "break after first matching pattern");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn root_module_key_is_root() {
        let root = temp_repo("rootkey");
        touch(&root, ".env");
        let def = EnvFilesDef {
            default_dir: ".".into(),
            patterns: vec![".env".into()],
            ..Default::default()
        };
        let scan = resolve_env_files(&root, &def);
        assert_eq!(scan.modules.len(), 1);
        assert_eq!(scan.modules[0].key, "root");
        assert_eq!(scan.modules[0].dir, "");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn no_implicit_default_without_flag() {
        let root = temp_repo("noimplicit");
        touch(&root, "application.yml");
        let def = EnvFilesDef {
            default_dir: ".".into(),
            patterns: vec!["application*.yml".into()],
            implicit_default_profile: false,
            ..Default::default()
        };
        let scan = resolve_env_files(&root, &def);
        assert!(scan.profiles.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_exclude_list_prunes_nothing() {
        let root = temp_repo("noprune");
        touch(&root, "node_modules/.env");
        let def = EnvFilesDef {
            patterns: vec![".env".into()],
            exclude_dirs: Some(vec![]), // explicit empty list — v1 distinction
            ..Default::default()
        };
        let scan = resolve_env_files(&root, &def);
        assert_eq!(scan.files.len(), 1);
        let _ = fs::remove_dir_all(root);
    }
}
