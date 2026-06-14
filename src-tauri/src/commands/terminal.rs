//! Interactive terminal commands (design doc 2026-06-14) — PTY-backed shells,
//! one detached OS window each, isolated from the supervised-service commands
//! in [`super::process`].
//!
//! Flow: the main window calls `open_terminal_window` (creates a `term-<id>`
//! webview + spawns the PTY); that webview, on init, calls `attach_terminal`
//! to hand over its output `Channel`, then drives `terminal_write` /
//! `terminal_resize`, and `close_terminal` when it closes.

use tauri::ipc::{Channel, InvokeResponseBody};

use super::app::{urlencode_component, window_label};
use super::error::{AppError, CmdResult};
use crate::state::AppState;
use crate::terminal::shell::default_shell;

/// PTY size before the webview's first fit/resize (corrected immediately after
/// `attach_terminal` by a `terminal_resize`).
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// `open_terminal_window { repoId, cwd, title }` → allocate a terminal id,
/// spawn a PTY shell rooted at `cwd`, and open (focusing if it somehow already
/// exists) a detached `term-<id>` window loading `?terminal=<id>`. Returns the
/// new terminal id. Mirrors `open_log_window`.
#[tauri::command]
pub async fn open_terminal_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo_id: String,
    cwd: String,
    title: String,
) -> CmdResult<String> {
    let id = state.terminals.next_id(&repo_id);
    let shell = default_shell();
    state.terminals.open(
        &id,
        &shell,
        std::path::Path::new(&cwd),
        DEFAULT_COLS,
        DEFAULT_ROWS,
    )?;

    let label = window_label("term", &id);
    let url = format!("index.html?terminal={}", urlencode_component(&id));
    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(900.0, 560.0)
        .min_inner_size(420.0, 240.0)
        .build()
        .map_err(|err| AppError {
            kind: "io".into(),
            message: format!("open terminal window: {err}"),
        })?;
    Ok(id)
}

/// `attach_terminal { id, channel }` → bind the webview's output channel:
/// flush the pre-attach buffer, then stream live raw PTY bytes.
#[tauri::command]
pub async fn attach_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    channel: Channel<InvokeResponseBody>,
) -> CmdResult<()> {
    state.terminals.attach(&id, channel)?;
    Ok(())
}

/// `terminal_write { id, data }` → forward keystrokes to the PTY input.
/// `data` is the string `xterm.onData` produces (key presses, pasted text,
/// control sequences); written as UTF-8 bytes.
#[tauri::command]
pub async fn terminal_write(
    state: tauri::State<'_, AppState>,
    id: String,
    data: String,
) -> CmdResult<()> {
    state.terminals.write(&id, data.as_bytes())?;
    Ok(())
}

/// `terminal_resize { id, cols, rows }` → resize the PTY viewport (SIGWINCH).
#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state.terminals.resize(&id, cols, rows)?;
    Ok(())
}

/// `close_terminal { id }` → force-kill the PTY process tree and drop the
/// session. Invoked by the terminal window as it closes; no confirmation
/// (design decision: closing a terminal window kills its shell).
#[tauri::command]
pub async fn close_terminal(state: tauri::State<'_, AppState>, id: String) -> CmdResult<()> {
    state.terminals.close(&id).await;
    Ok(())
}
