//! THE error→envelope mapping (ipc-contract.md §1.3) — the single place
//! where module errors become the serializable `{ kind, message }` shape a
//! failed `invoke` rejects with.
//!
//! Kinds are extend-only, never renamed:
//! `configuration | detection | io | yaml_parse | json_parse | migration |
//! no_os_directory` (from [`DomainError::kind`]), `git`, `docker`,
//! `process`, `profile`, `invalid_args`.

use serde::Serialize;

use crate::docker::DockerError;
use crate::domain::DomainError;
use crate::git::GitError;
use crate::process::ProcessError;
use crate::profiles::ProfileError;

/// Result alias used by every command handler.
pub type CmdResult<T> = Result<T, AppError>;

/// The IPC error envelope (ipc-contract.md §1.3). A rejected `invoke`
/// promise carries exactly this object; the frontend maps `kind` to i18n
/// keys (architecture-v2.md §3.1).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppError {
    pub kind: String,
    pub message: String,
}

impl AppError {
    /// Command-layer input validation failure (`kind: "invalid_args"`).
    pub fn invalid_args(message: impl Into<String>) -> Self {
        AppError {
            kind: "invalid_args".into(),
            message: message.into(),
        }
    }

    /// Process-layer failure raised by the command itself (e.g. "unknown
    /// service id" before a spec can be built — ipc-contract.md §2.3).
    pub fn process(message: impl Into<String>) -> Self {
        AppError {
            kind: "process".into(),
            message: message.into(),
        }
    }

    /// Profile-layer failure raised by the command itself (e.g. a panicked
    /// blocking snapshot task — ipc-contract.md §2.7).
    pub fn profile(message: impl Into<String>) -> Self {
        AppError {
            kind: "profile".into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.kind, self.message)
    }
}

impl From<DomainError> for AppError {
    fn from(err: DomainError) -> Self {
        AppError {
            kind: err.kind().to_owned(),
            message: err.to_string(),
        }
    }
}

impl From<GitError> for AppError {
    fn from(err: GitError) -> Self {
        AppError {
            kind: "git".into(),
            message: err.to_string(),
        }
    }
}

impl From<DockerError> for AppError {
    fn from(err: DockerError) -> Self {
        AppError {
            kind: "docker".into(),
            message: err.to_string(),
        }
    }
}

impl From<ProcessError> for AppError {
    fn from(err: ProcessError) -> Self {
        AppError {
            kind: "process".into(),
            message: err.to_string(),
        }
    }
}

impl From<ProfileError> for AppError {
    fn from(err: ProfileError) -> Self {
        AppError {
            kind: "profile".into(),
            message: err.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_kind_message_envelope() {
        let err = AppError::invalid_args("missing path");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json, serde_json::json!({
            "kind": "invalid_args",
            "message": "missing path"
        }));
    }

    #[test]
    fn domain_errors_keep_their_stable_kind() {
        let err: AppError = DomainError::Configuration("x".into()).into();
        assert_eq!(err.kind, "configuration");
        let err: AppError = DomainError::Migration("x".into()).into();
        assert_eq!(err.kind, "migration");
        let err: AppError = DomainError::YamlParse {
            path: "a.yml".into(),
            message: "bad".into(),
        }
        .into();
        assert_eq!(err.kind, "yaml_parse");
        assert!(err.message.contains("a.yml"));
    }

    #[test]
    fn module_errors_map_to_their_group_kind() {
        let err: AppError = GitError::Timeout(60).into();
        assert_eq!(err.kind, "git");

        let err: AppError = ProcessError::AlreadyRunning("svc".into()).into();
        assert_eq!(err.kind, "process");
        assert!(err.message.contains("svc"));

        let err: AppError = ProfileError::MissingReposKey.into();
        assert_eq!(err.kind, "profile");
    }
}
