//! Terminal session registry — `HashMap<TermId, Session>` keyed by id, plus a
//! per-repo monotonic id counter.
//!
//! Deliberately separate from [`crate::process::ProcessManager`] (design doc):
//! terminals have no status machine. The only shared machinery is the kill
//! ladder ([`crate::process::kill::force_kill_tree`]) — on Unix the PTY child
//! is its own session leader (pgid == pid), so signalling the group tears down
//! the whole tree; on Windows the pid feeds `taskkill /F /T`.
//!
//! Locking: the sessions/counters mutexes are never held across an `.await`
//! (state.rs concurrency contract). `close`/`close_all` remove sessions under
//! the lock, release it, then await the kill.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};

use crate::process::kill::force_kill_tree;

use super::error::TerminalError;
use super::session::Session;

/// Live terminal sessions and per-repo id counters.
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Session>>,
    counters: Mutex<HashMap<String, u64>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        TerminalManager {
            sessions: Mutex::new(HashMap::new()),
            counters: Mutex::new(HashMap::new()),
        }
    }

    /// Allocate the next id for `repo`: `<repo>::term::<n>`, monotonic per repo
    /// (never reused, so window labels never collide). Mirrors the existing
    /// `repo::module` service-id convention.
    pub fn next_id(&self, repo: &str) -> String {
        let mut counters = self.counters.lock().expect("terminal counters poisoned");
        let n = counters.entry(repo.to_string()).or_insert(0);
        *n += 1;
        format!("{repo}::term::{n}")
    }

    /// Spawn a PTY session under `id` (buffering output until `attach`).
    pub fn open(
        &self,
        id: &str,
        shell: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        let session = Session::spawn(shell, cwd, cols, rows)?;
        self.sessions
            .lock()
            .expect("terminal sessions poisoned")
            .insert(id.to_string(), session);
        Ok(())
    }

    /// Bind the webview's output channel to session `id`.
    pub fn attach(
        &self,
        id: &str,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().expect("terminal sessions poisoned");
        sessions
            .get(id)
            .ok_or_else(|| TerminalError::Unknown(id.to_string()))?
            .attach(channel);
        Ok(())
    }

    /// Forward keystroke bytes to session `id`.
    pub fn write(&self, id: &str, bytes: &[u8]) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().expect("terminal sessions poisoned");
        sessions
            .get(id)
            .ok_or_else(|| TerminalError::Unknown(id.to_string()))?
            .write(bytes)
    }

    /// Resize session `id`.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let sessions = self.sessions.lock().expect("terminal sessions poisoned");
        sessions
            .get(id)
            .ok_or_else(|| TerminalError::Unknown(id.to_string()))?
            .resize(cols, rows)
    }

    /// Close session `id`: remove it from the registry and force-kill its
    /// process tree. No-op when already gone.
    pub async fn close(&self, id: &str) {
        let session = self
            .sessions
            .lock()
            .expect("terminal sessions poisoned")
            .remove(id);
        if let Some(session) = session {
            if let Some(pid) = session.pid() {
                let _ = force_kill_tree(pid).await;
            }
        }
    }

    /// True while any terminal session is open — gates the app-close guard
    /// alongside [`crate::state::TrayStatus::any_active`].
    pub fn any_open(&self) -> bool {
        !self
            .sessions
            .lock()
            .expect("terminal sessions poisoned")
            .is_empty()
    }

    /// Kill every session (app-exit cleanup, the atexit contract).
    pub async fn close_all(&self) {
        let drained: Vec<Session> = {
            let mut sessions = self.sessions.lock().expect("terminal sessions poisoned");
            sessions.drain().map(|(_, session)| session).collect()
        };
        for session in drained {
            if let Some(pid) = session.pid() {
                let _ = force_kill_tree(pid).await;
            }
        }
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_monotonic_per_repo() {
        let mgr = TerminalManager::new();
        assert_eq!(mgr.next_id("api"), "api::term::1");
        assert_eq!(mgr.next_id("api"), "api::term::2");
        assert_eq!(mgr.next_id("web"), "web::term::1");
        assert_eq!(mgr.next_id("api"), "api::term::3");
    }

    #[test]
    fn unknown_terminal_is_an_error() {
        let mgr = TerminalManager::new();
        assert!(matches!(
            mgr.write("api::term::1", b"x"),
            Err(TerminalError::Unknown(_))
        ));
        assert!(matches!(
            mgr.resize("api::term::1", 80, 24),
            Err(TerminalError::Unknown(_))
        ));
    }

    #[test]
    fn empty_registry_reports_nothing_open() {
        let mgr = TerminalManager::new();
        assert!(!mgr.any_open());
    }
}
