//! Service lifecycle state machine.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// The 6-state service lifecycle model.
///
/// Wire format (the exact lowercase strings the Angular frontend expects):
/// `"stopped"`, `"starting"`, `"running"`, `"stopping"`, `"installing"`,
/// `"error"`.
///
/// v1 used free strings and only ever emitted 4 of these
/// (`starting`/`running`/`stopped`/`error`, inventory-backend.md §3, §4.1);
/// `Stopping` and `Installing` are v2 additions so the UI can render
/// transitional states without the GUI-side boolean flags v1 used
/// (`_is_stopping_manually`, install-in-progress tracking).
///
/// State machine (driven by the `process/` layer):
/// `Stopped → Starting → Running → Stopping → Stopped`, with `Error` reachable
/// from `Starting` (via `error_pattern` or early exit) and from a failed stop;
/// `Installing → Stopped | Error` for dependency installs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    /// Not running (also the state of a never-started service).
    #[default]
    Stopped,
    /// Spawned, waiting for `ready_pattern` (or instant `Running` when the
    /// repo type declares no ready pattern — inventory-backend.md §21.2).
    Starting,
    /// Ready pattern matched (or no pattern declared).
    Running,
    /// Stop requested; process tree teardown in progress.
    Stopping,
    /// Dependency install (`install_cmd`/`reinstall_cmd`) in progress.
    Installing,
    /// Startup failed, process died while `Starting`, or stop force-killed
    /// on timeout.
    Error,
}

impl ServiceStatus {
    /// The wire string for this status (same as the serde representation).
    pub fn as_str(&self) -> &'static str {
        match self {
            ServiceStatus::Stopped => "stopped",
            ServiceStatus::Starting => "starting",
            ServiceStatus::Running => "running",
            ServiceStatus::Stopping => "stopping",
            ServiceStatus::Installing => "installing",
            ServiceStatus::Error => "error",
        }
    }

    /// True for states in which the underlying OS process is expected alive.
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            ServiceStatus::Starting
                | ServiceStatus::Running
                | ServiceStatus::Stopping
                | ServiceStatus::Installing
        )
    }
}

impl fmt::Display for ServiceStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ServiceStatus {
    type Err = String;

    /// Case-insensitive parse of the wire strings (accepts everything v1
    /// ever persisted/emitted as free strings).
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "stopped" => Ok(ServiceStatus::Stopped),
            "starting" => Ok(ServiceStatus::Starting),
            "running" => Ok(ServiceStatus::Running),
            "stopping" => Ok(ServiceStatus::Stopping),
            "installing" => Ok(ServiceStatus::Installing),
            "error" => Ok(ServiceStatus::Error),
            other => Err(format!("unknown service status: '{other}'")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_expected_wire_strings() {
        let cases = [
            (ServiceStatus::Stopped, "\"stopped\""),
            (ServiceStatus::Starting, "\"starting\""),
            (ServiceStatus::Running, "\"running\""),
            (ServiceStatus::Stopping, "\"stopping\""),
            (ServiceStatus::Installing, "\"installing\""),
            (ServiceStatus::Error, "\"error\""),
        ];
        for (status, wire) in cases {
            assert_eq!(serde_json::to_string(&status).unwrap(), wire);
            let back: ServiceStatus = serde_json::from_str(wire).unwrap();
            assert_eq!(back, status);
        }
    }

    #[test]
    fn parses_v1_free_strings() {
        assert_eq!("running".parse::<ServiceStatus>().unwrap(), ServiceStatus::Running);
        assert_eq!("STOPPED".parse::<ServiceStatus>().unwrap(), ServiceStatus::Stopped);
        assert!("bogus".parse::<ServiceStatus>().is_err());
    }

    #[test]
    fn default_is_stopped_and_inactive() {
        assert_eq!(ServiceStatus::default(), ServiceStatus::Stopped);
        assert!(!ServiceStatus::Stopped.is_active());
        assert!(ServiceStatus::Installing.is_active());
    }
}
