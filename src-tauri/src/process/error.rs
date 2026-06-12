//! Process-supervision errors.
//!
//! v1 swallowed almost everything into `(bool, str)` tuples
//! (inventory-backend.md §5); v2 commands return `Result<T, AppError>`
//! (architecture-v2.md §3.1). This enum is the process layer's contribution —
//! the commands layer maps it onto the crate-wide `AppError`.

// TODO(integration): wire into the crate-wide AppError owned by domain/commands.

/// Errors surfaced by the process supervision layer.
#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    /// Spawn refused: the service id is already tracked and alive
    /// (v1: `[sys] <name> is already running.`, §18).
    #[error("service '{0}' is already running")]
    AlreadyRunning(String),

    /// Spawn refused: empty/blank command
    /// (v1: `[svc] No install command defined for <name>`, §17.1).
    #[error("no command defined for service '{0}'")]
    EmptyCommand(String),

    /// Spawn refused: working directory does not exist (§17.1).
    #[error("working directory does not exist: {0}")]
    InvalidWorkdir(String),

    /// The OS-level spawn failed.
    #[error("failed to spawn '{id}': {source}")]
    Spawn {
        id: String,
        #[source]
        source: std::io::Error,
    },

    /// Tree-kill failed (signal/taskkill error other than "already dead").
    #[error("failed to kill process tree (pid {pid}): {message}")]
    Kill { pid: u32, message: String },

    /// The manager is shutting down; no new spawns accepted.
    #[error("process manager is shutting down")]
    ShuttingDown,
}
