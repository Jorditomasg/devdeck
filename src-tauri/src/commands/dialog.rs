//! Native dialog-window commands (docs/migration/dialogs-as-windows.md).
//!
//! Every in-app modal is migrating to a real OS window. The opener calls
//! `open_dialog_window`; the dialog window fetches its inputs with
//! `get_dialog_args` and returns its outcome with `resolve_dialog`, which
//! emits `dialog://resolved { token, result }` and closes the window
//! Rust-side. The dialog webview holds NO `core:window:*` permissions — the
//! same rule the terminal/log windows follow — so closing is always done here.

use tauri::Manager;

use super::app::urlencode_component;
use super::error::{AppError, CmdResult};
use crate::events::{EventEmitter, DIALOG_RESOLVED};
use crate::state::AppState;

/// Fixed (non-resizable) inner size per dialog kind, in logical pixels.
/// Sole source of truth for dialog window size (the panel fills the window;
/// `ui-dialog-shell` no longer carries a width). Height is fixed because the
/// windows do not resize (design: not resizable). Unknown kinds fall back to a
/// sensible medium size.
fn dialog_size(kind: &str) -> (f64, f64) {
    match kind {
        "messagebox" => (460.0, 220.0),
        "prompt" => (460.0, 240.0),
        "confirm-close" => (460.0, 260.0),
        "clone" => (560.0, 360.0),
        "branch" => (680.0, 560.0),
        "stash" => (620.0, 560.0),
        "merge-branch" => (600.0, 600.0),
        "settings" => (640.0, 620.0),
        "java-manager" => (560.0, 520.0),
        "java-editor" => (520.0, 320.0),
        "changelog" => (640.0, 640.0),
        "docker-compose" => (640.0, 600.0),
        "config-editor" => (720.0, 600.0),
        "repo-config-manager" => (680.0, 560.0),
        "workspace-groups" => (560.0, 520.0),
        "profile-manager" => (680.0, 600.0),
        "import-options" => (640.0, 560.0),
        _ => (560.0, 480.0),
    }
}

/// `open_dialog_window { kind, title, args, parentLabel? } -> token`.
/// Allocates the `dlg-<kind>-<n>` window label (= result token), stores `args`,
/// and creates the non-resizable webview loading `?dialog=<kind>&token=<t>`,
/// parented + centered on `parentLabel` when given. The opener then awaits
/// `dialog://resolved` for the returned token.
#[tauri::command]
pub async fn open_dialog_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    kind: String,
    title: String,
    args: serde_json::Value,
    parent_label: Option<String>,
) -> CmdResult<String> {
    // Singleton per (kind, args): a repeat open just focuses the live window
    // and returns its token, so the opener's awaiting promise still settles
    // when that one window resolves. Prevents stacking duplicate dialogs.
    if let Some(token) = state.dialogs.existing(&kind, &args) {
        if let Some(window) = app.get_webview_window(&token) {
            let _ = window.set_focus();
            return Ok(token);
        }
    }
    let token = state.dialogs.allocate(&kind, args);
    let (width, height) = dialog_size(&kind);
    let url = format!(
        "index.html?dialog={}&token={}",
        urlencode_component(&kind),
        urlencode_component(&token),
    );
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &token, tauri::WebviewUrl::App(url.into()))
            .title(&title)
            .inner_size(width, height)
            .resizable(false)
            .center();
    if let Some(parent) = parent_label.as_deref() {
        if let Some(parent_window) = app.get_webview_window(parent) {
            builder = builder.parent(&parent_window).map_err(|err| AppError {
                kind: "io".into(),
                message: format!("set dialog parent: {err}"),
            })?;
        }
    }
    builder.build().map_err(|err| AppError {
        kind: "io".into(),
        message: format!("open dialog window: {err}"),
    })?;
    Ok(token)
}

/// `get_dialog_args { token } -> args` — the JSON inputs a dialog window was
/// opened with (`null` if the slot is gone, e.g. already resolved).
#[tauri::command]
pub async fn get_dialog_args(
    state: tauri::State<'_, AppState>,
    token: String,
) -> CmdResult<serde_json::Value> {
    Ok(state.dialogs.args(&token).unwrap_or(serde_json::Value::Null))
}

/// `resolve_dialog { token, result }` — record the outcome, emit
/// `dialog://resolved { token, result }` (once), and close the window. Pass
/// `result: null` to cancel; the opener applies its registered fallback.
#[tauri::command]
pub async fn resolve_dialog(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
    result: serde_json::Value,
) -> CmdResult<()> {
    if state.dialogs.take(&token) {
        EventEmitter::emit(
            &app,
            DIALOG_RESOLVED,
            serde_json::json!({ "token": token, "result": result }),
        );
    }
    if let Some(window) = app.get_webview_window(&token) {
        let _ = window.destroy();
    }
    Ok(())
}
