//! DevDeck — Rust core.
//!
//! Composition root: registers plugins, managed state, the tray icon and
//! every command handler (ipc-contract.md §2 — 61 commands: 55 core + the
//! 2 app-lifecycle extensions + `set_last_profile` #58 / `is_installed`
//! #59 / `get_command_profiles` #60 / `save_command_profiles` #61). Module
//! responsibilities are documented in
//! each module's `//!` header; the overall layering contract lives in
//! `docs/migration/architecture-v2.md` §4 (commands → adapters → domain).
//!
//! Lifecycle wiring implemented here:
//! - single-instance plugin FIRST: second launch focuses the existing
//!   window and forwards its argv via `app://single-instance`
//!   (architecture-v2.md §7.6);
//! - close-requested interception: while services run, the close is
//!   prevented and `app://close-requested` is emitted so the frontend can
//!   show the confirm dialog and answer with `app_exit { force }`
//!   (inventory-gui.md §17);
//! - tray icon with show/hide toggle + quit and a localized
//!   "running/total" tooltip kept fresh by the wrapping event emitter
//!   (inventory-gui.md §25);
//! - `RunEvent::Exit` → `ProcessManager::shutdown_all` + poller shutdown
//!   (the v1 atexit contract, inventory-backend.md §21.4).

pub mod changelog;
pub mod commands;
pub mod config;
pub mod detection;
pub mod docker;
pub mod domain;
pub mod events;
pub mod git;
pub mod java;
pub mod process;
pub mod profiles;
pub mod state;
pub mod terminal;

use std::sync::Arc;

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WindowEvent};

use crate::domain::ServiceStatus;
use crate::events::{EventEmitter, APP_CLOSE_REQUESTED, DIALOG_RESOLVED, SERVICE_STATUS_CHANGED};
use crate::state::{AppState, TrayStatus};

/// Label of the (single) main window — `tauri.conf.json` `app.windows[0]`.
const MAIN_WINDOW: &str = "main";

/// Tray icon id (`Manager::tray_by_id` lookups from the tooltip refresher).
const TRAY_ID: &str = "main-tray";

/// Label of the custom tray quick-control popup window (loaded with
/// `?panel=1`; created lazily on the first tray left-click).
const TRAY_PANEL_WINDOW: &str = "tray-panel";


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance must be the FIRST registered plugin so the takeover
    // check runs before any other initialization. Replaces v1's loopback
    // PING/PONG registry (inventory-backend.md §12, architecture-v2.md §7.6).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                show_window(&window);
            }
            // Forward the second launch's argv so the running instance can
            // switch/open the requested workspace group (events.rs).
            match serde_json::to_value(events::SingleInstancePayload { argv, cwd }) {
                Ok(payload) => EventEmitter::emit(app, events::APP_SINGLE_INSTANCE, payload),
                Err(err) => log::error!("failed to serialize single-instance payload: {err}"),
            }
        }));
    }

    builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(setup)
        .on_window_event(|window, event| {
            // Detached terminal windows ("term-*") own a PTY. When the OS
            // closes one, reap its shell HERE (Rust-side) and let the native
            // close proceed. We must NOT rely on the webview's JS
            // `onCloseRequested`: its wrapper calls `window.destroy()` when the
            // handler doesn't preventDefault, but the term-* capability grants
            // no `core:window:*` permissions, so that call is denied and the
            // window would never actually close.
            if let Some(id) = window.label().strip_prefix("term-") {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    let app = window.app_handle().clone();
                    let id = id.to_string();
                    tauri::async_runtime::spawn(async move {
                        app.state::<AppState>().terminals.close(&id).await;
                    });
                }
                return;
            }
            // Native dialog windows ("dlg-*"): if the OS closes one before it
            // resolved (the user hit ✕), emit a cancel so the opener's awaiting
            // promise settles with its fallback. `take()` is false when
            // `resolve_dialog` already consumed the slot (it triggers the close
            // itself), so there is no double emit. Closing is native — the
            // webview holds no `core:window:*` perms by design.
            if window.label().starts_with("dlg-") {
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    let app = window.app_handle();
                    let token = window.label().to_string();
                    if app.state::<AppState>().dialogs.take(&token) {
                        EventEmitter::emit(
                            app,
                            DIALOG_RESOLVED,
                            serde_json::json!({ "token": token, "result": serde_json::Value::Null }),
                        );
                    }
                }
                return;
            }
            // Custom tray panel ("tray-panel"): a frameless popup that hides
            // itself when it loses focus (click-away), the standard tray-popup
            // UX. Closing/minimizing otherwise behave like a plain window.
            if window.label() == TRAY_PANEL_WINDOW {
                if let WindowEvent::Focused(false) = event {
                    // Ignore the transient blur right after a show (the popup
                    // is still settling) — otherwise it self-closes on open.
                    if !tray_panel_show_is_recent() {
                        let _ = window.hide();
                    }
                }
                return;
            }
            // Main-window-only behaviors: detached log windows ("log-*")
            // close and minimize like plain windows.
            if window.label() != "main" {
                return;
            }
            match event {
                // Close interception (inventory-gui.md §17): prevent the close
                // while services run OR any PTY terminal is open; the frontend
                // shows the confirm dialog and answers with `app_exit { force }`.
                WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    let state = app.state::<AppState>();
                    if state.tray.any_active() || state.terminals.any_open() {
                        api.prevent_close();
                        EventEmitter::emit(app, APP_CLOSE_REQUESTED, serde_json::json!({}));
                    } else if state
                        .config
                        .load()
                        .map(|c| c.minimize_to_tray_or_default())
                        .unwrap_or(true)
                    {
                        // Close-to-tray: HIDE instead of destroying the window so
                        // the tray ("Open DevDeck" / double-click) can restore it.
                        // Destroying it would strand the app — the precreated
                        // hidden tray-panel window keeps the process alive, but
                        // `get_webview_window("main")` would then return None and
                        // every reopen path would silently no-op.
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    // Close-to-tray OFF: let the close proceed and exit, so we
                    // don't leave an unreachable tray zombie. `RunEvent::Exit`
                    // does the service/terminal cleanup.
                    else {
                        app.exit(0);
                    }
                }
                // Minimize-to-tray (inventory-gui.md §17, config key
                // `minimize_to_tray`, v1 default true): tao reports a minimize
                // as a Resized event, so probe `is_minimized()` and hide —
                // hiding removes the taskbar entry; the tray icon restores via
                // `show_window` (which unminimizes first).
                WindowEvent::Resized(_) => {
                    if window.is_minimized().unwrap_or(false) {
                        let app = window.app_handle();
                        let to_tray = app
                            .state::<AppState>()
                            .config
                            .load()
                            .map(|c| c.minimize_to_tray_or_default())
                            .unwrap_or(true);
                        if to_tray {
                            let _ = window.hide();
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // §2.1 app lifecycle (+ documented extensions)
            commands::app::frontend_ready,
            commands::app::app_exit,
            commands::app::app_hide_to_tray,
            commands::app::show_main_window,
            commands::app::request_quit,
            commands::app::open_log_window,
            commands::app::get_log_backlog,
            commands::app::open_git_window,
            // interactive terminals (design doc 2026-06-14)
            commands::terminal::open_terminal_window,
            commands::terminal::attach_terminal,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::close_terminal,
            commands::terminal::list_shells,
            commands::terminal::set_terminal_shell,
            // native dialog windows (docs/migration/dialogs-as-windows.md)
            commands::dialog::open_dialog_window,
            commands::dialog::get_dialog_args,
            commands::dialog::resolve_dialog,
            // §2.2 detection
            commands::detection::scan_workspace,
            commands::detection::list_repos,
            // §2.3 process supervision
            commands::process::start_service,
            commands::process::stop_service,
            commands::process::restart_service,
            commands::process::install_dependencies,
            commands::process::list_services,
            commands::process::stop_all_services,
            commands::process::is_installed,
            // §2.4 git
            commands::git::git_status_summary,
            commands::git::git_branches,
            commands::git::git_current_branch,
            commands::git::git_checkout,
            commands::git::git_pull,
            commands::git::git_fetch,
            commands::git::git_clone,
            commands::git::git_clean,
            commands::git::git_local_changes,
            commands::git::git_has_branch,
            commands::git::git_capture_revert_point,
            commands::git::git_merge,
            commands::git::git_revert_merge,
            commands::git::git_refresh_badge,
            // §2.4 git — stash management
            commands::git::git_stash_list,
            commands::git::git_stash_push,
            commands::git::git_stash_apply,
            commands::git::git_stash_pop,
            commands::git::git_stash_drop,
            // §2.4 git — branch management
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_delete_remote_branch,
            commands::git::git_rename_branch,
            commands::git::git_publish_branch,
            // §2.4 git — history queries (git suite phase 1)
            commands::git::git_log,
            commands::git::git_commit_files,
            commands::git::git_commit_file_diff,
            commands::git::git_file_at_commit,
            commands::git::git_working_diff,
            commands::git::git_authors,
            commands::git::git_diff_range,
            commands::git::git_diff_range_file,
            commands::git::git_ls_files,
            commands::git::git_commit_body,
            commands::git::git_tags,
            // §2.5 config
            commands::config::get_app_config,
            commands::config::set_language,
            commands::config::set_minimize_to_tray,
            commands::config::set_active_group,
            commands::config::save_workspace_groups,
            commands::config::set_repo_state,
            commands::config::get_saved_environments,
            commands::config::save_saved_environments,
            commands::config::get_command_profiles,
            commands::config::save_command_profiles,
            commands::config::set_active_config,
            commands::config::set_danger_flags,
            commands::config::set_last_profile,
            commands::config::read_config_file,
            commands::config::write_config_file,
            commands::config::apply_environment,
            // §2.6 java
            commands::java::detect_jdks,
            commands::java::save_java_versions,
            // §2.7 profiles
            commands::profiles::list_profiles,
            commands::profiles::load_profile,
            commands::profiles::save_profile,
            commands::profiles::delete_profile,
            commands::profiles::export_profile,
            commands::profiles::import_profile,
            commands::profiles::get_missing_repos,
            commands::profiles::apply_profile_environments,
            // §2.8 docker
            commands::docker::docker_available,
            commands::docker::docker_compose_services,
            commands::docker::docker_compose_up,
            commands::docker::docker_compose_stop,
            commands::docker::docker_compose_down,
            commands::docker::docker_compose_status,
            commands::docker::docker_compose_logs,
            commands::docker::docker_refresh_status,
            // §2.9 updates & about
            commands::updates::check_for_update,
            commands::updates::install_update,
            commands::updates::get_changelog,
            commands::updates::whats_new_on_startup,
            commands::updates::disable_whats_new,
        ])
        .build(tauri::generate_context!())
        .expect("error while building DevDeck")
        .run(|app_handle, event| {
            // The v1 atexit contract (inventory-backend.md §21.4): stop every
            // supervised service and the poll loops on the way out. Also runs
            // after `app_exit { force: true }` — `shutdown_all` is idempotent.
            if let RunEvent::Exit = event {
                let state = app_handle.state::<AppState>();
                state.badge_poller.stop();
                state.docker_poller.stop();
                tauri::async_runtime::block_on(state.process.shutdown_all());
                // Kill any open PTY terminals too (they are not supervised
                // services, so `shutdown_all` does not cover them).
                tauri::async_runtime::block_on(state.terminals.close_all());
            }
        });
}

/// Builder setup: stores, event emitter, process manager, poll loops,
/// repo-type definitions, managed state and tray.
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // With `panic = "abort"` a panic kills the process with no trace in the
    // log file. Log the payload + location FIRST so a field crash leaves a
    // breadcrumb. Installed here (after the log plugin) so the record lands in
    // the configured targets; the default hook still runs after.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("PANIC: {info}");
        default_hook(info);
    }));

    let handle = app.handle().clone();

    // Stores in OS-standard directories (architecture-v2.md §7.5).
    let config_store = config::ConfigStore::new()?;
    let profile_store = profiles::ProfileStore::new()?;

    // Tray status tracker — language for the Rust-side tray strings comes
    // from the config.
    let tray_status = Arc::new(TrayStatus::default());
    match config_store.load() {
        Ok(cfg) => tray_status.set_language(cfg.language),
        Err(err) => log::warn!("config unavailable for tray language: {err}"),
    }

    // Log backlog cache for detached log windows (state.rs `LogCache`).
    let log_cache = Arc::new(state::LogCache::new());

    // Interactive PTY terminal registry (terminal::TerminalManager).
    let terminals = Arc::new(terminal::TerminalManager::new());

    // THE event emitter: forwards to the Tauri event system and mirrors
    // every `service://status-changed` into `TrayStatus` so the tray
    // tooltip stays fresh without polling (state.rs).
    let emitter: Arc<dyn EventEmitter> = Arc::new(TrayTrackingEmitter {
        app: handle.clone(),
        tray: tray_status.clone(),
        tray_green: std::sync::atomic::AtomicBool::new(false),
        logs: log_cache.clone(),
    });

    // Broadcast `config://changed` from the single ConfigStore.save choke point
    // so every window's SettingsStore stays in sync (config dialogs run in
    // their own windows — docs/migration/dialogs-as-windows.md Phase 3).
    config_store.set_emitter(emitter.clone());

    let process = Arc::new(process::ProcessManager::new(emitter.clone()));

    // THE `git status` cap (3) — one semaphore shared by the badge poll
    // loop and the on-demand badge commands (inventory-gui.md §28; a
    // poller-private semaphore would double the effective cap).
    let badge_semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(
        state::GIT_BADGE_SEMAPHORE_COUNT,
    ));

    // Poll loops need a tokio runtime context — enter it via block_on.
    let badge_emitter = emitter.clone();
    let docker_emitter = emitter.clone();
    let poller_semaphore = badge_semaphore.clone();
    let (badge_poller, docker_poller) = tauri::async_runtime::block_on(async move {
        (
            git::spawn_badge_poller(badge_emitter, poller_semaphore),
            docker::spawn_status_poller(docker_emitter),
        )
    });

    // Repo-type definitions: bundled resources merged with user overrides
    // (architecture-v2.md §5; `bundle.resources` maps `config/repo-types/`).
    let mut repo_defs = match app
        .path()
        .resolve("config/repo-types", tauri::path::BaseDirectory::Resource)
    {
        Ok(dir) => config::load_repo_type_defs(&dir, config::user_repo_types_dir().as_deref()),
        Err(err) => {
            log::error!("bundled repo-type definitions unavailable: {err}");
            Vec::new()
        }
    };
    config::sort_by_priority(&mut repo_defs);

    app.manage(AppState::new(
        config_store,
        profile_store,
        process,
        repo_defs,
        badge_poller,
        docker_poller,
        badge_semaphore,
        tray_status.clone(),
        log_cache,
        terminals,
    ));

    build_tray(&handle, &tray_status)?;
    // Pre-load the tray panel (hidden) so the first right-click shows a fully
    // rendered window, not a blank one.
    precreate_tray_panel(&handle);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tray (inventory-gui.md §25 — Tauri-native replacement of pystray)
// ---------------------------------------------------------------------------

/// Build the tray icon: running-count tooltip + the custom quick-control panel
/// on ANY click (left or right). There is NO native menu — the panel itself
/// carries Open/Close DevDeck, replacing the v1 dynamic pystray menu
/// (inventory-gui.md §25; docs/superpowers/specs/2026-06-23-tray-panel-design.md).
fn build_tray(
    app: &tauri::AppHandle,
    tray: &Arc<TrayStatus>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tray.tooltip())
        .on_tray_icon_event(|tray_icon, event| match event {
            // Right click → open the quick-control panel.
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => show_tray_panel(tray_icon.app_handle(), position),
            // Double left click → open DevDeck (restore the main window).
            // A single left click does nothing (user request).
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                if let Some(window) = tray_icon.app_handle().get_webview_window(MAIN_WINDOW) {
                    show_window(&window);
                }
            }
            _ => {}
        });
    // Linux (libayatana-appindicator) does NOT emit tray click events — the
    // panel-on-click UX above is dead there. Attach a native menu instead so
    // the window can always be restored and the app quit (the only platform
    // where the custom panel is unreachable). Windows/macOS keep the panel.
    #[cfg(target_os = "linux")]
    {
        use tauri::menu::{MenuBuilder, MenuItemBuilder};
        let (show_label, quit_label) = crate::state::tray_menu_labels(tray.is_spanish());
        let show = MenuItemBuilder::with_id("tray-show", show_label).build(app)?;
        let quit = MenuItemBuilder::with_id("tray-quit", quit_label).build(app)?;
        let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
        builder = builder
            .menu(&menu)
            .show_menu_on_left_click(true)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "tray-show" => {
                    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            show_window(&window);
                        }
                    }
                }
                "tray-quit" => request_quit(app),
                _ => {}
            });
    }
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Refresh the tray tooltip after a live language change. There is no native
/// menu to retranslate any more — the quick-control panel is a webview that
/// re-translates itself via the frontend i18n runtime. No-ops when the tray was
/// never built (non-desktop/tests).
pub(crate) fn refresh_tray(app: &tauri::AppHandle, tray: &TrayStatus) {
    let Some(tray_icon) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Err(err) = tray_icon.set_tooltip(Some(tray.tooltip())) {
        log::warn!("failed to refresh tray tooltip after language change: {err}");
    }
}

/// Show + unminimize + focus (single-instance takeover, tray restore).
fn show_window(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Inner size of the tray quick-control panel, in logical pixels.
const TRAY_PANEL_SIZE: (f64, f64) = (360.0, 440.0);

/// Instant of the last panel show — used to ignore the transient focus-loss
/// that fires while the popup settles, so it does not self-hide on open.
static TRAY_PANEL_SHOWN_AT: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);

/// Build the frameless tray panel webview, hidden (`?panel=1`). Shared by the
/// startup pre-create and the lazy fallback in `show_tray_panel`.
fn build_tray_panel_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let (w, h) = TRAY_PANEL_SIZE;
    tauri::WebviewWindowBuilder::new(
        app,
        TRAY_PANEL_WINDOW,
        tauri::WebviewUrl::App("index.html?panel=1".into()),
    )
    .title("DevDeck")
    .inner_size(w, h)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
}

/// Pre-create the (hidden) panel at startup so it is fully loaded before the
/// first show — kills the blank-on-first-open and the focus race. No-op if it
/// already exists.
fn precreate_tray_panel(app: &tauri::AppHandle) {
    if app.get_webview_window(TRAY_PANEL_WINDOW).is_some() {
        return;
    }
    if let Err(err) = build_tray_panel_window(app) {
        log::warn!("failed to pre-create tray panel: {err}");
    }
}

/// Reposition + show + focus the panel (created lazily if pre-create failed).
/// Auto-hides on blur (see `on_window_event`).
fn show_tray_panel(app: &tauri::AppHandle, click: tauri::PhysicalPosition<f64>) {
    let (w, h) = TRAY_PANEL_SIZE;
    let window = match app.get_webview_window(TRAY_PANEL_WINDOW) {
        Some(window) => window,
        None => match build_tray_panel_window(app) {
            Ok(window) => window,
            Err(err) => {
                log::warn!("failed to open tray panel: {err}");
                return;
            }
        },
    };
    position_tray_panel(&window, click, w, h);
    if let Ok(mut guard) = TRAY_PANEL_SHOWN_AT.lock() {
        *guard = Some(std::time::Instant::now());
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// True within the grace window after a show — the blur handler skips hiding
/// while this holds, so the popup does not self-close as it settles on open.
fn tray_panel_show_is_recent() -> bool {
    TRAY_PANEL_SHOWN_AT
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|shown| shown.elapsed() < std::time::Duration::from_millis(700))
        .unwrap_or(false)
}

/// Anchor the panel so its bottom-right corner sits near `click`, clamped to
/// `≥0`. The click position is physical, the inner size logical — convert via
/// the window scale factor. ponytail: single-monitor anchor; multi-monitor edge
/// math deferred until someone reports a clipped panel.
fn position_tray_panel(
    window: &tauri::WebviewWindow,
    click: tauri::PhysicalPosition<f64>,
    logical_w: f64,
    logical_h: f64,
) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let x = (click.x - logical_w * scale).max(0.0);
    let y = (click.y - logical_h * scale).max(0.0);
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Tray "Quit" — same protocol as the window close (inventory-gui.md §25:
/// quit routes through the confirm-running flow): with active services the
/// window is restored and `app://close-requested` emitted (the frontend
/// answers via `app_exit { force }`); otherwise exit directly.
pub(crate) fn request_quit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.tray.any_active() || state.terminals.any_open() {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            show_window(&window);
        }
        EventEmitter::emit(app, APP_CLOSE_REQUESTED, serde_json::json!({}));
    } else {
        app.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Tray-tracking event emitter
// ---------------------------------------------------------------------------

/// Production [`EventEmitter`]: forwards every event to the Tauri event
/// system and mirrors `service://status-changed` payloads into
/// [`TrayStatus`], refreshing the tray tooltip — and swapping the
/// red-idle/green-running icon (inventory-gui.md §25 tray icon lifecycle) —
/// on each transition. This is the emit-driven replacement of v1's 5 s tray
/// status poll (state.rs).
struct TrayTrackingEmitter {
    app: tauri::AppHandle,
    tray: Arc<TrayStatus>,
    /// Last applied icon state, so `set_icon` only runs on the
    /// idle↔running edge (not on every status event).
    tray_green: std::sync::atomic::AtomicBool,
    /// Backlog cache for detached log windows — every emitted
    /// `service://log-line` batch is mirrored here (state.rs `LogCache`).
    logs: Arc<state::LogCache>,
}

impl EventEmitter for TrayTrackingEmitter {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if event == events::SERVICE_LOG_LINE {
            // Payload shape: events::ServiceLogPayload (camelCase).
            if let (Some(name), Some(lines)) = (
                payload.get("name").and_then(|v| v.as_str()),
                payload.get("lines").and_then(|v| v.as_array()),
            ) {
                let lines: Vec<String> = lines
                    .iter()
                    .filter_map(|l| l.as_str().map(str::to_string))
                    .collect();
                self.logs.push_batch(name, &lines);
            }
        }
        if event == SERVICE_STATUS_CHANGED && record_status_payload(&self.tray, &payload) {
            if let Some(tray_icon) = self.app.tray_by_id(TRAY_ID) {
                let _ = tray_icon.set_tooltip(Some(self.tray.tooltip()));
                // Green while anything is running/starting (the v1 rule),
                // base icon otherwise — only on state change.
                let green = self.tray.running_count() > 0;
                let was_green = self
                    .tray_green
                    .swap(green, std::sync::atomic::Ordering::Relaxed);
                if green != was_green {
                    if let Some(image) = tray_icon_image(green) {
                        let _ = tray_icon.set_icon(Some(image));
                    }
                }
            }
        }
        EventEmitter::emit(&self.app, event, payload);
    }
}

/// Decode the bundled tray icon for the given state: `icons/icon-green.ico`
/// while services run, `icons/icon.ico` when idle (inventory-gui.md §25).
/// Decoding needs the tauri `image-ico` cargo feature (enabled — see
/// Cargo.toml). A decode failure keeps the current icon (warn only).
fn tray_icon_image(green: bool) -> Option<tauri::image::Image<'static>> {
    let bytes: &[u8] = if green {
        include_bytes!("../icons/icon-green.ico")
    } else {
        include_bytes!("../icons/icon.ico")
    };
    match tauri::image::Image::from_bytes(bytes) {
        Ok(image) => Some(image),
        Err(err) => {
            log::warn!("failed to decode tray icon (green: {green}): {err}");
            None
        }
    }
}

/// Record a `service://status-changed` payload into [`TrayStatus`].
/// Returns whether a valid `{ name, status }` pair was recorded (pure
/// w.r.t. everything but `tray` — unit-tested below).
fn record_status_payload(tray: &TrayStatus, payload: &serde_json::Value) -> bool {
    let Some(name) = payload.get("name").and_then(|v| v.as_str()) else {
        return false;
    };
    let Some(status) = payload.get("status").and_then(|v| v.as_str()) else {
        return false;
    };
    match status.parse::<ServiceStatus>() {
        Ok(parsed) => {
            tray.record(name, parsed);
            true
        }
        Err(err) => {
            log::warn!("tray: unparseable status payload: {err}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_valid_status_payloads() {
        let tray = TrayStatus::default();
        tray.set_total(3);

        let recorded = record_status_payload(
            &tray,
            &serde_json::json!({ "name": "api", "status": "running" }),
        );
        assert!(recorded);
        assert_eq!(tray.running_count(), 1);
        assert_eq!(tray.tooltip(), "DevDeck — 1/3 running");

        // Terminal status clears the entry.
        let recorded = record_status_payload(
            &tray,
            &serde_json::json!({ "name": "api", "status": "stopped", "exitCode": 0 }),
        );
        assert!(recorded);
        assert_eq!(tray.running_count(), 0);
    }

    #[test]
    fn rejects_malformed_payloads() {
        let tray = TrayStatus::default();
        assert!(!record_status_payload(&tray, &serde_json::json!({})));
        assert!(!record_status_payload(
            &tray,
            &serde_json::json!({ "name": "api" })
        ));
        assert!(!record_status_payload(
            &tray,
            &serde_json::json!({ "name": "api", "status": "warp-speed" })
        ));
        assert_eq!(tray.running_count(), 0);
    }
}
