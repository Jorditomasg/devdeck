//! Config commands (ipc-contract.md §2.5) — persistence through
//! `ConfigStore` (atomic write-through, no mtime gymnastics) plus the
//! one-shot v1 migration (#36, architecture-v2.md §6).
//!
//! `AppConfig` / `RepoState` / `WorkspaceGroup` keep their v1 snake_case
//! wire keys verbatim (ipc-contract.md §1.2 deliberate exceptions) — they
//! are persisted v1-compatible documents.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::State;

use super::error::CmdResult;
use crate::config::{
    self, AppConfig, MigrationReport, RepoState, WorkspaceGroup, DEFAULT_GROUP_NAME,
    SENTINEL_NOT_SELECTED,
};
use crate::state::{default_v1_candidates, AppState};

/// #23 `get_app_config` → `AppConfig` (sentinels normalized on load;
/// v1 keys accepted forever).
#[tauri::command]
pub async fn get_app_config(state: State<'_, AppState>) -> CmdResult<AppConfig> {
    Ok(state.config.load()?)
}

/// #24 `set_language { language }` — v1 codes (`en_EN`, `es_ES`) persisted.
/// Also retargets the Rust-side tray strings (state.rs `TrayStatus`).
#[tauri::command]
pub async fn set_language(state: State<'_, AppState>, language: String) -> CmdResult<()> {
    state.tray.set_language(Some(language.clone()));
    state.config.update(|c| c.language = Some(language))?;
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

/// #31 `set_active_config { configKey, name }` — `null` drops the key.
/// The v1 sentinel `"- Sin Seleccionar -"` is normalized to a drop too
/// (ipc-contract.md §2.5).
#[tauri::command]
pub async fn set_active_config(
    state: State<'_, AppState>,
    config_key: String,
    name: Option<String>,
) -> CmdResult<()> {
    let name = name.filter(|n| !n.is_empty() && n != SENTINEL_NOT_SELECTED);
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

/// #36 `migrate_from_v1 { v1Root? }` → `MigrationReport | null`.
///
/// - `v1Root` given (folder-picker fallback, architecture-v2.md §6 step 1):
///   run the migrator against that root explicitly.
/// - `v1Root` omitted: deliver the report of the probe that already ran
///   during `lib.rs` setup (taken once — later calls return `null`); when
///   no probe ran (e.g. config existed), re-probe the default candidates.
///
/// `null` = nothing to migrate / already migrated. The migrator itself is
/// idempotent — it no-ops once `config.json` exists.
#[tauri::command]
pub async fn migrate_from_v1(
    state: State<'_, AppState>,
    v1_root: Option<String>,
) -> CmdResult<Option<MigrationReport>> {
    let profiles_dest = config::default_profiles_dir()?;

    if let Some(root) = v1_root {
        return Ok(config::migrate_from_v1(
            &state.config,
            Path::new(&root),
            &profiles_dest,
        )?);
    }

    // No explicit root: hand over the setup-time probe result, if any.
    if let Ok(mut pending) = state.pending_migration.lock() {
        if let Some(report) = pending.take() {
            return Ok(Some(report));
        }
    }

    // Nothing pending — probe the default candidates (no-op when already
    // migrated; `find_v1_install` misses → nothing to migrate).
    let candidates: Vec<PathBuf> = default_v1_candidates();
    match config::find_v1_install(&candidates) {
        Some(root) => Ok(config::migrate_from_v1(&state.config, &root, &profiles_dest)?),
        None => Ok(None),
    }
}
