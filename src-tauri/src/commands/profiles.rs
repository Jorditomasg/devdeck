//! Profile commands (ipc-contract.md §2.7).
//!
//! `group` omitted/`null` ⇒ the `Default` group (root profiles dir).
//! `ProfileDocument` / `RepoProfile` keep their v1 snake_case wire keys
//! verbatim (ipc-contract.md §1.2 — profile `.json` files are shared and
//! imported across versions).
//!
//! Ownership split for `save_profile` (§2.7 #41): the FRONTEND builds the
//! per-repo state (selection, branch, env profile, custom command, java,
//! docker); RUST owns the file snapshots — when `includeConfigFiles` it
//! enriches each repo entry via `profiles::capture_config_files` /
//! `capture_saved_environments` before writing.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use super::error::{AppError, CmdResult};
use crate::events::{EventEmitter, PROFILES_CHANGED};
use crate::profiles::{
    self, MissingRepo, ProfileDocument, RenamesByKey,
};
use crate::state::AppState;

/// Broadcast a profile-list change so every window's `ProfilesStore` re-lists
/// (the profile manager runs in its own window — see [`PROFILES_CHANGED`]).
/// `saved` carries the saved profile name (so other windows adopt it as the
/// active selection) or `None` for a delete (so the deleted profile is
/// deselected wherever it was active).
fn emit_profiles_changed(app: &tauri::AppHandle, group: Option<&str>, saved: Option<&str>) {
    app.emit(PROFILES_CHANGED, serde_json::json!({ "group": group, "saved": saved }));
}

/// Result of `apply_profile_environments` (§2.7 #46) — the `repetidoN`
/// rename report (inventory-backend.md §15.4). TS mirror:
/// `ProfileApplyReport` in `tauri.types.ts`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileApplyReport {
    /// `configKey → { originalName → storedAs }` (inventory-backend.md §8.6).
    pub renames: RenamesByKey,
}

/// #39 `list_profiles { group? }` → `string[]` (incl. the
/// empty-custom-group root fallback, inventory-backend.md §22.12).
#[tauri::command]
pub async fn list_profiles(
    state: State<'_, AppState>,
    group: Option<String>,
) -> CmdResult<Vec<String>> {
    Ok(state.profiles.list_profiles(group.as_deref()))
}

/// #40 `load_profile { name, group? }` → `ProfileDocument | null`
/// (broken files ⇒ `null`, v1 parity).
#[tauri::command]
pub async fn load_profile(
    state: State<'_, AppState>,
    name: String,
    group: Option<String>,
) -> CmdResult<Option<ProfileDocument>> {
    Ok(state.profiles.load_profile(&name, group.as_deref()))
}

/// #41 `save_profile { name, group?, doc, includeConfigFiles }` → `string`
/// (the saved file path).
///
/// When `includeConfigFiles`, each repo entry present in the LAST SCAN is
/// enriched with `config_files` (raw env-file contents) and
/// `saved_environments` (the repo's saved environments from config) —
/// repos missing from the scan are written as the frontend sent them.
#[tauri::command]
pub async fn save_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    group: Option<String>,
    mut doc: ProfileDocument,
    include_config_files: bool,
) -> CmdResult<String> {
    if include_config_files {
        let repos = state.repos_snapshot();
        let config = state.config.load()?;
        // The snapshot reads every env file of every repo — chunky sync fs,
        // moved off the async runtime (architecture-v2.md §2: never block
        // the command executor on bulk IO).
        doc = tauri::async_runtime::spawn_blocking(move || {
            for (repo_name, entry) in doc.repos.iter_mut() {
                let Some(repo) = repos.iter().find(|r| &r.name == repo_name) else {
                    continue;
                };
                let repo_path = Path::new(&repo.path);
                entry.config_files = Some(profiles::capture_config_files(
                    repo_path,
                    &repo.environment_files,
                ));
                entry.saved_environments = Some(profiles::capture_saved_environments(
                    &config,
                    repo_name,
                    repo_path,
                    &repo.environment_files,
                ));
            }
            doc
        })
        .await
        .map_err(|err| AppError::profile(format!("config-file snapshot task failed: {err}")))?;
    }
    let path = state
        .profiles
        .save_profile(&name, group.as_deref(), &mut doc)?;
    emit_profiles_changed(&app, group.as_deref(), Some(&name));
    Ok(path.display().to_string())
}

/// #42 `delete_profile { name, group? }` → `boolean`.
#[tauri::command]
pub async fn delete_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    group: Option<String>,
) -> CmdResult<bool> {
    let deleted = state.profiles.delete_profile(&name, group.as_deref());
    if deleted {
        emit_profiles_changed(&app, group.as_deref(), None);
    }
    Ok(deleted)
}

/// #43 `export_profile { doc, destPath }` → `void`.
#[tauri::command]
pub async fn export_profile(doc: ProfileDocument, dest_path: String) -> CmdResult<()> {
    profiles::export_profile_to_file(&doc, Path::new(&dest_path))?;
    Ok(())
}

/// #44 `import_profile { srcPath }` → `ProfileDocument` — rejects files
/// without a `repos` key (`kind: "profile"`, v1 parity).
#[tauri::command]
pub async fn import_profile(src_path: String) -> CmdResult<ProfileDocument> {
    Ok(profiles::import_profile_from_file(Path::new(&src_path))?)
}

/// #45 `get_missing_repos { workspaceDir, doc }` → `MissingRepo[]`
/// (clone-missing planning; branch defaults to `main`).
#[tauri::command]
pub async fn get_missing_repos(
    workspace_dir: String,
    doc: ProfileDocument,
) -> CmdResult<Vec<MissingRepo>> {
    Ok(profiles::get_missing_repos(Path::new(&workspace_dir), &doc))
}

/// #46 `apply_profile_environments { doc, workspaceDir }` →
/// `ProfileApplyReport`.
///
/// Pipeline (inventory-backend.md §15.4, contract backing):
/// 1. `profiles::apply_config_files` — overwrite env files on disk from
///    each repo's `config_files` snapshot (per-file errors swallowed, v1).
/// 2. `profiles::apply_saved_environments` — merge each repo's
///    `saved_environments` into `repo_configs` with the `repetidoN` rename
///    strategy, inside one atomic `ConfigStore::update`.
/// 3. `profiles::update_active_configs_for_renames` — repoint
///    `active_configs` entries whose selected name was renamed.
///
/// Returns the renames so the UI can report them.
#[tauri::command]
pub async fn apply_profile_environments(
    state: State<'_, AppState>,
    doc: ProfileDocument,
    workspace_dir: String,
) -> CmdResult<ProfileApplyReport> {
    let workspace = PathBuf::from(workspace_dir);

    // 1. Disk writes (outside the config lock — they don't touch config).
    //    Bulk env-file overwrites are chunky sync fs — off the async runtime.
    //    Resolve each repo's real path from the last scan (names may be
    //    disambiguated basenames and roots may be multiple); the v1
    //    `workspace/<name>` join stays as fallback for unscanned repos.
    let repos = state.repos_snapshot();
    let doc = tauri::async_runtime::spawn_blocking(move || {
        for (repo_name, entry) in &doc.repos {
            if let Some(config_files) = &entry.config_files {
                let repo_path = repos
                    .iter()
                    .find(|r| &r.name == repo_name)
                    .map(|r| PathBuf::from(&r.path))
                    .unwrap_or_else(|| workspace.join(repo_name));
                profiles::apply_config_files(&repo_path, config_files);
            }
        }
        doc
    })
    .await
    .map_err(|err| AppError::profile(format!("config-file apply task failed: {err}")))?;

    // 2 + 3. Config merge + active-config repointing, atomically.
    let mut all_renames = RenamesByKey::new();
    state.config.update(|config| {
        for (repo_name, entry) in &doc.repos {
            if let Some(saved) = &entry.saved_environments {
                let renames = profiles::apply_saved_environments(config, repo_name, saved);
                all_renames.extend(renames);
            }
        }
        profiles::update_active_configs_for_renames(config, &all_renames);
    })?;

    Ok(ProfileApplyReport { renames: all_renames })
}
