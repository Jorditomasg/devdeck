//! Workspace profiles — JSON snapshots of the whole workspace state.
//!
//! Replaces `core/profile_manager.py` (inventory-backend.md §15). Storage
//! moves to `dirs::data_dir()/devdeck/profiles/` (architecture-v2.md
//! §6-7) keeping the v1 layout: root dir for the Default group, sanitized
//! subdirectory per custom group, one `<name>.json` per profile, and the
//! "custom group with no profiles lists the root" compatibility fallback.
//!
//! Owns:
//! - Profile document build/apply per the §15.3 schema (git_url, branch,
//!   env profile, custom_command, java_version, selection, docker state,
//!   optional config_files + saved_environments snapshots).
//! - Import/export as plain JSON (`repos` key required), missing-repo clone
//!   planning, saved-environment merge with `repetidoN` renames and
//!   `active_configs` repointing (§15.4, §8.6).
//! - Full read-compatibility with v1 profile files, including the
//!   `"Sistema (Por Defecto)"` java sentinel.
//!
//! Layout: [`types`] (the §15.3 document model), [`store`] (CRUD +
//! import/export), [`capture`] (config-file/saved-env snapshots on save),
//! [`apply`] (missing-repo planning + the §15.4 merge semantics, mutating an
//! in-memory `AppConfig` that the commands layer persists atomically).

pub mod apply;
pub mod capture;
pub mod store;
pub mod types;

pub use apply::{
    apply_config_files, apply_config_files_to_repo_configs, apply_saved_environments,
    derive_profile_name_from_filename, get_missing_repos, update_active_configs_for_renames,
};
pub use capture::{capture_config_files, capture_saved_environments};
pub use store::{
    export_profile_to_file, import_profile_from_file, sanitize_group_name, ProfileStore,
    DEFAULT_GROUP, PROFILE_EXT,
};
pub use types::{
    ConfigFilesMap, MissingRepo, ProfileDocument, ProfileError, RenamesByKey, RepoProfile,
    SavedEnvironmentsMap,
};
