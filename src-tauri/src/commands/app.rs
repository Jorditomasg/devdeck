//! App lifecycle commands (ipc-contract.md §2.1 + the documented
//! "App lifecycle extensions" section).

use tauri::Manager;

use super::error::CmdResult;
use crate::state::AppState;

/// #1 `frontend_ready` — shows the (initially hidden, `"visible": false`)
/// main window after the frontend's first paint, fixing the v1 white-flash
/// hack (architecture-v2.md §7.9).
///
/// The v1-migration probe already ran during `lib.rs` setup (BEFORE the
/// frontend's initial `get_app_config`, so the handshake always reads
/// migrated data); its report is delivered by `migrate_from_v1`
/// (ipc-contract.md §2.5 #36).
#[tauri::command]
pub async fn frontend_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> CmdResult<()> {
    // Detached log windows ("log-*") run the same SPA bootstrap and call this
    // too — they are created visible, and showing/focusing the MAIN window
    // here would steal focus on every detach. Main window only.
    if window.label() != "main" {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

/// `app_exit { force }` (lifecycle extension):
/// - `force: true` → stop every supervised service
///   (`ProcessManager::shutdown_all`, the v1 atexit contract
///   inventory-backend.md §21.4), stop the poll loops and exit.
/// - `force: false` → the user cancelled the close-confirmation dialog;
///   nothing is pending Rust-side (the close was already prevented), so
///   this is a no-op acknowledgement.
#[tauri::command]
pub async fn app_exit(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    force: bool,
) -> CmdResult<()> {
    if !force {
        return Ok(());
    }
    state.process.shutdown_all().await;
    state.badge_poller.stop();
    state.docker_poller.stop();
    app.exit(0);
    Ok(())
}

/// `app_hide_to_tray {}` (lifecycle extension): hide the main window —
/// the app keeps running behind the tray icon (inventory-gui.md §25;
/// restore happens via the tray menu / icon click handled in `lib.rs`).
#[tauri::command]
pub async fn app_hide_to_tray(app: tauri::AppHandle) -> CmdResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    Ok(())
}

/// `open_log_window { serviceId, title }` (lifecycle extension): open (or
/// focus, when already open) a detached log window for one service — the v1
/// detached CTkToplevel log (inventory-gui.md §5/§8), now a real OS window.
/// The window loads the SPA with `?log=<serviceId>`; the frontend renders the
/// standalone log view, seeds from `get_log_backlog` and follows live
/// `service://log-line` events. `serviceId` may be the `__global__` aggregate.
#[tauri::command]
pub async fn open_log_window(
    app: tauri::AppHandle,
    service_id: String,
    title: String,
) -> CmdResult<()> {
    let label = log_window_label(&service_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    let url = format!(
        "index.html?log={}",
        urlencode_component(&service_id)
    );
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(900.0, 620.0)
        .min_inner_size(420.0, 280.0)
        .build()
        .map_err(|err| super::error::AppError {
            kind: "io".into(),
            message: format!("open log window: {err}"),
        })?;
    Ok(())
}

/// `get_log_backlog { serviceId }` → recent lines for a service (or the
/// `__global__` aggregate) from the Rust-side `LogCache` — seeds detached
/// log windows, which have no event history of their own.
#[tauri::command]
pub async fn get_log_backlog(
    state: tauri::State<'_, AppState>,
    service_id: String,
) -> CmdResult<Vec<String>> {
    Ok(state.logs.backlog(&service_id))
}

/// Window label for a service's detached log window.
fn log_window_label(service_id: &str) -> String {
    window_label("log", service_id)
}

/// Detached-window label `<prefix>-<safe-id>`. Tauri labels only allow
/// `a-zA-Z0-9-/:_`; ids may contain anything (e.g. `repo::module`,
/// `repo::term::1`), so non-allowed bytes are folded to `-`. Shared by the
/// log windows here and the terminal windows ([`super::terminal`]).
pub(crate) fn window_label(prefix: &str, id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("{prefix}-{safe}")
}

/// Minimal percent-encoding for a query-string value (only what service/term
/// ids need; avoids pulling a url crate for two call sites).
pub(crate) fn urlencode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_window_labels_are_tauri_safe_and_stable() {
        assert_eq!(log_window_label("api"), "log-api");
        assert_eq!(log_window_label("repo::module"), "log-repo::module");
        assert_eq!(log_window_label("__global__"), "log-__global__");
        assert_eq!(log_window_label("a b.c"), "log-a-b-c");
    }

    #[test]
    fn urlencode_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(urlencode_component("api"), "api");
        assert_eq!(urlencode_component("repo::m od"), "repo%3A%3Am%20od");
        assert_eq!(urlencode_component("__global__"), "__global__");
    }
}
