//! Tauri command handlers — the typed IPC surface consumed by
//! `src/app/core/ipc/` on the Angular side.
//!
//! Thin layer by contract (architecture-v2.md §3.1, §4; ipc-contract.md):
//! validate input, call the owning module, map errors to the serializable
//! `AppError { kind, message }` envelope ([`error`]). No business logic here.
//!
//! One file per contract group (ipc-contract.md §2):
//! - [`app`] — §2.1 app lifecycle (+ the documented lifecycle extensions:
//!   `app_exit`, `app_hide_to_tray`)
//! - [`detection`] — §2.2 `scan_workspace`
//! - [`process`] — §2.3 process supervision
//! - [`git`] — §2.4 git operations
//! - [`config`] — §2.5 config persistence + §2.5 #36 v1 migration
//! - [`java`] — §2.6 JDK registry
//! - [`profiles`] — §2.7 profiles
//! - [`docker`] — §2.8 docker compose
//!
//! Argument keys arrive camelCase on the wire and map to snake_case Rust
//! parameters via Tauri 2's default renaming — handlers MUST NOT opt out
//! (ipc-contract.md §1.1).

pub mod app;
pub mod config;
pub mod detection;
pub mod docker;
pub mod error;
pub mod git;
pub mod java;
pub mod process;
pub mod profiles;
pub mod terminal;

pub use error::{AppError, CmdResult};

use std::sync::Arc;

use crate::events::{EventEmitter, LogStream, ServiceLogPayload};

/// Build a log sink that routes operation lines to `service://log-line`
/// (ipc-contract.md §2.4/§2.8: git ops use `stream: "git"`, compose ops use
/// `stream: "docker"`). One line per batch — these are low-frequency
/// human-readable operation logs, not process output (which the process
/// layer batches itself).
///
/// The returned closure coerces to both `git::LogSink` and
/// `docker::LogSink` (both are `Arc<dyn Fn(&str) + Send + Sync>`).
pub(crate) fn op_log_sink(
    app: tauri::AppHandle,
    name: String,
    stream: LogStream,
) -> Arc<dyn Fn(&str) + Send + Sync> {
    Arc::new(move |line: &str| {
        app.emit_log(&ServiceLogPayload {
            name: name.clone(),
            stream,
            lines: vec![line.to_owned()],
            timestamp_ms: crate::events::now_ms(),
        });
    })
}

/// Repo/card display name for a path — its final component, used as the
/// `name` of operation log lines (matches `git::ops::repo_name` semantics).
pub(crate) fn path_basename(path: &std::path::Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}
