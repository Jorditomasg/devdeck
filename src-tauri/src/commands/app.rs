//! App lifecycle commands (ipc-contract.md §2.1 + the documented
//! "App lifecycle extensions" section).

use tauri::Manager;

use super::error::CmdResult;
use crate::state::AppState;

/// #1 `frontend_ready` — shows the (initially hidden, `"visible": false`)
/// main window after the frontend's first paint, fixing the v1 white-flash
/// hack (architecture-v2.md §7.9).
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

/// `show_main_window {}` (tray-panel "Open DevDeck"): restore + focus the main
/// window and hide the tray quick-control panel. Mirrors the tray icon's
/// restore behavior but exposed to the panel webview (which holds no
/// `core:window:*` perms, so it cannot show/hide windows itself).
#[tauri::command]
pub async fn show_main_window(app: tauri::AppHandle) -> CmdResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if let Some(panel) = app.get_webview_window("tray-panel") {
        let _ = panel.hide();
    }
    Ok(())
}

/// `request_quit {}` (tray-panel "Close DevDeck"): routes through the same
/// confirm-running flow as the tray Quit menu — with active services it
/// restores the main window and emits `app://close-requested` (the frontend
/// shows the confirm dialog and answers via `app_exit { force }`); otherwise it
/// exits. Showing the main window steals focus, so the panel auto-hides.
#[tauri::command]
pub async fn request_quit(app: tauri::AppHandle) -> CmdResult<()> {
    crate::request_quit(&app);
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
    // Build hidden so we can stamp the taskbar style BEFORE the first show —
    // Windows only registers the taskbar button on show, so toggling the style
    // afterwards would not take until the next hide/show cycle.
    let window =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
            .title(&title)
            .inner_size(900.0, 620.0)
            .min_inner_size(420.0, 280.0)
            .visible(false)
            .build()
            .map_err(|err| super::error::AppError {
                kind: "io".into(),
                message: format!("open log window: {err}"),
            })?;
    #[cfg(windows)]
    force_taskbar_button(&window);
    center_on_cursor_monitor(&app, &window);
    let _ = window.show();
    Ok(())
}

/// `set_window_always_on_top { onTop }` — pin/unpin the CALLING window so it
/// stays above other windows. Used by the detached log (`log-*`) and terminal
/// (`term-*`) windows' "always on top" toggle. Runs Rust-side because the
/// webview holds NO `core:window:*` permissions (capabilities/default.json):
/// all window manipulation lives here. State is per-window and not persisted —
/// reopening a window starts unpinned.
#[tauri::command]
pub async fn set_window_always_on_top(
    window: tauri::WebviewWindow,
    on_top: bool,
) -> CmdResult<()> {
    window
        .set_always_on_top(on_top)
        .map_err(|err| super::error::AppError {
            kind: "io".into(),
            message: format!("set always on top: {err}"),
        })?;
    Ok(())
}

/// `open_git_window { repoId, title, branch?, tab?, stash? }` (git suite,
/// design doc 2026-07-02): open (or focus, when already open) the detached
/// git window of one repo. The window loads the SPA with `?git=<repoId>`
/// plus the optional view params — `branch` preselects the branch filter
/// (branch-dialog entry), `tab: "stashes"`/`stash` open the stash viewer
/// (stash-dialog entry), `tab: "changes"` the working-tree changes window
/// (changes-badge entry, design doc 2026-07-03). Each MODE gets its own
/// label (`git-`, `git-stashes-`, `git-changes-`; all match the `git-*`
/// capability/handler patterns) so focusing one never hijacks another. An
/// already-open window of the same mode is only focused; it does NOT
/// re-navigate (accepted limitation, phase-2 decisions).
#[tauri::command]
pub async fn open_git_window(
    app: tauri::AppHandle,
    repo_id: String,
    title: String,
    branch: Option<String>,
    tab: Option<String>,
    stash: Option<u32>,
) -> CmdResult<()> {
    let prefix = match tab.as_deref() {
        Some("stashes") => "git-stashes",
        Some("changes") => "git-changes",
        _ => "git",
    };
    let label = window_label(prefix, &repo_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    let mut url = format!("index.html?git={}", urlencode_component(&repo_id));
    if let Some(branch) = branch.as_deref().filter(|b| !b.is_empty()) {
        url.push_str(&format!("&branch={}", urlencode_component(branch)));
    }
    if let Some(tab) = tab.as_deref().filter(|t| !t.is_empty()) {
        url.push_str(&format!("&tab={}", urlencode_component(tab)));
    }
    if let Some(stash) = stash {
        url.push_str(&format!("&stash={stash}"));
    }
    // Hidden-then-show for the same taskbar-style reason as open_log_window.
    let window =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
            .title(&title)
            .inner_size(1150.0, 760.0)
            .min_inner_size(720.0, 480.0)
            .visible(false)
            .build()
            .map_err(|err| super::error::AppError {
                kind: "io".into(),
                message: format!("open git window: {err}"),
            })?;
    #[cfg(windows)]
    force_taskbar_button(&window);
    center_on_cursor_monitor(&app, &window);
    let _ = window.show();
    Ok(())
}

/// Force `WS_EX_APPWINDOW` on a window so it owns a taskbar button and minimizes
/// to the taskbar. Without it tao's runtime-created secondary windows lack the
/// style and Windows minimizes them to the legacy bottom-left desktop stub
/// (tauri#10422). Must run while the window is still hidden (see caller).
#[cfg(windows)]
fn force_taskbar_button(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    if let Ok(hwnd) = window.hwnd() {
        // ponytail: raw Win32 because Tauri's set_skip_taskbar(false) clears
        // WS_EX_TOOLWINDOW but never adds WS_EX_APPWINDOW, which is the bit that
        // actually puts the window on the taskbar.
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let ex = (ex & !(WS_EX_TOOLWINDOW.0 as isize)) | (WS_EX_APPWINDOW.0 as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
        }
    }
}

/// Center a (still hidden) secondary window on the monitor under the cursor —
/// i.e. the screen where the user just clicked the button that opened it.
/// Best-effort: any failure (no cursor, headless, unresolved monitor) keeps
/// the placement the window already has. Shared by the log/git windows here,
/// the terminal windows ([`super::terminal`]) and the dialogs
/// ([`super::dialog`]).
pub(crate) fn center_on_cursor_monitor(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Some(monitor) = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
    else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    // ponytail: physical-pixel math; on mixed-DPI Windows rescales after the
    // move so the window can land slightly off-center — accepted in the
    // design doc, a second re-center pass is not worth it.
    let (x, y) = centered_origin(
        (monitor.position().x, monitor.position().y),
        (monitor.size().width, monitor.size().height),
        (size.width, size.height),
    );
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Origin that centers a `window`-sized rect inside a monitor rect, clamped
/// to the monitor origin when the window is larger than the monitor.
fn centered_origin(
    monitor_pos: (i32, i32),
    monitor_size: (u32, u32),
    window_size: (u32, u32),
) -> (i32, i32) {
    let x = monitor_pos.0 + ((monitor_size.0 as i32 - window_size.0 as i32) / 2).max(0);
    let y = monitor_pos.1 + ((monitor_size.1 as i32 - window_size.1 as i32) / 2).max(0);
    (x, y)
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
    fn centered_origin_centers_and_clamps() {
        // Secondary monitor to the left of the primary (negative origin).
        assert_eq!(
            centered_origin((-1920, 0), (1920, 1080), (900, 620)),
            (-1410, 230)
        );
        // Window larger than the monitor → clamp to the monitor origin.
        assert_eq!(centered_origin((0, 0), (800, 600), (1150, 760)), (0, 0));
    }

    #[test]
    fn urlencode_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(urlencode_component("api"), "api");
        assert_eq!(urlencode_component("repo::m od"), "repo%3A%3Am%20od");
        assert_eq!(urlencode_component("__global__"), "__global__");
    }
}
