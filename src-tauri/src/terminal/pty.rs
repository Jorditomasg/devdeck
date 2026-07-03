//! Thin wrapper over `portable-pty`: open a pseudo-terminal, spawn a shell in
//! it, and expose the master end's reader / writer / resize / pid.
//!
//! Why a PTY and not the pipe-based [`crate::process`] spawn: an interactive
//! terminal needs a real TTY. Without one, programs detect a non-tty and
//! disable interactivity (no prompt, no line editing, no colours). The pipe
//! path in `process/` is for *observing* supervised services; this is for a
//! human typing commands.
//!
//! Kill model reuse: on Unix `portable-pty` spawns the child in its own
//! session (its pgid equals the child pid), so the existing
//! [`crate::process::kill::force_kill_tree`] (`killpg`) tears down the whole
//! tree. On Windows the child pid feeds the same `taskkill /F /T`.
//!
//! Blocking IO note: the reader/writer returned here are blocking
//! `std::io::{Read, Write}`. The session layer must drive them on a blocking
//! thread (`tokio::task::spawn_blocking`), never on the async runtime.

use std::io::{Read, Write};
use std::path::Path;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use super::error::TerminalError;

/// An open pseudo-terminal with a shell running inside it.
pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Pty {
    /// Open a PTY of `cols`×`rows` and spawn `shell` with working directory
    /// `cwd`. The slave handle is dropped right after spawn so reads on the
    /// master observe EOF once the child exits (otherwise reads can block
    /// forever on some platforms).
    pub fn spawn(
        shell: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<Self, TerminalError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::Pty(format!("openpty: {e}")))?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| TerminalError::Pty(format!("spawn shell {shell:?}: {e}")))?;

        // Drop the slave: keeps the master's read EOF correct on child exit.
        drop(pair.slave);

        Ok(Self {
            master: pair.master,
            child,
        })
    }

    /// A blocking reader over the PTY output. Cloneable independently of the
    /// writer; drive on a blocking thread.
    pub fn reader(&self) -> Result<Box<dyn Read + Send>, TerminalError> {
        self.master
            .try_clone_reader()
            .map_err(|e| TerminalError::Pty(format!("clone reader: {e}")))
    }

    /// The blocking writer into the PTY input (keystrokes). Can only be taken
    /// once per PTY.
    pub fn writer(&self) -> Result<Box<dyn Write + Send>, TerminalError> {
        self.master
            .take_writer()
            .map_err(|e| TerminalError::Pty(format!("take writer: {e}")))
    }

    /// Resize the PTY viewport (xterm fit → SIGWINCH to the shell).
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::Pty(format!("resize: {e}")))
    }

    /// PID of the shell process — the handle the kill ladder signals
    /// (`force_kill_tree`). `None` once the child has been reaped.
    pub fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    /// Spike smoke test: a PTY opens, a shell spawns, and it reports a pid.
    /// This exercises `portable-pty` at runtime on the host; the cross-compile
    /// link check (the real gate) is a Windows `cargo build`, run separately.
    #[cfg(unix)]
    #[test]
    fn opens_a_pty_and_spawns_a_shell() {
        let pty = Pty::spawn("/bin/sh", Path::new("/"), 80, 24).expect("spawn pty");
        assert!(pty.pid().is_some(), "shell should report a pid");
        assert!(pty.reader().is_ok());
        assert!(pty.resize(100, 30).is_ok());
        // Teardown: dropping the master sends SIGHUP to the shell, which has
        // no stdin attached (slave already dropped) and exits on its own.
        drop(pty);
    }
}
