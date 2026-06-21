//! Updates & about commands (ipc-contract.md §2.9).
//!
//! Wraps `tauri-plugin-updater` so the frontend never touches the plugin
//! directly (architecture-v2.md §3.1: side effects in Rust, frontend is pure
//! UI over the typed contract), plus `get_changelog` which reads the bundled
//! `CHANGELOG.md` resource and returns the parsed structure.

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

use super::error::{AppError, CmdResult};
use crate::changelog::{self, ChangelogRelease};
use crate::events::{EventEmitter, UPDATE_PROGRESS};

/// Result of an update check (`available: false` ⇒ other fields `None`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

impl UpdateInfo {
    fn none() -> Self {
        Self { available: false, version: None, notes: None, date: None }
    }
}

fn updater_err(err: impl std::fmt::Display) -> AppError {
    AppError { kind: "updater".into(), message: err.to_string() }
}

/// §2.9 `check_for_update` — query the configured endpoint for a newer version.
/// The frontend calls this silently on startup (swallowing errors — offline /
/// first-release 404) and on the manual "Check for updates" button.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> CmdResult<UpdateInfo> {
    let updater = app.updater().map_err(updater_err)?;
    match updater.check().await.map_err(updater_err)? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }),
        None => Ok(UpdateInfo::none()),
    }
}

/// §2.9 `install_update` — download + install the available update, emitting
/// `update://progress`, then restart. Re-checks to obtain the update handle.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> CmdResult<()> {
    let updater = app.updater().map_err(updater_err)?;
    let Some(update) = updater.check().await.map_err(updater_err)? else {
        return Err(AppError {
            kind: "updater".into(),
            message: "no update available".into(),
        });
    };

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                EventEmitter::emit(
                    &progress_app,
                    UPDATE_PROGRESS,
                    serde_json::json!({
                        "downloaded": downloaded,
                        "contentLength": content_length,
                    }),
                );
            },
            || {},
        )
        .await
        .map_err(updater_err)?;

    // Diverges (`-> !`): the process is replaced by the freshly installed one.
    app.restart();
}

/// §2.9 `get_changelog` — read the bundled `CHANGELOG.md` resource and return
/// the parsed release history (newest first).
#[tauri::command]
pub async fn get_changelog(app: tauri::AppHandle) -> CmdResult<Vec<ChangelogRelease>> {
    let path = app
        .path()
        .resolve("CHANGELOG.md", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError { kind: "io".into(), message: format!("changelog path: {e}") })?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| AppError { kind: "io".into(), message: format!("read changelog: {e}") })?;
    Ok(changelog::parse(&text))
}
