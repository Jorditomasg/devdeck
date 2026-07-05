//! Managed application state (`tauri::Builder::manage`).
//!
//! Replaces three v1 singletons at once: `ServiceLauncher._services`,
//! `ProcessManager._services` and the mtime-cached config dict
//! (inventory-backend.md §17, §18, §8.1). All side-effectful modules read and
//! mutate state through here; commands receive it as `tauri::State<AppState>`.
//!
//! Concurrency contract (architecture-v2.md §2): interior mutability via
//! `RwLock`-guarded collections, copy-on-read for snapshots — the v1 hazard
//! of handing out shared mutable cached dicts (inventory-backend.md §22.9)
//! must not be reproduced. Guards are never held across an `.await`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tokio::sync::Semaphore;

use crate::config::ConfigStore;
use crate::docker::{DockerLogManager, StatusPoller};
use crate::domain::{RepoInfo, RepoTypeDef, ServiceStatus};
use crate::events::EventEmitter;
use crate::git::BadgePoller;
use crate::process::ProcessManager;
use crate::profiles::ProfileStore;
use crate::terminal::TerminalManager;

/// Git badge concurrency cap (inventory-gui.md §28 — do not raise).
/// Aliased from the poll module so the two declarations can never drift.
pub const GIT_BADGE_SEMAPHORE_COUNT: usize = crate::git::poll::GIT_BADGE_SEMAPHORE_COUNT;

/// Git fetch concurrency cap (inventory-gui.md §28 — do not raise).
pub const GIT_FETCH_SEMAPHORE_COUNT: usize = 2;

/// The application state managed by Tauri (constructed in `lib.rs` setup —
/// it needs a live `AppHandle` for the event emitter and a running tokio
/// runtime for the poll loops, so there is no `Default`).
pub struct AppState {
    /// App config with write-through persistence (`config.json` in the OS
    /// config dir, inventory-backend.md §8).
    pub config: ConfigStore,
    /// Profile CRUD rooted at `dirs::data_dir()/devdeck/profiles/`.
    pub profiles: ProfileStore,
    /// Subprocess supervision registry — survives frontend restarts
    /// (architecture-v2.md §2).
    pub process: Arc<ProcessManager>,
    /// Repo-type definitions (bundled resources merged with user overrides),
    /// pre-sorted by priority as `detection::detect_repos_for_group` expects.
    pub repo_defs: RwLock<Vec<RepoTypeDef>>,
    /// Last `scan_workspace` result (ipc-contract.md §2.2 side effect) —
    /// the lookup table for `start_service` spec building and profile
    /// config-file capture.
    pub repos: RwLock<Vec<RepoInfo>>,
    /// 30 s git badge poll loop handle (`git://badge`).
    pub badge_poller: BadgePoller,
    /// 15 s docker compose status poll loop handle (`docker://status`).
    pub docker_poller: StatusPoller,
    /// Ref-counted live `docker compose logs -f` followers (`docker_log_start`
    /// / `docker_log_stop`) — one process per watched log, none otherwise.
    pub docker_logs: Arc<DockerLogManager>,
    /// THE `git status` concurrency cap (3) — shared by the 30 s badge
    /// poll loop AND the on-demand badge queries (`git_status_summary`,
    /// `git_refresh_badge`), so the combined concurrency can never exceed
    /// v1's `GIT_BADGE_SEMAPHORE_COUNT` (inventory-gui.md §28).
    pub badge_semaphore: Arc<Semaphore>,
    /// `git_fetch` cap (2 concurrent fetches).
    pub fetch_semaphore: Arc<Semaphore>,
    /// Shared running-count tracker behind the tray tooltip/icon.
    pub tray: Arc<TrayStatus>,
    /// Rust-side log backlog for detached log windows (`open_log_window`):
    /// a fresh webview has no event history, so it seeds from this cache
    /// (`get_log_backlog`) and then follows live `service://log-line` events.
    pub logs: Arc<LogCache>,
    /// Interactive PTY terminal sessions (`open_terminal_window`), one per
    /// detached `term-*` window. Isolated from `process` (no status machine);
    /// `any_open()` gates the app-close confirmation alongside `tray`.
    pub terminals: Arc<TerminalManager>,
    /// Pending native-dialog windows (`commands::dialog`), keyed by each
    /// window's label (which doubles as its result token). See
    /// docs/migration/dialogs-as-windows.md.
    pub dialogs: Arc<DialogManager>,
    /// THE production event emitter (lib.rs `TrayTrackingEmitter`). Every
    /// `service://log-line` MUST go through it — emitting via the raw
    /// `AppHandle` skips the `LogCache` mirror and the line never reaches
    /// detached-window backlogs (`get_log_backlog`).
    pub emitter: Arc<dyn EventEmitter>,
}

/// Registry of open native-dialog windows (`commands::dialog`). Maps a dialog
/// window's label (= its result token) to the JSON args it was opened with. A
/// slot lives from `open_dialog_window` until the window resolves
/// (`resolve_dialog`) or is closed (`lib.rs` `on_window_event`).
#[derive(Default)]
pub struct DialogManager {
    counter: AtomicUsize,
    slots: Mutex<HashMap<String, serde_json::Value>>,
}

impl DialogManager {
    /// Allocate a unique `dlg-<kind>-<n>` label/token and store its args.
    pub fn allocate(&self, kind: &str, args: serde_json::Value) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let token = format!("dlg-{kind}-{n}");
        self.slots
            .lock()
            .expect("dialog registry poisoned")
            .insert(token.clone(), args);
        token
    }

    /// Token of a still-open dialog window matching `kind` AND `args`, if any.
    /// Used to keep dialogs singleton per logical identity: a second open of
    /// the same kind with the same args focuses the existing window instead of
    /// stacking duplicates. The `dlg-{kind}-` prefix is exact even when `kind`
    /// itself contains hyphens (e.g. `merge-branch`), and matching args means
    /// per-repo dialogs for *different* repos still coexist.
    pub fn existing(&self, kind: &str, args: &serde_json::Value) -> Option<String> {
        let prefix = format!("dlg-{kind}-");
        self.slots
            .lock()
            .expect("dialog registry poisoned")
            .iter()
            .find(|(token, slot_args)| {
                // Only the numeric counter may follow the prefix — otherwise
                // `dlg-merge-` would also match `dlg-merge-branch-1`.
                token
                    .strip_prefix(&prefix)
                    .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
                    && *slot_args == args
            })
            .map(|(token, _)| token.clone())
    }

    /// The args a dialog window was opened with (`None` once resolved/closed).
    pub fn args(&self, token: &str) -> Option<serde_json::Value> {
        self.slots
            .lock()
            .expect("dialog registry poisoned")
            .get(token)
            .cloned()
    }

    /// Remove a pending slot; returns `true` when it was still pending, so the
    /// caller emits `dialog://resolved` exactly once.
    pub fn take(&self, token: &str) -> bool {
        self.slots
            .lock()
            .expect("dialog registry poisoned")
            .remove(token)
            .is_some()
    }
}

/// Per-service ring buffer of recent log lines, fed by the event emitter on
/// every `service://log-line` batch. `GLOBAL` aggregates all services with a
/// `[name] ` prefix (the detached global log, inventory-gui.md §5).
pub struct LogCache {
    buffers: Mutex<HashMap<String, std::collections::VecDeque<String>>>,
}

impl LogCache {
    /// Aggregated pseudo-service id (also the `?log=` URL value).
    pub const GLOBAL: &'static str = "__global__";
    /// Per-service cap — matches the frontend log-viewer cap (§28).
    const CAP: usize = 500;
    /// Global aggregate cap — matches `ServicesStore.globalLog` (§5).
    const GLOBAL_CAP: usize = 1000;

    pub fn new() -> Self {
        LogCache { buffers: Mutex::new(HashMap::new()) }
    }

    /// Record one emitted batch for `name`, mirroring into the aggregate.
    /// Live docker `logs -f` followers use synthetic `docker::…` ids (design
    /// doc 2026-07-05); those are kept out of the `GLOBAL` aggregate (their id
    /// is not a real service name and would read as noise) while still cached
    /// per-id so their detached window backlog seeds correctly.
    pub fn push_batch(&self, name: &str, lines: &[String]) {
        let mut buffers = self.buffers.lock().expect("log cache poisoned");
        let push = |buf: &mut std::collections::VecDeque<String>, line: String, cap: usize| {
            if buf.len() == cap {
                buf.pop_front();
            }
            buf.push_back(line);
        };
        let service = buffers.entry(name.to_string()).or_default();
        for line in lines {
            push(service, line.clone(), Self::CAP);
        }
        if name.starts_with(crate::docker::DOCKER_LOG_PREFIX) {
            return;
        }
        let global = buffers.entry(Self::GLOBAL.to_string()).or_default();
        for line in lines {
            push(global, format!("[{name}] {line}"), Self::GLOBAL_CAP);
        }
    }

    /// Snapshot of the backlog for one service (empty when unknown).
    pub fn backlog(&self, name: &str) -> Vec<String> {
        self.buffers
            .lock()
            .expect("log cache poisoned")
            .get(name)
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }
}

impl Default for LogCache {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    /// Assemble the state. Must be called with a tokio runtime context
    /// available (the poll loops are spawned by the caller beforehand).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: ConfigStore,
        profiles: ProfileStore,
        process: Arc<ProcessManager>,
        repo_defs: Vec<RepoTypeDef>,
        badge_poller: BadgePoller,
        docker_poller: StatusPoller,
        docker_logs: Arc<DockerLogManager>,
        badge_semaphore: Arc<Semaphore>,
        tray: Arc<TrayStatus>,
        logs: Arc<LogCache>,
        terminals: Arc<TerminalManager>,
        emitter: Arc<dyn EventEmitter>,
    ) -> Self {
        AppState {
            config,
            profiles,
            process,
            repo_defs: RwLock::new(repo_defs),
            repos: RwLock::new(Vec::new()),
            badge_poller,
            docker_poller,
            docker_logs,
            badge_semaphore,
            fetch_semaphore: Arc::new(Semaphore::new(GIT_FETCH_SEMAPHORE_COUNT)),
            tray,
            logs,
            terminals,
            dialogs: Arc::new(DialogManager::default()),
            emitter,
        }
    }

    /// Copy-on-read snapshot of the last scan (empty before the first scan).
    pub fn repos_snapshot(&self) -> Vec<RepoInfo> {
        self.repos
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Copy-on-read snapshot of the sorted repo-type definitions.
    pub fn repo_defs_snapshot(&self) -> Vec<RepoTypeDef> {
        self.repo_defs
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Find a scanned repo by the repo half of a service id
    /// (`"repo"` or `"repo::module"`, ipc-contract.md §1.5).
    pub fn find_repo_for_service(&self, service_id: &str) -> Option<RepoInfo> {
        let repo_name = service_id.split("::").next().unwrap_or(service_id);
        self.repos
            .read()
            .ok()
            .and_then(|g| g.iter().find(|r| r.name == repo_name).cloned())
    }
}

// ---------------------------------------------------------------------------
// Tray status tracking (inventory-gui.md §25)
// ---------------------------------------------------------------------------

/// Tracks per-service status (fed from emitted `service://status-changed`
/// payloads) plus the detected-repo total, so the tray tooltip and red/green
/// icon can be recomputed without querying the process registry.
///
/// v1 polled every 5 s (`_check_tray_status`); v2 is emit-driven — the
/// wrapping emitter in `lib.rs` records every status transition here.
#[derive(Default)]
pub struct TrayStatus {
    statuses: Mutex<HashMap<String, ServiceStatus>>,
    total_repos: AtomicUsize,
    /// UI language code (`en_EN`/`es_ES`) captured at startup — the tray
    /// strings live Rust-side, outside the frontend i18n files.
    language: Mutex<Option<String>>,
}

impl TrayStatus {
    /// Record a status transition for a service id.
    pub fn record(&self, name: &str, status: ServiceStatus) {
        if let Ok(mut map) = self.statuses.lock() {
            if matches!(status, ServiceStatus::Stopped | ServiceStatus::Error) {
                map.remove(name);
            } else {
                map.insert(name.to_owned(), status);
            }
        }
    }

    /// Set the total card count (updated by `scan_workspace`).
    pub fn set_total(&self, total: usize) {
        self.total_repos.store(total, Ordering::Relaxed);
    }

    /// Set the UI language used for tray strings.
    pub fn set_language(&self, lang: Option<String>) {
        if let Ok(mut guard) = self.language.lock() {
            *guard = lang;
        }
    }

    /// True when the tray strings should be Spanish (`es_*` language code).
    pub fn is_spanish(&self) -> bool {
        self.language
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .map(|l| l.starts_with("es"))
            .unwrap_or(false)
    }

    /// Services currently running or starting (the v1 "green icon" rule,
    /// inventory-gui.md §25 tray icon lifecycle).
    pub fn running_count(&self) -> usize {
        self.statuses
            .lock()
            .map(|m| {
                m.values()
                    .filter(|s| matches!(s, ServiceStatus::Running | ServiceStatus::Starting))
                    .count()
            })
            .unwrap_or(0)
    }

    /// True while any tracked service is in a non-terminal state — gates
    /// the close-confirmation flow and the green tray icon.
    pub fn any_active(&self) -> bool {
        self.statuses
            .lock()
            .map(|m| m.values().any(|s| s.is_active()))
            .unwrap_or(false)
    }

    /// Current tooltip text (v1: `"DevDeck — {running}/{total}
    /// corriendo"`, inventory-gui.md §25 — flagged hardcoded-Spanish there;
    /// v2 localizes from the config language).
    pub fn tooltip(&self) -> String {
        format_tray_tooltip(
            self.running_count(),
            self.total_repos.load(Ordering::Relaxed),
            self.is_spanish(),
        )
    }
}

/// Pure tooltip formatter (unit-tested; see [`TrayStatus::tooltip`]).
pub fn format_tray_tooltip(running: usize, total: usize, spanish: bool) -> String {
    let word = if spanish { "corriendo" } else { "running" };
    format!("DevDeck — {running}/{total} {word}")
}

/// Tray menu labels (show/hide toggle, quit) for the configured language.
/// v1 used the i18n keys `tray.show` / `tray.quit` (inventory-gui.md §25).
pub fn tray_menu_labels(spanish: bool) -> (&'static str, &'static str) {
    if spanish {
        ("Mostrar / Ocultar", "Salir")
    } else {
        ("Show / Hide", "Quit")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_existing_matches_kind_and_args_only() {
        use serde_json::json;
        let d = DialogManager::default();
        let a = d.allocate("merge-branch", json!({ "repoName": "api" }));
        d.allocate("merge-branch", json!({ "repoName": "web" }));

        // Same kind + same args → finds the live window (focus, not duplicate).
        assert_eq!(d.existing("merge-branch", &json!({ "repoName": "api" })), Some(a));
        // Same kind, different args (other repo) → no match, opens a new one.
        assert_eq!(d.existing("merge-branch", &json!({ "repoName": "db" })), None);
        // `dlg-merge-branch-` prefix must not leak into a different kind.
        assert_eq!(d.existing("merge", &json!({ "repoName": "api" })), None);

        // Resolving frees the slot, so the next open is allowed again.
        let token = d.existing("merge-branch", &json!({ "repoName": "web" })).unwrap();
        assert!(d.take(&token));
        assert_eq!(d.existing("merge-branch", &json!({ "repoName": "web" })), None);
    }

    #[test]
    fn tooltip_formats_running_over_total() {
        assert_eq!(
            format_tray_tooltip(2, 5, false),
            "DevDeck — 2/5 running"
        );
        assert_eq!(
            format_tray_tooltip(0, 3, true),
            "DevDeck — 0/3 corriendo"
        );
    }

    #[test]
    fn tray_status_counts_only_running_and_starting() {
        let tray = TrayStatus::default();
        tray.set_total(4);
        tray.record("a", ServiceStatus::Starting);
        tray.record("b", ServiceStatus::Running);
        tray.record("c", ServiceStatus::Installing);
        assert_eq!(tray.running_count(), 2);
        assert!(tray.any_active()); // installing counts as active
        assert_eq!(tray.tooltip(), "DevDeck — 2/4 running");
    }

    #[test]
    fn terminal_statuses_clear_the_entry() {
        let tray = TrayStatus::default();
        tray.record("a", ServiceStatus::Running);
        tray.record("a", ServiceStatus::Stopped);
        assert_eq!(tray.running_count(), 0);
        assert!(!tray.any_active());

        tray.record("b", ServiceStatus::Starting);
        tray.record("b", ServiceStatus::Error);
        assert!(!tray.any_active());
    }

    #[test]
    fn stopping_is_active_but_not_running() {
        let tray = TrayStatus::default();
        tray.record("a", ServiceStatus::Stopping);
        assert_eq!(tray.running_count(), 0);
        assert!(tray.any_active());
    }

    #[test]
    fn spanish_labels() {
        assert_eq!(tray_menu_labels(true), ("Mostrar / Ocultar", "Salir"));
        assert_eq!(tray_menu_labels(false), ("Show / Hide", "Quit"));
    }

    #[test]
    fn language_detection() {
        let tray = TrayStatus::default();
        assert!(!tray.is_spanish());
        tray.set_language(Some("es_ES".into()));
        assert!(tray.is_spanish());
        tray.set_language(Some("en_EN".into()));
        assert!(!tray.is_spanish());
    }
}
