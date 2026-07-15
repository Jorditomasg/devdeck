//! Persistent per-distro `bash` session for WSL git READS (design doc
//! 2026-07-15-wsl-git-persistent-shell-design.md).
//!
//! Every one-shot `wsl.exe` spawn crosses the Windows↔WSL2 VM boundary
//! (~150-400 ms). Reads (`T_QUERY`/`T_FAST` — status, branch, log, diff…)
//! are frequent and short, so they stream through ONE long-lived
//! `bash --norc --noprofile` per distro instead: only the first read pays
//! the crossing. Mutations/long ops keep the one-shot `--exec` path in
//! [`super::exec`] (rare, already slow, and it preserves `kill_on_drop`
//! cancellation plus the shell-free guarantee for user-supplied refs).
//!
//! Framing: each command line is `timeout`-bounded, merges stderr into
//! stdout (`2>&1`) and ends with a nonce'd sentinel carrying `$?` — the
//! reader consumes lines until the sentinel. A wedged read dies alone
//! (exit 124 → [`GitError::Timeout`]); the session survives. An OUTER
//! tokio timeout guards the shell itself wedging; then the session is
//! killed and lazily respawned by the next read.

use crate::wsl::sq_escape;

/// Outer-timeout margin beyond the in-shell `timeout` budget, seconds.
#[cfg_attr(not(windows), allow(dead_code))]
const GRACE_SECS: u64 = 3;

/// The framed command line for one read (design doc §2):
/// `timeout -k 2 <secs> git -C '<path>' '<arg>'… 2>&1; printf '\n<sentinel>%d\n' "$?"`.
/// Every path/arg is single-quote-escaped — combined with the
/// `is_option_like` guards at the public entry points, refs can never
/// become flags or shell tokens. The printf's LEADING newline closes an
/// unterminated last output line so the sentinel always starts a line.
#[cfg_attr(not(windows), allow(dead_code))]
fn build_query_line(linux_path: &str, args: &[&str], nonce: u64, timeout_secs: u64) -> String {
    let mut line = format!(
        "timeout -k 2 {timeout_secs} git -C '{}'",
        sq_escape(linux_path)
    );
    for arg in args {
        line.push_str(" '");
        line.push_str(&sq_escape(arg));
        line.push('\'');
    }
    line.push_str(&format!(
        " 2>&1; printf '\\n__DEVDECK_END_{nonce}__%d\\n' \"$?\""
    ));
    line
}

/// Exit code of a sentinel line: the WHOLE trimmed line must be
/// `__DEVDECK_END_<nonce>__` + digits. `None` for anything else —
/// including a sentinel with another nonce.
/// ponytail: counter-nonce; a collision needs git output to print this
/// exact evolving token — accept.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_sentinel(line: &str, nonce: u64) -> Option<i32> {
    line.trim()
        .strip_prefix("__DEVDECK_END_")?
        .strip_prefix(&format!("{nonce}__"))?
        .parse()
        .ok()
}

#[cfg(windows)]
pub(crate) use live::run_query;

#[cfg(windows)]
mod live {
    use std::collections::HashMap;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, LazyLock, Mutex};
    use std::time::Duration;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
    use tokio::process::{Child, ChildStdin, ChildStdout};

    use super::super::exec::GitOutput;
    use super::super::types::GitError;
    use super::{build_query_line, GRACE_SECS};
    use crate::wsl::WslPath;

    /// One session per distro, created lazily on first read.
    /// ponytail: 1 session/distro serializes reads; add a pool of 3
    /// (matching the badge semaphore) only if measured need.
    static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// Run a git READ through the distro's persistent session (lazily
    /// created). The public entry of this module — called from
    /// [`super::super::exec::run_git`]'s Windows read short-circuit.
    pub(crate) async fn run_query(
        wsl: &WslPath,
        args: &[&str],
        timeout_secs: u64,
    ) -> Result<GitOutput, GitError> {
        let session = {
            let mut map = SESSIONS.lock().expect("git session registry poisoned");
            map.entry(wsl.distro.clone())
                .or_insert_with(|| Arc::new(Session::new(wsl.distro.clone())))
                .clone()
        };
        session.query(&wsl.linux_path, args, timeout_secs).await
    }

    /// The live pipes of a spawned session shell.
    struct Io {
        child: Child,
        stdin: ChildStdin,
        lines: Lines<BufReader<ChildStdout>>,
    }

    struct Session {
        distro: String,
        /// `None` = dead; `query` (re)spawns on demand. The mutex also
        /// serializes reads — near-native once warm, so a serialized burst
        /// of fast commands beats concurrent slow spawns.
        io: tokio::sync::Mutex<Option<Io>>,
        /// Monotonic per-session nonce for the sentinel token.
        counter: AtomicU64,
    }

    impl Session {
        fn new(distro: String) -> Self {
            Self {
                distro,
                io: tokio::sync::Mutex::new(None),
                counter: AtomicU64::new(0),
            }
        }

        /// `bash --norc --noprofile` inside the distro: reads only need
        /// system git on the default PATH; skipping rc/profile is faster
        /// and deterministic. stderr is null — each command merges its own
        /// stderr in-shell (`2>&1`), see the framing.
        /// ponytail: a distro exposing git ONLY via a custom .bashrc PATH
        /// would fail reads — not a known real setup; revisit if it appears.
        fn spawn(distro: &str) -> Result<Io, GitError> {
            let mut cmd = crate::wsl::base_command(distro);
            cmd.args(["--exec", "bash", "--norc", "--noprofile"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
            let mut child = cmd.spawn().map_err(|e| GitError::Spawn(e.to_string()))?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| GitError::Spawn("session stdin unavailable".into()))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| GitError::Spawn("session stdout unavailable".into()))?;
            Ok(Io {
                child,
                stdin,
                lines: BufReader::new(stdout).lines(),
            })
        }

        async fn query(
            &self,
            linux_path: &str,
            args: &[&str],
            timeout_secs: u64,
        ) -> Result<GitOutput, GitError> {
            let mut slot = self.io.lock().await;
            // Retry ONCE on IO error (broken pipe / EOF — e.g. the distro
            // was shut down between reads): drop the dead session, respawn.
            for attempt in 0..2 {
                if slot.is_none() {
                    *slot = Some(Self::spawn(&self.distro)?);
                }
                let io = slot.as_mut().expect("session spawned above");
                let nonce = self.counter.fetch_add(1, Ordering::Relaxed);
                let line = build_query_line(linux_path, args, nonce, timeout_secs);
                let budget = Duration::from_secs(timeout_secs + GRACE_SECS);
                match tokio::time::timeout(budget, exchange(io, &line, nonce)).await {
                    // Outer timeout: the SHELL wedged (the in-shell
                    // `timeout` would have answered within budget) — kill
                    // the session; the next read respawns it.
                    Err(_) => {
                        if let Some(mut dead) = slot.take() {
                            let _ = dead.child.start_kill();
                        }
                        return Err(GitError::Timeout(timeout_secs));
                    }
                    Ok(Ok((combined, code))) => {
                        if code == 124 {
                            // In-shell `timeout` killed the read; the
                            // session itself is fine.
                            return Err(GitError::Timeout(timeout_secs));
                        }
                        return Ok(GitOutput {
                            success: code == 0,
                            stdout: combined,
                            stderr: String::new(),
                        });
                    }
                    Ok(Err(err)) => {
                        if let Some(mut dead) = slot.take() {
                            let _ = dead.child.start_kill();
                        }
                        if attempt == 1 {
                            return Err(GitError::Spawn(err.to_string()));
                        }
                    }
                }
            }
            unreachable!("query loop returns within two attempts");
        }
    }

    /// Write one framed command, read lines until its sentinel. Returns
    /// (combined output, exit code). Any IO error / EOF means the session
    /// shell died — the caller respawns.
    async fn exchange(
        io: &mut Io,
        line: &str,
        nonce: u64,
    ) -> std::io::Result<(String, i32)> {
        io.stdin.write_all(line.as_bytes()).await?;
        io.stdin.write_all(b"\n").await?;
        io.stdin.flush().await?;
        let mut combined = String::new();
        loop {
            let Some(l) = io.lines.next_line().await? else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "wsl git session closed",
                ));
            };
            if let Some(code) = super::parse_sentinel(&l, nonce) {
                // Drop the newline the sentinel printf prepended, so the
                // output matches the one-shot path byte-for-byte.
                if combined.ends_with('\n') {
                    combined.pop();
                }
                return Ok((combined, code));
            }
            combined.push_str(&l);
            combined.push('\n');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_query_line, parse_sentinel};

    #[test]
    fn query_line_wraps_git_in_timeout_with_dash_c_path_and_sentinel() {
        assert_eq!(
            build_query_line("/home/j/api", &["status", "--porcelain"], 7, 10),
            "timeout -k 2 10 git -C '/home/j/api' 'status' '--porcelain' 2>&1; \
             printf '\\n__DEVDECK_END_7__%d\\n' \"$?\""
        );
    }

    #[test]
    fn query_line_escapes_single_quotes_in_path_and_args() {
        let line = build_query_line("/home/j/it's", &["log", "--grep=o'brien"], 0, 5);
        assert!(line.contains(r"git -C '/home/j/it'\''s'"));
        assert!(line.contains(r"'--grep=o'\''brien'"));
    }

    #[test]
    fn sentinel_parses_exit_code_for_matching_nonce_only() {
        assert_eq!(parse_sentinel("__DEVDECK_END_7__0", 7), Some(0));
        assert_eq!(parse_sentinel("  __DEVDECK_END_7__128  ", 7), Some(128));
        assert_eq!(parse_sentinel("__DEVDECK_END_8__0", 7), None); // nonce mismatch
        assert_eq!(parse_sentinel("__DEVDECK_END_7__", 7), None); // no code
        assert_eq!(parse_sentinel("__DEVDECK_END_7__1x", 7), None); // trailing junk
        assert_eq!(parse_sentinel("On branch master", 7), None); // plain output
        assert_eq!(parse_sentinel("x __DEVDECK_END_7__0", 7), None); // prefix only
    }

    #[test]
    fn nonce_71_never_matches_a_query_for_nonce_7() {
        // `7__…` must not prefix-match `71__…` — the nonce is delimited.
        assert_eq!(parse_sentinel("__DEVDECK_END_71__0", 7), None);
    }
}
