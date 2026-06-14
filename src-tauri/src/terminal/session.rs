//! One live PTY-backed terminal session: a reader thread pumping raw PTY
//! output to a Tauri `Channel`, plus a writer for keystrokes and resize.
//!
//! Transport rationale (design doc §"Transporte"): output goes through a
//! per-session `Channel` carrying RAW bytes (`InvokeResponseBody::Raw`), NOT
//! the line-batched/ANSI-stripped `service://log-line` bus. xterm.js needs the
//! escape sequences intact, and a point-to-point channel avoids broadcasting
//! every terminal's bytes to every other terminal window.
//!
//! Pre-attach race: the PTY emits its first prompt before the freshly created
//! webview can hand over its `Channel`. Output is buffered in a bounded ring
//! until [`Session::attach`], then flushed and switched to live streaming.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};

use super::error::TerminalError;
use super::pty::Pty;

/// Bytes buffered before the webview attaches. Generous enough for a shell's
/// startup banner + first prompt; oldest bytes are dropped past the cap.
const PRE_ATTACH_BUFFER_CAP: usize = 256 * 1024;

/// PTY output destination: a bounded buffer until the webview attaches, then
/// the live channel.
enum Sink {
    Buffering(VecDeque<u8>),
    Attached(Channel<InvokeResponseBody>),
}

impl Sink {
    /// Forward a chunk of PTY output — buffer it (ring) or send it live.
    fn push(&mut self, bytes: &[u8]) {
        match self {
            Sink::Buffering(buf) => {
                let projected = buf.len() + bytes.len();
                if projected > PRE_ATTACH_BUFFER_CAP {
                    let overflow = (projected - PRE_ATTACH_BUFFER_CAP).min(buf.len());
                    buf.drain(..overflow);
                }
                buf.extend(bytes.iter().copied());
            }
            Sink::Attached(channel) => {
                let _ = channel.send(InvokeResponseBody::Raw(bytes.to_vec()));
            }
        }
    }
}

/// A PTY with a shell running inside it, wired for bidirectional IO.
pub struct Session {
    pty: Pty,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    sink: Arc<Mutex<Sink>>,
    pid: Option<u32>,
}

impl Session {
    /// Spawn `shell` in a PTY rooted at `cwd`, start the reader thread, and
    /// return the session buffering output until [`Session::attach`].
    pub fn spawn(
        shell: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<Self, TerminalError> {
        let pty = Pty::spawn(shell, cwd, cols, rows)?;
        let pid = pty.pid();
        let writer = Arc::new(Mutex::new(pty.writer()?));
        let mut reader = pty.reader()?;
        let sink = Arc::new(Mutex::new(Sink::Buffering(VecDeque::new())));

        // Reader thread: blocking reads off the PTY master (the reader/writer
        // from `portable-pty` are blocking std IO — never drive them on the
        // async runtime). Ends on EOF (shell exit) or read error.
        let reader_sink = Arc::clone(&sink);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut sink) = reader_sink.lock() {
                            sink.push(&chunk[..n]);
                        }
                    }
                }
            }
        });

        Ok(Session {
            pty,
            writer,
            sink,
            pid,
        })
    }

    /// Bind the webview's output channel: flush the pre-attach buffer, then
    /// switch to live streaming.
    pub fn attach(&self, channel: Channel<InvokeResponseBody>) {
        let mut sink = self.sink.lock().expect("terminal sink poisoned");
        if let Sink::Buffering(buf) = &mut *sink {
            if !buf.is_empty() {
                let backlog: Vec<u8> = buf.drain(..).collect();
                let _ = channel.send(InvokeResponseBody::Raw(backlog));
            }
        }
        *sink = Sink::Attached(channel);
    }

    /// Write keystroke bytes to the PTY input.
    pub fn write(&self, bytes: &[u8]) -> Result<(), TerminalError> {
        let mut writer = self.writer.lock().expect("terminal writer poisoned");
        writer
            .write_all(bytes)
            .map_err(|e| TerminalError::Pty(format!("write: {e}")))?;
        writer
            .flush()
            .map_err(|e| TerminalError::Pty(format!("flush: {e}")))
    }

    /// Resize the PTY viewport (xterm fit → SIGWINCH).
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        self.pty.resize(cols, rows)
    }

    /// PID of the shell — the handle the kill ladder signals on close.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }
}
