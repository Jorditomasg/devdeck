//! Interactive per-repo terminals — a PTY-backed shell the user types into
//! directly, distinct from the supervised-service spawn path in
//! [`crate::process`].
//!
//! Design: `docs/superpowers/specs/2026-06-14-terminales-pty-design.md`.
//!
//! Deliberately isolated from [`crate::process::ProcessManager`]: terminals
//! have no 6-state status machine, no `ready_pattern`, no install-vs-run
//! exclusivity. They reuse only the kill ladder ([`crate::process::kill`]).
//!
//! Module map:
//! - [`pty`]     — `portable-pty` wrapper (open / spawn / read / write / resize).
//! - [`session`] — one live PTY session: reader thread + output `Channel` + writer.
//! - [`manager`] — `HashMap<TermId, Session>` registry; `any_open()` for the
//!   app-close guard.
//! - [`shell`]   — default per-platform shell resolution.

pub mod error;
pub mod manager;
pub mod pty;
pub mod session;
pub mod shell;

pub use error::TerminalError;
pub use manager::TerminalManager;
