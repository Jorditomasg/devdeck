//! Error type for the interactive terminal subsystem.

use thiserror::Error;

/// Failures from the PTY layer and terminal session management. Kept separate
/// from [`crate::process::error::ProcessError`] because terminals are a
/// distinct subsystem (interactive PTY, no supervised state machine) — see
/// `docs/superpowers/specs/2026-06-14-terminales-pty-design.md`.
#[derive(Debug, Error)]
pub enum TerminalError {
    /// Underlying PTY operation failed (openpty / spawn / resize / io). The
    /// message carries the `portable-pty` (anyhow) error text.
    #[error("pty: {0}")]
    Pty(String),

    /// A command referenced a terminal id that is not in the registry (already
    /// closed, or never opened).
    #[error("unknown terminal: {0}")]
    Unknown(String),
}
