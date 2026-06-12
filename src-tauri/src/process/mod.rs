//! Subprocess supervision — the ONLY module that spawns service/install
//! processes (git/docker own their domain-specific subprocesses).
//!
//! Replaces `core/service_launcher.py`, `infrastructure/process/
//! process_manager.py` AND the spawning the v1 GUI did itself
//! (inventory-backend.md §17, §18, §21). Responsibilities:
//! - Spawn services with merged stdout+stderr, UTF-8 lossy line streaming,
//!   ANSI stripping; batch lines into `events::SERVICE_LOG_LINE`.
//! - Drive the `starting → running | error → stopped` state machine from
//!   `ready_pattern` / `error_pattern`, detect ports via `port_patterns` plus
//!   the fallback regexes (inventory-backend.md §21.2), emit
//!   `events::SERVICE_STATUS_CHANGED`.
//! - Stop semantics (§17.2) with the v1 POSIX bug fixed by design
//!   (architecture-v2.md §7.1): every child gets its OWN process group
//!   (`process_group(0)`/setsid) and stop kills that group with SIGTERM →
//!   SIGKILL escalation; Windows keeps `taskkill /F /T` tree-kill semantics.
//!   Honors the now-implemented `stop_cmd` for docker-infra repos.
//! - Install runner with the 10-minute cap and installed-check via
//!   `ui.install.check_dirs` (§17.1); JAVA_HOME env injection from `java/`.
//! - Stop-all on app exit (the v1 atexit contract, §21.4) wired to Tauri's
//!   exit lifecycle.

pub mod constants;
pub mod error;
pub mod kill;
pub mod line_machine;
pub mod manager;
pub mod types;

pub use error::ProcessError;
pub use kill::{escalation_plan, EscalationStep};
pub use manager::{is_installed, ProcessManager};
pub use types::{
    service_id, InstallSpec, RunKind, ServiceSnapshot, ServiceSpec, StopCommand, StopOutcome,
};
