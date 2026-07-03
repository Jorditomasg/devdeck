//! Application configuration persistence. Owns:
//! - `config.json` in `dirs::config_dir()/devdeck/` — workspace groups,
//!   repo_state, active_configs, repo_configs, repo_config_danger,
//!   java_versions, language, minimize_to_tray, ... as typed serde models
//!   ([`app_config`]).
//! - Saved environments ("repo configs") with the `repo::module` config-key
//!   convention and the `repetidoN` merge-rename strategy ([`app_config`]).
//! - Spring YAML / Angular env / raw config-file writers
//!   (`config_writer_type`) plus profile-name derivation and env auto-import
//!   ([`writers`]).
//! - Repo-type definition loading: bundled Tauri resources merged with user
//!   overrides ([`repo_types_loader`]).
//!
//! All reads/writes go through [`ConfigStore`] — atomic writes, write-through
//! in-memory cache handing out clones (mtime is consulted only to detect
//! EXTERNAL edits of `config.json`, never trusted for our own writes), and
//! read-modify-write serialized under [`ConfigStore::update`].

pub mod app_config;
pub mod repo_types_loader;
pub mod store;
pub mod writers;

pub use app_config::{
    config_key, split_config_key, AppConfig, RepoConfigsMap, RepoState, WindowState,
    WorkspaceGroup, DEFAULT_GROUP_NAME, ROOT_MODULE_KEY,
};
pub use repo_types_loader::{load_repo_type_defs, sort_by_priority, user_repo_types_dir};
pub use store::{ConfigStore, APP_CONFIG_DIR_NAME, CONFIG_FILE_NAME};
pub use writers::{
    auto_import_configs, profile_name_from_file, read_config_file_raw, read_spring_config,
    spring_config_filename, write_active_environment, write_config_file_raw, write_spring_config,
};
