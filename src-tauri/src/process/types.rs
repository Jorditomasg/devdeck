//! Local types for the process layer.
//!
//! These intentionally duplicate slices of the (concurrently developed)
//! domain model so this module compiles standalone.
// TODO(integration): unify with crate::domain (`RepoInfo` command fields,
// `RunningService`) once the domain agent lands its models. The commands
// layer should build `ServiceSpec` / `InstallSpec` from `RepoInfo` +
// per-card overrides (custom command, Java env).

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;

use crate::events::ServiceStatus;

/// Build the canonical service id: `"repo"` or `"repo::module"` —
/// the v1 config-key convention (inventory-backend.md §8.3).
pub fn service_id(repo: &str, module: Option<&str>) -> String {
    match module {
        Some(m) if !m.is_empty() => format!("{repo}::{m}"),
        _ => repo.to_owned(),
    }
}

/// `true` for statuses that mean "this run is over".
pub fn is_terminal(status: ServiceStatus) -> bool {
    matches!(status, ServiceStatus::Stopped | ServiceStatus::Error)
}

/// Everything needed to start a long-lived service
/// (inventory-backend.md §21.1-21.2).
#[derive(Debug, Clone)]
pub struct ServiceSpec {
    /// Service id (`"repo"` or `"repo::module"`).
    pub id: String,
    /// Shell command string — the resolved `run_command` or the user's
    /// custom command. Executed through the platform shell, like v1's
    /// `shell=True` (§21.1).
    pub command: String,
    /// Working directory (the repo path).
    pub cwd: PathBuf,
    /// Environment OVERRIDES applied on top of the inherited environment
    /// (e.g. `JAVA_HOME` + prepended `PATH` from the java layer, §13).
    pub env: HashMap<String, String>,
    /// Regex: log line meaning "service ready" (YAML `commands.ready_pattern`).
    /// `None` ⇒ jump straight to `running` after spawn (§21.2).
    pub ready_pattern: Option<String>,
    /// Regex: log line meaning "startup failed" (`commands.error_pattern`).
    pub error_pattern: Option<String>,
    /// Port-extraction regexes (group 1 = port). Empty ⇒ the fallback list
    /// (`constants::FALLBACK_PORT_PATTERNS`).
    pub port_patterns: Vec<String>,
    /// Statically-known port (`RepoInfo.server_port`); when set, log-based
    /// port detection is skipped (§21.2).
    pub known_port: Option<u16>,
    /// Repo-type `stop_cmd` (docker-infra: `docker-compose down`). v1
    /// declared but never ran it (§22.6); v2 runs it on stop, BEFORE the
    /// tree-kill safety net (architecture-v2.md §7.4).
    pub stop_cmd: Option<String>,
}

/// Everything needed to run an install/reinstall command
/// (inventory-backend.md §17.1).
#[derive(Debug, Clone)]
pub struct InstallSpec {
    /// Service id — shares the registry with services, so an install and a
    /// run of the same repo are mutually exclusive (v1 §17.1 "refuses if
    /// already running").
    pub id: String,
    /// Shell command string (`install_cmd` / `reinstall_cmd`).
    pub command: String,
    pub cwd: PathBuf,
    /// Environment overrides (Java env when a JDK is selected).
    pub env: HashMap<String, String>,
}

/// What kind of run a registry entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunKind {
    Service,
    Install,
}

/// A `stop_cmd` ready to execute (command + the service's cwd/env).
#[derive(Debug, Clone)]
pub struct StopCommand {
    pub command: String,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
}

/// Outcome of [`super::manager::ProcessManager::stop`].
///
/// v1 collapsed "untracked" and "already finishing" into the same `False`
/// (§17.2), which made callers run the untracked `stop_cmd` fallback for a
/// crashed-but-still-registered compose run. v2 distinguishes them so the
/// fallback fires ONLY when the id is genuinely untracked
/// (ipc-contract.md §2.3 #4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    /// A live run was found and the escalation ladder ran (even on the
    /// force path — v1 "still marked stopped, return True", §17.2).
    Stopped,
    /// Tracked, but the run already reached a terminal status — nothing to
    /// kill, and the repo's `stop_cmd` already had its chance.
    AlreadyTerminal,
    /// Not in the registry at all (e.g. a detached docker-infra stack after
    /// an app restart) — the caller may run the untracked `stop_cmd`
    /// fallback.
    Untracked,
}

/// Live state shared between the supervision task and the registry via a
/// `tokio::sync::watch` channel.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimeState {
    pub status: ServiceStatus,
    pub port: Option<u16>,
    /// Kept for watch-channel observers; the terminal status event carries it
    /// to the frontend, queries read status/port only.
    #[allow(dead_code)]
    pub exit_code: Option<i32>,
}

/// Snapshot of one tracked service for queries / the commands layer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    pub id: String,
    pub status: ServiceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_id_plain_repo() {
        assert_eq!(service_id("spring-petclinic", None), "spring-petclinic");
        assert_eq!(service_id("spring-petclinic", Some("")), "spring-petclinic");
    }

    #[test]
    fn service_id_with_module_uses_double_colon() {
        assert_eq!(
            service_id("spring-petclinic", Some("src/main/resources")),
            "spring-petclinic::src/main/resources"
        );
    }

    #[test]
    fn terminal_statuses() {
        assert!(is_terminal(ServiceStatus::Stopped));
        assert!(is_terminal(ServiceStatus::Error));
        assert!(!is_terminal(ServiceStatus::Starting));
        assert!(!is_terminal(ServiceStatus::Installing));
        assert!(!is_terminal(ServiceStatus::Running));
    }
}
