//! Application configuration persistence.
//!
//! Replaces `core/config_manager.py` (inventory-backend.md §8). Owns:
//! - `config.json` in `dirs::config_dir()/devdeck/` — the full v1
//!   schema (workspace groups, repo_state, active_configs, repo_configs,
//!   repo_config_danger, java_versions, language, minimize_to_tray, ...) with
//!   typed serde models instead of free-form dicts ([`app_config`]).
//! - Saved environments ("repo configs") with the `repo::module` config-key
//!   convention and the `repetidoN` merge-rename strategy
//!   (inventory-backend.md §8.6) ([`app_config`]).
//! - Spring YAML / Angular env / raw config-file writers
//!   (`config_writer_type`, inventory-config-ci.md §1.5) plus profile-name
//!   derivation and env auto-import (§8.6) ([`writers`]).
//! - Repo-type definition loading: bundled Tauri resources merged with user
//!   overrides (architecture-v2.md §5) ([`repo_types_loader`]).
//!
//! The config readers stay tolerant of the v1 Spanish sentinels
//! (`"- Sin Seleccionar -"` → absent, `"Sistema (Por Defecto)"` → null)
//! forever via [`app_config::AppConfig::normalize_sentinels`].
//!
//! No mtime-cache gymnastics (inventory-backend.md §8.1, §22.9-22.10): all
//! reads/writes go through [`ConfigStore`] — atomic writes, write-through
//! in-memory cache handing out clones (mtime is consulted only to detect
//! EXTERNAL edits of `config.json`, never trusted for our own writes), and
//! read-modify-write serialized under [`ConfigStore::update`].

pub mod app_config;
pub mod repo_types_loader;
pub mod store;
pub mod writers;

pub use app_config::{
    config_key, split_config_key, AppConfig, RepoConfigsMap, RepoState, WindowState,
    WorkspaceGroup, DEFAULT_GROUP_NAME, ROOT_MODULE_KEY, SENTINEL_NOT_SELECTED,
    SENTINEL_SYSTEM_DEFAULT,
};
pub use repo_types_loader::{load_repo_type_defs, sort_by_priority, user_repo_types_dir};
pub use store::{ConfigStore, APP_CONFIG_DIR_NAME, CONFIG_FILE_NAME};
pub use writers::{
    auto_import_configs, profile_name_from_file, read_config_file_raw, read_spring_config,
    spring_config_filename, write_active_environment, write_config_file_raw, write_spring_config,
};
