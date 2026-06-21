//! Event contract between the Rust core and the Angular frontend.
//!
//! This file is the single source of truth for event names and payload shapes
//! (architecture-v2.md §3.2). It replaces the v1 Python EventBus, whose only
//! real event was `SERVICE_STATUS_CHANGED` (inventory-backend.md §4.1 — the
//! `REQUEST_*` events documented in v1 never existed and are not reintroduced).
//!
//! Rules:
//! - Only Rust emits these events; the frontend only listens.
//! - Payloads are `camelCase` on the wire (serde rename_all) to match the
//!   TypeScript mirror types in `src/app/core/ipc/`.
//! - Log lines are batched before emission (~50-100 ms / 64 lines, see
//!   `process::constants`) so chatty builds do not flood the IPC bridge.
//! - Modules emit through the [`EventEmitter`] trait, never through
//!   `tauri::AppHandle` directly — this keeps process/git/docker code
//!   unit-testable with the [`test_support::CollectingEmitter`] double.

use serde::Serialize;

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

/// Service lifecycle transition. Replaces `SERVICE_STATUS_CHANGED`
/// (inventory-backend.md §4.1) and carries the runtime-detected port that v1
/// extracted GUI-side from log lines (inventory-backend.md §21.2).
pub const SERVICE_STATUS_CHANGED: &str = "service://status-changed";

/// Batched log output from a supervised process (service, install, docker or
/// git operation). ANSI escapes are stripped Rust-side.
pub const SERVICE_LOG_LINE: &str = "service://log-line";

/// Workspace scan progress for the status bar.
/// Emitted by the `detection` layer (name + payload live here so the project
/// has exactly one event registry).
pub const REPO_SCAN_PROGRESS: &str = "repo://scan-progress";

/// Per-repo git badge refresh result (the 30 s poll loop now lives in Rust;
/// see `get_status_summary`, inventory-backend.md §10.2).
/// Emitted by the `git` layer.
pub const GIT_BADGE: &str = "git://badge";

/// Per-repo docker compose service status (15 s poll,
/// inventory-backend.md §9). Emitted by the `docker` layer.
pub const DOCKER_STATUS: &str = "docker://status";

/// A second app instance was launched; payload carries its argv so the
/// frontend can react (e.g. switch workspace). Emitted from the
/// single-instance plugin callback in `lib.rs` (architecture-v2.md §7.6).
pub const APP_SINGLE_INSTANCE: &str = "app://single-instance";

/// The user asked to close the main window (or chose Quit in the tray) while
/// services are still running. Rust prevents the close and emits this event;
/// the frontend shows the confirm-running dialog and answers with the
/// `app_exit { force }` command (ipc-contract.md "App lifecycle extensions").
/// Payload: `{}` (empty object).
pub const APP_CLOSE_REQUESTED: &str = "app://close-requested";

/// Update download progress while `install_update` runs. Payload:
/// `{ downloaded: u64, contentLength: u64 | null }` (camelCase). Emitted from
/// the updater command's `download_and_install` chunk callback.
pub const UPDATE_PROGRESS: &str = "update://progress";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/// Canonical service status — the 6-state model owned by the domain layer
/// (`stopped | starting | running | stopping | installing | error`).
///
/// Unification per ipc-contract.md §1.4: events.rs previously declared a
/// private 5-state copy (no `stopping`); the commands integration replaced
/// it with this re-export so `service://status-changed` can emit all 6
/// states and the TS union in `tauri.types.ts` has exactly one Rust source.
/// events.rs stays the wire-format owner via this re-export.
pub use crate::domain::ServiceStatus;

/// Origin of a log line, so the frontend can route it to the right panel
/// (architecture-v2.md §3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Service,
    Install,
    Docker,
    Git,
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// Payload for [`SERVICE_STATUS_CHANGED`].
///
/// `name` is the service id — `"repo"` or `"repo::module"` (the v1
/// config-key convention, inventory-backend.md §8.3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusPayload {
    pub name: String,
    pub status: ServiceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

/// Payload for [`SERVICE_LOG_LINE`] — one batch of already-decoded,
/// ANSI-stripped, non-empty lines. `timestamp_ms` is the flush instant
/// (Unix epoch milliseconds); per-line timestamps are not tracked, matching
/// v1 which never timestamped log lines.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLogPayload {
    pub name: String,
    pub stream: LogStream,
    pub lines: Vec<String>,
    pub timestamp_ms: u64,
}

/// Payload for [`REPO_SCAN_PROGRESS`]. Owned by the `detection` layer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressPayload {
    /// Free-form phase id, e.g. `"scanning"`, `"classifying"`, `"done"`.
    pub phase: String,
    pub detected: u32,
    pub total: u32,
}

/// Payload for [`GIT_BADGE`] — mirrors `get_status_summary`
/// (inventory-backend.md §10.2). Owned by the `git` layer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBadgePayload {
    pub name: String,
    pub branch: String,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub conflicts: u32,
}

/// State of one docker compose service (inventory-backend.md §9:
/// not-running ⇒ `stopped`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DockerServiceState {
    Running,
    Stopped,
}

/// Payload for [`DOCKER_STATUS`]. Owned by the `docker` layer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatusPayload {
    pub name: String,
    pub services: std::collections::HashMap<String, DockerServiceState>,
}

/// Payload for [`APP_SINGLE_INSTANCE`]. Owned by `lib.rs` (single-instance
/// plugin callback).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SingleInstancePayload {
    pub argv: Vec<String>,
    pub cwd: String,
}

// ---------------------------------------------------------------------------
// Emitter abstraction
// ---------------------------------------------------------------------------

/// Event sink abstraction. Side-effectful modules (process, git, docker)
/// depend on this trait — never on `tauri::AppHandle` — so their logic stays
/// unit-testable with [`test_support::CollectingEmitter`].
///
/// Implementations must be cheap to call from any tokio task; emission
/// failures are logged and swallowed (the v1 EventBus likewise never let a
/// bad subscriber propagate, inventory-backend.md §4).
pub trait EventEmitter: Send + Sync {
    /// Emit a raw event. `payload` is the already-serialized JSON value.
    fn emit(&self, event: &str, payload: serde_json::Value);

    /// Convenience: emit a [`SERVICE_STATUS_CHANGED`] event.
    fn emit_status(&self, payload: &ServiceStatusPayload) {
        match serde_json::to_value(payload) {
            Ok(value) => self.emit(SERVICE_STATUS_CHANGED, value),
            Err(err) => log::error!("failed to serialize status payload: {err}"),
        }
    }

    /// Convenience: emit a [`SERVICE_LOG_LINE`] batch.
    fn emit_log(&self, payload: &ServiceLogPayload) {
        match serde_json::to_value(payload) {
            Ok(value) => self.emit(SERVICE_LOG_LINE, value),
            Err(err) => log::error!("failed to serialize log payload: {err}"),
        }
    }
}

/// Production emitter: forwards to the Tauri event system.
impl EventEmitter for tauri::AppHandle {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Err(err) = tauri::Emitter::emit(self, event, payload) {
            log::error!("failed to emit event '{event}': {err}");
        }
    }
}

/// Current time as Unix epoch milliseconds (0 if the clock predates epoch).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

/// In-memory [`EventEmitter`] double for unit tests across the crate.
#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Records every emitted `(event, payload)` pair for later assertions.
    #[derive(Default)]
    pub struct CollectingEmitter {
        pub events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl CollectingEmitter {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        /// All payloads emitted under `event`.
        pub fn payloads(&self, event: &str) -> Vec<serde_json::Value> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(name, _)| name == event)
                .map(|(_, payload)| payload.clone())
                .collect()
        }

        /// Status strings (in emission order) for a given service name.
        pub fn statuses_for(&self, name: &str) -> Vec<String> {
            self.payloads(SERVICE_STATUS_CHANGED)
                .into_iter()
                .filter(|p| p["name"] == name)
                .filter_map(|p| p["status"].as_str().map(str::to_owned))
                .collect()
        }

        /// All log lines (flattened across batches) for a given service name.
        pub fn log_lines_for(&self, name: &str) -> Vec<String> {
            self.payloads(SERVICE_LOG_LINE)
                .into_iter()
                .filter(|p| p["name"] == name)
                .flat_map(|p| {
                    p["lines"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|l| l.as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .collect()
        }

        /// Last emitted port (if any) for a given service name.
        pub fn last_port_for(&self, name: &str) -> Option<u16> {
            self.payloads(SERVICE_STATUS_CHANGED)
                .into_iter()
                .filter(|p| p["name"] == name)
                .filter_map(|p| p["port"].as_u64())
                .last()
                .map(|p| p as u16)
        }
    }

    impl EventEmitter for CollectingEmitter {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events
                .lock()
                .unwrap()
                .push((event.to_owned(), payload));
        }
    }
}
