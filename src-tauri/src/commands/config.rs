//! Config commands (ipc-contract.md §2.5) — persistence through
//! `ConfigStore` (atomic write-through, no mtime gymnastics).
//!
//! `AppConfig` / `RepoState` / `WorkspaceGroup` keep their snake_case wire
//! keys verbatim (ipc-contract.md §1.2 deliberate exceptions) — they are
//! persisted documents.

use std::collections::BTreeMap;
use std::path::Path;

use tauri::State;

use super::error::CmdResult;
use crate::config::{self, AppConfig, RepoState, WorkspaceGroup, DEFAULT_GROUP_NAME};
use crate::state::AppState;

/// #23 `get_app_config` → `AppConfig`.
#[tauri::command]
pub async fn get_app_config(state: State<'_, AppState>) -> CmdResult<AppConfig> {
    Ok(state.config.load()?)
}

/// #24 `set_language { language }` — codes `en_EN` / `es_ES` persisted.
/// Also retargets the Rust-side tray strings (state.rs `TrayStatus`) and
/// retranslates the live tray menu/tooltip (the menu is built once at
/// startup, so it would otherwise stay in the boot language).
#[tauri::command]
pub async fn set_language(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> CmdResult<()> {
    state.tray.set_language(Some(language.clone()));
    state.config.update(|c| c.language = Some(language))?;
    crate::refresh_tray(&app, &state.tray);
    Ok(())
}

/// #25 `set_minimize_to_tray { value }`.
#[tauri::command]
pub async fn set_minimize_to_tray(state: State<'_, AppState>, value: bool) -> CmdResult<()> {
    state.config.update(|c| c.minimize_to_tray = Some(value))?;
    Ok(())
}

/// #26 `set_active_group { name }`.
#[tauri::command]
pub async fn set_active_group(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    state.config.update(|c| c.active_group = Some(name))?;
    Ok(())
}

/// #27 `save_workspace_groups { groups }` — whole-list replace.
#[tauri::command]
pub async fn save_workspace_groups(
    state: State<'_, AppState>,
    groups: Vec<WorkspaceGroup>,
) -> CmdResult<()> {
    state.config.update(|c| c.workspace_groups = groups)?;
    Ok(())
}

/// #28 `set_repo_state { repo, state }` — whole-entry replace per repo.
///
/// The wire argument `state` (the `RepoState`) coexists with the managed
/// `AppState` parameter — Tauri injects `State<T>` by type, never from args.
#[tauri::command]
pub async fn set_repo_state(
    app_state: State<'_, AppState>,
    repo: String,
    state: RepoState,
) -> CmdResult<()> {
    app_state
        .config
        .update(|c| {
            c.repo_state.insert(repo, state);
        })?;
    Ok(())
}

/// #29 `get_saved_environments { configKey }` → `Record<string, string>`.
#[tauri::command]
pub async fn get_saved_environments(
    state: State<'_, AppState>,
    config_key: String,
) -> CmdResult<BTreeMap<String, String>> {
    Ok(state.config.load()?.repo_configs_for(&config_key))
}

/// #30 `save_saved_environments { configKey, environments }` — empty map
/// removes the entry (`AppConfig::set_repo_configs_for`).
#[tauri::command]
pub async fn save_saved_environments(
    state: State<'_, AppState>,
    config_key: String,
    environments: BTreeMap<String, String>,
) -> CmdResult<()> {
    state
        .config
        .update(|c| c.set_repo_configs_for(&config_key, environments))?;
    Ok(())
}

/// `get_command_profiles { repo }` → `Record<string, string>` (name → command line).
#[tauri::command]
pub async fn get_command_profiles(
    state: State<'_, AppState>,
    repo: String,
) -> CmdResult<BTreeMap<String, String>> {
    Ok(state.config.load()?.command_profiles_for(&repo))
}

/// `save_command_profiles { repo, profiles }` — empty map removes the entry.
#[tauri::command]
pub async fn save_command_profiles(
    state: State<'_, AppState>,
    repo: String,
    profiles: BTreeMap<String, String>,
) -> CmdResult<()> {
    state
        .config
        .update(|c| c.set_command_profiles_for(&repo, profiles))?;
    Ok(())
}

/// #31 `set_active_config { configKey, name }` — `null` or `""` drops the
/// key (ipc-contract.md §2.5).
#[tauri::command]
pub async fn set_active_config(
    state: State<'_, AppState>,
    config_key: String,
    name: Option<String>,
) -> CmdResult<()> {
    let name = name.filter(|n| !n.is_empty());
    state.config.update(|c| match name {
        Some(n) => {
            c.active_configs.insert(config_key, n);
        }
        None => {
            c.active_configs.remove(&config_key);
        }
    })?;
    Ok(())
}

/// #32 `set_danger_flags { configKey, names }` — stored sorted; empty
/// removes the key (`AppConfig::set_danger_configs`).
#[tauri::command]
pub async fn set_danger_flags(
    state: State<'_, AppState>,
    config_key: String,
    names: Vec<String>,
) -> CmdResult<()> {
    state
        .config
        .update(|c| c.set_danger_configs(&config_key, names))?;
    Ok(())
}

/// #58 `set_last_profile { group: string|null, name: string|null }` —
/// persists `last_profile_by_group[group or "Default"] = name`; `name: null`
/// clears the entry (ipc-contract.md §2.5 #58). The per-group last-profile
/// memory is what the profile selector restores on group switch
/// (inventory-backend.md §8.3 `last_profile_by_group`).
#[tauri::command]
pub async fn set_last_profile(
    state: State<'_, AppState>,
    group: Option<String>,
    name: Option<String>,
) -> CmdResult<()> {
    let key = group
        .filter(|g| !g.is_empty())
        .unwrap_or_else(|| DEFAULT_GROUP_NAME.to_owned());
    state.config.update(|c| match &name {
        Some(n) => {
            c.last_profile_by_group.insert(key, n.clone());
        }
        None => {
            c.last_profile_by_group.remove(&key);
        }
    })?;
    Ok(())
}

/// #33 `read_config_file { path }` → `string` (missing file → `""`).
#[tauri::command]
pub async fn read_config_file(path: String) -> CmdResult<String> {
    Ok(config::read_config_file_raw(Path::new(&path))?)
}

/// #34 `write_config_file { path, content }` (creates parent dirs).
#[tauri::command]
pub async fn write_config_file(path: String, content: String) -> CmdResult<()> {
    config::write_config_file_raw(Path::new(&path), &content)?;
    Ok(())
}

/// #35 `apply_environment { writerType, targetFile, profile, content }` —
/// routes through `config_writer_type` (inventory-config-ci.md §1.5):
/// `spring` validates YAML and targets the profile file inside the
/// resources dir; `angular`/`raw` write verbatim.
#[tauri::command]
pub async fn apply_environment(
    writer_type: String,
    target_file: String,
    profile: String,
    content: String,
) -> CmdResult<()> {
    config::write_active_environment(&writer_type, Path::new(&target_file), &profile, &content)?;
    Ok(())
}
