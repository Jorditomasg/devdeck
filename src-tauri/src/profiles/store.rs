//! Profile storage — CRUD over `<data_dir>/devdeck/profiles/`.
//!
//! Layout: the root dir holds the `Default` group's profiles; every other
//! group gets a sanitized subdirectory. One `<name>.json` per profile.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;

use super::types::{ProfileDocument, ProfileError};

/// Profile file extension.
pub const PROFILE_EXT: &str = ".json";

/// Group name that maps to the root profiles dir.
pub const DEFAULT_GROUP: &str = "Default";

fn sanitize_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"[<>:"/\\|?*]"#).expect("static regex"))
}

/// Convert a group name to a safe directory name: replace `<>:"/\|?*` with
/// `_`, strip leading/trailing `.`/`_`, empty → `default`.
pub fn sanitize_group_name(name: &str) -> String {
    let replaced = sanitize_re().replace_all(name, "_");
    let trimmed = replaced.trim_matches(|c| c == '.' || c == '_');
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Profile store rooted at one directory (injectable for tests).
#[derive(Debug, Clone)]
pub struct ProfileStore {
    root: PathBuf,
}

impl ProfileStore {
    /// Default OS location: `dirs::data_dir()/devdeck/profiles/`
    /// (architecture-v2.md §6-7).
    pub fn new() -> Result<Self, ProfileError> {
        let data = dirs::data_dir().ok_or(ProfileError::NoDataDir)?;
        Ok(Self::with_root(data.join("devdeck").join("profiles")))
    }

    /// Store rooted at an explicit directory.
    pub fn with_root(root: PathBuf) -> Self {
        Self { root }
    }

    /// The root directory (the `Default` group's directory).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Directory for a group, created on demand (v1 `get_profiles_dir`):
    /// `None`/`"Default"` → the root itself; anything else → a sanitized
    /// subdirectory.
    pub fn profiles_dir(&self, group: Option<&str>) -> PathBuf {
        let dir = match group {
            None | Some("") | Some(DEFAULT_GROUP) => self.root.clone(),
            Some(name) => self.root.join(sanitize_group_name(name)),
        };
        // Best-effort creation, like v1's os.makedirs(exist_ok=True).
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// Save a profile, injecting `name` and `created` (v1 `save_profile`).
    /// Returns the file path. Pretty JSON, like v1's `indent=2`.
    pub fn save_profile(
        &self,
        name: &str,
        group: Option<&str>,
        doc: &mut ProfileDocument,
    ) -> Result<PathBuf, ProfileError> {
        doc.name = Some(name.to_string());
        doc.created = Some(iso8601_utc_now());
        let path = self.profiles_dir(group).join(format!("{name}{PROFILE_EXT}"));
        std::fs::write(&path, serde_json::to_string_pretty(doc)?)?;
        Ok(path)
    }

    /// Load a profile or `None` (v1 `load_profile` — unreadable/broken files
    /// also yield `None`).
    pub fn load_profile(&self, name: &str, group: Option<&str>) -> Option<ProfileDocument> {
        let path = self.profiles_dir(group).join(format!("{name}{PROFILE_EXT}"));
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Sorted profile names of a group (v1 `list_profiles`).
    ///
    /// Backward-compat fallback (§22.12): a custom group with NO profiles
    /// lists the root (`Default`) directory's profiles instead — profiles
    /// saved before the groups feature stay visible.
    pub fn list_profiles(&self, group: Option<&str>) -> Vec<String> {
        let mut profiles = list_json_stems(&self.profiles_dir(group));
        if profiles.is_empty() {
            if let Some(name) = group {
                if !name.is_empty() && name != DEFAULT_GROUP {
                    profiles = list_json_stems(&self.profiles_dir(None));
                }
            }
        }
        profiles.sort();
        profiles
    }

    /// Delete a profile (v1 `delete_profile`).
    pub fn delete_profile(&self, name: &str, group: Option<&str>) -> bool {
        let path = self.profiles_dir(group).join(format!("{name}{PROFILE_EXT}"));
        std::fs::remove_file(path).is_ok()
    }
}

fn list_json_stems(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(PROFILE_EXT)?;
            e.path().is_file().then(|| stem.to_string())
        })
        .collect()
}

/// Export a profile document to an arbitrary file (v1
/// `export_profile_to_file`) — plain pretty JSON.
pub fn export_profile_to_file(doc: &ProfileDocument, dest: &Path) -> Result<(), ProfileError> {
    std::fs::write(dest, serde_json::to_string_pretty(doc)?)?;
    Ok(())
}

/// Import a profile from an external JSON file (v1
/// `import_profile_from_file`): the raw document MUST contain a `repos` key
/// or the file is rejected ([`ProfileError::MissingReposKey`]).
pub fn import_profile_from_file(path: &Path) -> Result<ProfileDocument, ProfileError> {
    let raw = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    if value.get("repos").is_none() {
        return Err(ProfileError::MissingReposKey);
    }
    Ok(serde_json::from_value(value)?)
}

// ---------------------------------------------------------------------------
// Timestamp (no chrono dependency)
// ---------------------------------------------------------------------------

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`. v1 used the local-time
/// `datetime.now().isoformat()`; v2 standardizes on UTC with an explicit `Z`
/// (the field is display-only — nothing parses it).
pub(crate) fn iso8601_utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso8601_utc(secs)
}

fn iso8601_utc(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let rem = epoch_secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Days-since-epoch → (year, month, day). Howard Hinnant's `civil_from_days`
/// algorithm (public domain).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_store(tag: &str) -> ProfileStore {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "dm2-profiles-{tag}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        ProfileStore::with_root(root)
    }

    fn doc_with_repo(repo: &str) -> ProfileDocument {
        let mut doc = ProfileDocument::default();
        doc.repos.insert(repo.to_string(), Default::default());
        doc
    }

    #[test]
    fn sanitize_group_names() {
        assert_eq!(sanitize_group_name("My/Group: A?"), "My_Group_ A");
        assert_eq!(sanitize_group_name("..__.."), "default");
        assert_eq!(sanitize_group_name(""), "default");
        assert_eq!(sanitize_group_name("plain"), "plain");
    }

    #[test]
    fn save_load_list_delete_round_trip() {
        let store = temp_store("crud");
        let mut doc = doc_with_repo("a-repo");
        let path = store.save_profile("ghf", None, &mut doc).unwrap();
        assert!(path.ends_with("ghf.json"));
        assert_eq!(doc.name.as_deref(), Some("ghf"), "name injected on save");
        assert!(doc.created.is_some(), "created injected on save");

        let loaded = store.load_profile("ghf", None).expect("load");
        assert_eq!(loaded.repos.len(), 1);
        assert_eq!(loaded.name.as_deref(), Some("ghf"));

        assert_eq!(store.list_profiles(None), vec!["ghf"]);
        assert!(store.delete_profile("ghf", None));
        assert!(store.load_profile("ghf", None).is_none());
        assert!(!store.delete_profile("ghf", None), "second delete fails");
    }

    #[test]
    fn custom_group_gets_sanitized_subdir() {
        let store = temp_store("groups");
        let mut doc = doc_with_repo("r");
        let path = store.save_profile("p1", Some("Team: A/B"), &mut doc).unwrap();
        assert!(path.parent().unwrap().ends_with("Team_ A_B"));
        assert_eq!(store.list_profiles(Some("Team: A/B")), vec!["p1"]);
        // Default group maps to the root dir itself.
        let root_path = store.save_profile("p2", Some("Default"), &mut doc).unwrap();
        assert_eq!(root_path.parent().unwrap(), store.root());
    }

    #[test]
    fn empty_custom_group_falls_back_to_root_listing() {
        // §22.12: intentional backwards compatibility.
        let store = temp_store("fallback");
        let mut doc = doc_with_repo("r");
        store.save_profile("legacy", None, &mut doc).unwrap();
        assert_eq!(store.list_profiles(Some("Nuevo Grupo")), vec!["legacy"]);
        // Once the group has its own profile, the fallback stops.
        store.save_profile("own", Some("Nuevo Grupo"), &mut doc).unwrap();
        assert_eq!(store.list_profiles(Some("Nuevo Grupo")), vec!["own"]);
    }

    #[test]
    fn import_requires_repos_key() {
        let store = temp_store("import");
        let dir = store.profiles_dir(None);
        let good = dir.join("good.json");
        let bad = dir.join("bad.json");
        std::fs::write(&good, r#"{"repos": {}}"#).unwrap();
        std::fs::write(&bad, r#"{"something": 1}"#).unwrap();
        assert!(import_profile_from_file(&good).is_ok());
        assert!(matches!(
            import_profile_from_file(&bad),
            Err(ProfileError::MissingReposKey)
        ));
    }

    #[test]
    fn export_round_trips_through_import() {
        let store = temp_store("export");
        let dest = store.profiles_dir(None).join("export.json");
        let mut doc = doc_with_repo("repo-x");
        doc.extra.insert("db_presets".into(), serde_json::json!({"local": 1}));
        export_profile_to_file(&doc, &dest).unwrap();
        let back = import_profile_from_file(&dest).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn iso8601_known_values() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        // Leap-year day.
        assert_eq!(iso8601_utc(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn list_json_stems_ignores_non_json() {
        let store = temp_store("stems");
        let dir = store.profiles_dir(None);
        std::fs::write(dir.join("a.json"), "{}").unwrap();
        std::fs::write(dir.join("b.txt"), "x").unwrap();
        assert_eq!(store.list_profiles(None), vec!["a"]);
    }
}
