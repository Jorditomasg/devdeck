//! DevOps Manager v2 — Rust core.
//!
//! Composition root: registers plugins, managed state, the tray icon and
//! every command handler (ipc-contract.md §2 — 59 commands: 55 core + the
//! 2 app-lifecycle extensions + `set_last_profile` #58 / `is_installed`
//! #59). Module responsibilities are documented in
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

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WindowEvent};

use crate::domain::ServiceStatus;
use crate::events::{EventEmitter, APP_CLOSE_REQUESTED, SERVICE_STATUS_CHANGED};
use crate::state::{AppState, TrayStatus};

/// Label of the (single) main window — `tauri.conf.json` `app.windows[0]`.
const MAIN_WINDOW: &str = "main";

/// Tray icon id (`Manager::tray_by_id` lookups from the tooltip refresher).
const TRAY_ID: &str = "main-tray";

/// Tray menu item ids.
const MENU_TOGGLE_ID: &str = "toggle-window";
const MENU_QUIT_ID: &str = "quit";

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
        .setup(setup)
        .on_window_event(|window, event| {
            // Main-window-only behaviors: detached log windows ("log-*")
            // close and minimize like plain windows.
            if window.label() != "main" {
                return;
            }
            match event {
                // Close interception (inventory-gui.md §17): prevent the close
                // while services run OR any PTY terminal is open; the frontend
                // shows the confirm dialog and answers with `app_exit { force }`.
                // With nothing running the close proceeds and `RunEvent::Exit`
                // does the cleanup.
                WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    let state = app.state::<AppState>();
                    if state.tray.any_active() || state.terminals.any_open() {
                        api.prevent_close();
                        EventEmitter::emit(app, APP_CLOSE_REQUESTED, serde_json::json!({}));
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
            commands::app::open_log_window,
            commands::app::get_log_backlog,
            // interactive terminals (design doc 2026-06-14)
            commands::terminal::open_terminal_window,
            commands::terminal::attach_terminal,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::close_terminal,
            // §2.2 detection
            commands::detection::scan_workspace,
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
            // §2.5 config
            commands::config::get_app_config,
            commands::config::set_language,
            commands::config::set_minimize_to_tray,
            commands::config::set_active_group,
            commands::config::save_workspace_groups,
            commands::config::set_repo_state,
            commands::config::get_saved_environments,
            commands::config::save_saved_environments,
            commands::config::set_active_config,
            commands::config::set_danger_flags,
            commands::config::set_last_profile,
            commands::config::read_config_file,
            commands::config::write_config_file,
            commands::config::apply_environment,
            commands::config::migrate_from_v1,
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
            commands::docker::run_flyway_seeds,
        ])
        .build(tauri::generate_context!())
        .expect("error while building DevOps Manager")
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

/// Builder setup: stores, v1-migration probe, event emitter, process
/// manager, poll loops, repo-type definitions, managed state and tray.
///
/// Runs BEFORE the webview loads, so the migration probe always completes
/// before the frontend's first `get_app_config` (commands/app.rs).
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    // Stores in OS-standard directories (architecture-v2.md §7.5).
    let config_store = config::ConfigStore::new()?;
    let profile_store = profiles::ProfileStore::new()?;

    // One-shot v1 migration probe (architecture-v2.md §6). A failed probe
    // must not block startup — warn and start fresh; the user can retry
    // with an explicit folder via `migrate_from_v1 { v1Root }`.
    let pending_migration = if config_store.exists() {
        None
    } else {
        let profiles_dest = config::default_profiles_dir()?;
        config::find_v1_install(&state::default_v1_candidates())
            .and_then(|root| {
                config::migrate_from_v1(&config_store, &root, &profiles_dest)
                    .unwrap_or_else(|err| {
                        log::warn!("v1 migration failed (starting fresh): {err}");
                        None
                    })
            })
    };

    // Tray status tracker — language for the Rust-side tray strings comes
    // from the (possibly just migrated) config.
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
        pending_migration,
        tray_status.clone(),
        log_cache,
        terminals,
    ));

    build_tray(&handle, &tray_status)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tray (inventory-gui.md §25 — Tauri-native replacement of pystray)
// ---------------------------------------------------------------------------

/// Build the tray icon: localized show/hide + quit menu, running-count
/// tooltip, left-click restores the window (v1 default-item semantics).
fn build_tray(
    app: &tauri::AppHandle,
    tray: &Arc<TrayStatus>,
) -> Result<(), Box<dyn std::error::Error>> {
    let spanish = tray.is_spanish();
    let (toggle_label, quit_label) = state::tray_menu_labels(spanish);
    let toggle = MenuItem::with_id(app, MENU_TOGGLE_ID, toggle_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT_ID, quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tray.tooltip())
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_TOGGLE_ID => toggle_main_window(app),
            MENU_QUIT_ID => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray_icon, event| {
            // Left click restores the window (v1: tray default item).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray_icon.app_handle().get_webview_window(MAIN_WINDOW) {
                    show_window(&window);
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Show + unminimize + focus (single-instance takeover, tray restore).
fn show_window(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Tray "Show / Hide": hide when visible, restore otherwise.
fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        show_window(&window);
    }
}

/// Tray "Quit" — same protocol as the window close (inventory-gui.md §25:
/// quit routes through the confirm-running flow): with active services the
/// window is restored and `app://close-requested` emitted (the frontend
/// answers via `app_exit { force }`); otherwise exit directly.
fn request_quit(app: &tauri::AppHandle) {
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
        assert_eq!(tray.tooltip(), "DevOps Manager — 1/3 running");

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
