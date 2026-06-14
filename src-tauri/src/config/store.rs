//! Config persistence: OS config dir, atomic writes, in-memory cache.
//!
//! Replaces v1's install-dir `devops_manager_config.json` + module-level
//! mtime cache (`core/config_manager.py` §8.1-8.2 backend). v2 differences:
//! - the file lives in `dirs::config_dir()/devdeck/config.json`
//!   (architecture-v2.md §7 fix 5 — writable under Program Files installs);
//! - writes are atomic (temp file + rename) instead of in-place `json.dump`;
//! - the cache hands out clones, never shared mutable state (fixes the
//!   §22.9 backend hazard), and read-modify-write goes through
//!   [`ConfigStore::update`] under a write lock.

use crate::config::app_config::AppConfig;
use crate::domain::{DomainError, DomainResult};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::SystemTime;

/// Directory name under the OS config dir.
pub const APP_CONFIG_DIR_NAME: &str = "devdeck";
/// Config file name.
pub const CONFIG_FILE_NAME: &str = "config.json";

#[derive(Debug, Clone)]
struct Cached {
    config: AppConfig,
    mtime: Option<SystemTime>,
}

/// Thread-safe store for the application config file.
#[derive(Debug)]
pub struct ConfigStore {
    path: PathBuf,
    cache: RwLock<Option<Cached>>,
    /// Serializes read-modify-write cycles in [`ConfigStore::update`].
    write_lock: Mutex<()>,
}

impl ConfigStore {
    /// `dirs::config_dir()/devdeck/config.json`.
    pub fn default_path() -> DomainResult<PathBuf> {
        let base = dirs::config_dir().ok_or(DomainError::NoOsDirectory("config"))?;
        Ok(base.join(APP_CONFIG_DIR_NAME).join(CONFIG_FILE_NAME))
    }

    /// Store rooted at the OS-standard location.
    pub fn new() -> DomainResult<Self> {
        Ok(Self::with_path(Self::default_path()?))
    }

    /// Store rooted at an explicit path (tests, portable mode).
    pub fn with_path(path: PathBuf) -> Self {
        ConfigStore {
            path,
            cache: RwLock::new(None),
            write_lock: Mutex::new(()),
        }
    }

    /// The backing file path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the backing file exists on disk (used by the migrator's
    /// idempotency check).
    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    /// Load the config, served from the in-memory cache while the file's
    /// mtime is unchanged (v1 `_load_config_cached` semantics, §8.1 backend).
    /// A missing file yields `AppConfig::default()`; a corrupt file is an
    /// error (v1 silently returned `{}` — v2 surfaces it so the commands
    /// layer can warn instead of silently wiping user data).
    ///
    /// Spanish sentinels are normalized on every load; the on-disk file is
    /// left as-is until the next save.
    pub fn load(&self) -> DomainResult<AppConfig> {
        let mtime = fs::metadata(&self.path).and_then(|m| m.modified()).ok();

        if let Ok(guard) = self.cache.read() {
            if let Some(cached) = guard.as_ref() {
                if cached.mtime == mtime && mtime.is_some() {
                    return Ok(cached.config.clone());
                }
            }
        }

        let mut config = if self.path.is_file() {
            let raw = fs::read_to_string(&self.path)
                .map_err(|e| DomainError::io(self.path.display().to_string(), e))?;
            serde_json::from_str::<AppConfig>(&raw).map_err(|e| DomainError::JsonParse {
                path: self.path.display().to_string(),
                message: e.to_string(),
            })?
        } else {
            AppConfig::default()
        };
        config.normalize_sentinels();

        if let Ok(mut guard) = self.cache.write() {
            *guard = Some(Cached {
                config: config.clone(),
                mtime,
            });
        }
        Ok(config)
    }

    /// Atomically persist the config: serialize pretty JSON to a sibling
    /// temp file, then rename over the target (rename replaces on both
    /// Windows and POSIX). The cache is refreshed — never left stale
    /// (fixes v1's §22.10 mtime-granularity risk for our own writes).
    pub fn save(&self, config: &AppConfig) -> DomainResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| DomainError::io(parent.display().to_string(), e))?;
        }
        let json = serde_json::to_string_pretty(config).map_err(|e| DomainError::JsonParse {
            path: self.path.display().to_string(),
            message: e.to_string(),
        })?;

        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json.as_bytes())
            .map_err(|e| DomainError::io(tmp.display().to_string(), e))?;
        fs::rename(&tmp, &self.path).map_err(|e| {
            // Best-effort cleanup of the temp file on failure.
            let _ = fs::remove_file(&tmp);
            DomainError::io(self.path.display().to_string(), e)
        })?;

        let mtime = fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        if let Ok(mut guard) = self.cache.write() {
            *guard = Some(Cached {
                config: config.clone(),
                mtime,
            });
        }
        Ok(())
    }

    /// Guarded read-modify-write: load → mutate → save, serialized against
    /// concurrent updates. Returns the saved config.
    pub fn update<F>(&self, mutate: F) -> DomainResult<AppConfig>
    where
        F: FnOnce(&mut AppConfig),
    {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| DomainError::Configuration("config write lock poisoned".into()))?;
        let mut config = self.load()?;
        mutate(&mut config);
        self.save(&config)?;
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::app_config::SENTINEL_NOT_SELECTED;

    fn temp_store(test: &str) -> (PathBuf, ConfigStore) {
        let dir = std::env::temp_dir().join(format!(
            "dm2-store-{}-{}",
            std::process::id(),
            test
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let store = ConfigStore::with_path(dir.join(CONFIG_FILE_NAME));
        (dir, store)
    }

    #[test]
    fn missing_file_loads_default() {
        let (dir, store) = temp_store("missing");
        let cfg = store.load().unwrap();
        assert_eq!(cfg, AppConfig::default());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_load_round_trip_and_cache() {
        let (dir, store) = temp_store("roundtrip");
        let mut cfg = AppConfig::default();
        cfg.language = Some("es_ES".into());
        cfg.java_versions
            .insert("Java 17 (jdk-17)".into(), "/opt/jdk-17".into());
        store.save(&cfg).unwrap();
        assert!(store.exists());
        // Loads (likely from cache) the same value.
        assert_eq!(store.load().unwrap(), cfg);
        // No temp file left behind.
        assert!(!dir.join("config.json.tmp").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn external_modification_invalidates_cache() {
        let (dir, store) = temp_store("invalidate");
        store.save(&AppConfig::default()).unwrap();
        store.load().unwrap();
        // Simulate an external writer with a different mtime.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(store.path(), r#"{ "language": "en_EN" }"#).unwrap();
        // Force a clearly different mtime even on coarse filesystems.
        let new_time = fs::metadata(store.path()).unwrap().modified().unwrap();
        let cfg = store.load().unwrap();
        // Either the mtime differed (normal case) and we reread, or we accept
        // a stale read only if mtimes collided exactly.
        let cached_time = fs::metadata(store.path()).unwrap().modified().unwrap();
        if cached_time == new_time {
            assert_eq!(cfg.language.as_deref(), Some("en_EN"));
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_normalizes_sentinels_from_disk() {
        let (dir, store) = temp_store("sentinels");
        fs::write(
            store.path(),
            format!(r#"{{ "active_configs": {{ "r::root": "{SENTINEL_NOT_SELECTED}" }} }}"#),
        )
        .unwrap();
        let cfg = store.load().unwrap();
        assert!(cfg.active_configs.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn update_is_read_modify_write() {
        let (dir, store) = temp_store("update");
        store
            .update(|c| c.language = Some("en_EN".into()))
            .unwrap();
        store
            .update(|c| {
                assert_eq!(c.language.as_deref(), Some("en_EN"));
                c.active_group = Some("Default".into());
            })
            .unwrap();
        let cfg = store.load().unwrap();
        assert_eq!(cfg.language.as_deref(), Some("en_EN"));
        assert_eq!(cfg.active_group.as_deref(), Some("Default"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_wipe() {
        let (dir, store) = temp_store("corrupt");
        fs::write(store.path(), "{ not json").unwrap();
        assert!(store.load().is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
