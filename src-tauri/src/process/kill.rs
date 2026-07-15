//! Process-tree termination — v1 stop semantics (inventory-backend.md §17.2,
//! §21.3) with the POSIX self-kill bug (§22.1) fixed by design
//! (architecture-v2.md §7.1 fix 1): every child is spawned into its OWN
//! process group (`process_group(0)` in [`super::manager`]), so the group id
//! equals the child pid and signalling the group can never reach the app's
//! own process group.
//!
//! Platform mapping:
//! - **Unix**: `killpg(pid, SIGTERM)` → graceful window → `killpg(pid,
//!   SIGKILL)` (escalation windows from [`super::constants`], §21.5).
//!   `ESRCH` ("no such process") counts as success — the tree is already
//!   dead, which is the goal.
//! - **Windows**: `taskkill /F /T /PID <pid>` here is now the FALLBACK, not
//!   the primary. `TerminateJobObject` (via the per-service
//!   [`super::job::ServiceJob`], assigned right after spawn in
//!   `super::manager`) is the PRIMARY Windows tree-kill primitive whenever a
//!   valid job handle exists — both escalation ladder steps map to it, same
//!   as taskkill did before it (stop-orphan-processes design). `taskkill`
//!   below only fires when job assignment failed at spawn or
//!   `TerminateJobObject` itself errors at kill time; it is spawned with
//!   `CREATE_NO_WINDOW` like every v1 subprocess (§21.5), has no graceful
//!   mode (both ladder steps map to it the same way), and the second
//!   invocation is a no-op (exit 128) on an already-dead tree.
//!
//! Dependency note: the KILL side needs `libc` on Unix (`killpg` — std has no
//! kill-by-process-group API); the SPAWN side (`process_group(0)`) is plain
//! tokio/std and needs nothing extra. The Windows Job Object primitives
//! (`super::job`) extend the existing `windows` crate features — no new
//! crate.

use std::time::Duration;

use super::constants::{STOP_CMD_TIMEOUT, STOP_FORCE_WAIT, STOP_GRACEFUL_WAIT};
use super::error::ProcessError;

// ---------------------------------------------------------------------------
// Escalation decision logic (pure)
// ---------------------------------------------------------------------------

/// One step of the stop escalation ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscalationStep {
    /// Run the repo-type `stop_cmd` (docker-infra `docker-compose down`),
    /// bounded by `timeout`. Runs BEFORE the tree-kill safety net
    /// (architecture-v2.md §7.1 fix 4 — v1 declared but never ran it, §22.6).
    StopCmd { timeout: Duration },
    /// Graceful tree termination (SIGTERM to the group / `taskkill /F /T`),
    /// then wait up to `wait` for the supervised process to exit
    /// ("service stop wait 10 s", §17.2 / §21.5).
    Terminate { wait: Duration },
    /// Forced tree kill (SIGKILL to the group / `taskkill /F /T` again),
    /// then wait up to `wait` — v1's `kill()` fallback (§17.2).
    ForceKill { wait: Duration },
}

/// Pure decision logic driving [`super::manager::ProcessManager::stop`]:
/// optional `stop_cmd` first, then SIGTERM-with-grace, then SIGKILL
/// (§17.2 + architecture-v2.md §7.1 fixes 1 and 4).
pub fn escalation_plan(has_stop_cmd: bool) -> Vec<EscalationStep> {
    let mut plan = Vec::with_capacity(3);
    if has_stop_cmd {
        plan.push(EscalationStep::StopCmd {
            timeout: STOP_CMD_TIMEOUT,
        });
    }
    plan.push(EscalationStep::Terminate {
        wait: STOP_GRACEFUL_WAIT,
    });
    plan.push(EscalationStep::ForceKill {
        wait: STOP_FORCE_WAIT,
    });
    plan
}

// ---------------------------------------------------------------------------
// Platform primitives
// ---------------------------------------------------------------------------

/// Graceful tree termination: SIGTERM to the child's process group on Unix,
/// `taskkill /F /T` on Windows (which is inherently forceful — v1 semantics,
/// §17.2). An already-dead tree is success.
pub async fn terminate_tree(pid: u32) -> Result<(), ProcessError> {
    if pid == 0 {
        // killpg(0) would signal OUR OWN process group — the very v1 bug
        // (§22.1) this module exists to fix. Refuse loudly.
        return Err(ProcessError::Kill {
            pid,
            message: "refusing to signal pid/pgid 0 (own process group)".into(),
        });
    }
    #[cfg(unix)]
    {
        signal_group(pid, libc::SIGTERM)
    }
    #[cfg(windows)]
    {
        taskkill_tree(pid).await
    }
}

/// Forced tree kill: SIGKILL to the child's process group on Unix,
/// `taskkill /F /T` on Windows. An already-dead tree is success.
pub async fn force_kill_tree(pid: u32) -> Result<(), ProcessError> {
    if pid == 0 {
        return Err(ProcessError::Kill {
            pid,
            message: "refusing to signal pid/pgid 0 (own process group)".into(),
        });
    }
    #[cfg(unix)]
    {
        signal_group(pid, libc::SIGKILL)
    }
    #[cfg(windows)]
    {
        taskkill_tree(pid).await
    }
}

/// Signal the LINUX process group of a WSL run from Windows: the in-distro
/// equivalent of the Unix `signal_group`, executed as
/// `wsl.exe -d <distro> --exec /bin/sh -c 'kill -<SIG> -- -<pgid>'`
/// (design doc 2026-07-07-wsl-service-execution §3). "No such process"
/// counts as success — the ESRCH equivalence. Bounded by
/// [`super::constants::TASKKILL_TIMEOUT`] like taskkill.
pub async fn signal_group_wsl(distro: &str, pgid: u32, force: bool) -> Result<(), ProcessError> {
    if pgid == 0 {
        return Err(ProcessError::Kill {
            pid: pgid,
            message: "refusing to signal pgid 0 (distro-wide)".into(),
        });
    }
    #[cfg(windows)]
    {
        use super::constants::{CREATE_NO_WINDOW, TASKKILL_TIMEOUT};

        let script = crate::wsl::kill_group_script(pgid, force);
        let mut cmd = crate::wsl::base_command(distro);
        cmd.args(["--exec", "/bin/sh", "-c", &script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = tokio::time::timeout(TASKKILL_TIMEOUT, cmd.output())
            .await
            .map_err(|_| ProcessError::Kill {
                pid: pgid,
                message: format!(
                    "in-distro kill timed out after {}s",
                    TASKKILL_TIMEOUT.as_secs()
                ),
            })?
            .map_err(|e| ProcessError::Kill {
                pid: pgid,
                message: format!("failed to spawn wsl.exe for kill: {e}"),
            })?;

        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.success() || stderr.contains("No such process") {
            return Ok(()); // killed, or tree already dead — mission done
        }
        Err(ProcessError::Kill {
            pid: pgid,
            message: format!(
                "in-distro kill exited with {:?}: {}",
                output.status.code(),
                stderr.trim()
            ),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (distro, force);
        Err(ProcessError::Kill {
            pid: pgid,
            message: "WSL in-distro kill is Windows-only".into(),
        })
    }
}

/// Signal the process GROUP whose id equals `pid` (guaranteed by
/// `process_group(0)` at spawn). `ESRCH` ⇒ already dead ⇒ `Ok`.
#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) -> Result<(), ProcessError> {
    // SAFETY: killpg is async-signal-safe and has no memory preconditions;
    // we only pass a pid we obtained from a child we spawned.
    let rc = unsafe { libc::killpg(pid as libc::pid_t, signal) };
    if rc == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        return Ok(()); // group already gone — the tree is dead, mission done
    }
    Err(ProcessError::Kill {
        pid,
        message: err.to_string(),
    })
}

/// `taskkill /F /T /PID <pid>` — force-kills the ENTIRE tree (shell + mvn +
/// JVM + node…, §17.2), bounded by the §21.5 "taskkill 15 s" timeout.
/// Exit 0 (killed) and exit 128 (no such process) both count as success.
#[cfg(windows)]
async fn taskkill_tree(pid: u32) -> Result<(), ProcessError> {
    use super::constants::{CREATE_NO_WINDOW, TASKKILL_TIMEOUT};

    let mut cmd = tokio::process::Command::new("taskkill");
    cmd.args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // CREATE_NO_WINDOW on every Windows spawn (§21.5).
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = tokio::time::timeout(TASKKILL_TIMEOUT, cmd.output())
        .await
        .map_err(|_| ProcessError::Kill {
            pid,
            message: format!("taskkill timed out after {}s", TASKKILL_TIMEOUT.as_secs()),
        })?
        .map_err(|e| ProcessError::Kill {
            pid,
            message: format!("failed to spawn taskkill: {e}"),
        })?;

    match output.status.code() {
        Some(0) | Some(128) => Ok(()),
        code => Err(ProcessError::Kill {
            pid,
            message: format!(
                "taskkill exited with {code:?}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_without_stop_cmd_is_terminate_then_force() {
        assert_eq!(
            escalation_plan(false),
            vec![
                EscalationStep::Terminate {
                    wait: STOP_GRACEFUL_WAIT
                },
                EscalationStep::ForceKill {
                    wait: STOP_FORCE_WAIT
                },
            ]
        );
    }

    #[test]
    fn plan_with_stop_cmd_runs_it_before_the_tree_kill_safety_net() {
        let plan = escalation_plan(true);
        assert_eq!(plan.len(), 3);
        assert_eq!(
            plan[0],
            EscalationStep::StopCmd {
                timeout: STOP_CMD_TIMEOUT
            },
            "stop_cmd must run FIRST (architecture-v2.md §7.1 fix 4)"
        );
        assert_eq!(&plan[1..], &escalation_plan(false)[..]);
    }

    /// Pin the §21.5 escalation windows so an accidental edit fails loudly.
    #[test]
    fn plan_timeouts_match_the_v1_contract() {
        let plan = escalation_plan(true);
        assert_eq!(
            plan,
            vec![
                EscalationStep::StopCmd {
                    timeout: Duration::from_secs(60)
                },
                EscalationStep::Terminate {
                    wait: Duration::from_secs(10)
                },
                EscalationStep::ForceKill {
                    wait: Duration::from_secs(5)
                },
            ]
        );
    }

    #[tokio::test]
    async fn pid_zero_is_refused() {
        // killpg(0) / taskkill PID 0 would target our own group — must error.
        assert!(terminate_tree(0).await.is_err());
        assert!(force_kill_tree(0).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn signaling_a_nonexistent_group_is_not_an_error() {
        // Far above the default Linux pid_max (4194304) — guaranteed ESRCH,
        // which means "already dead" and must be treated as success.
        assert!(terminate_tree(99_999_999).await.is_ok());
        assert!(force_kill_tree(99_999_999).await.is_ok());
    }

    #[tokio::test]
    async fn wsl_kill_refuses_pgid_zero() {
        // pgid 0 would signal the distro's own group at large — same guard as
        // terminate_tree/force_kill_tree.
        assert!(signal_group_wsl("Ubuntu", 0, false).await.is_err());
        assert!(signal_group_wsl("Ubuntu", 0, true).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn wsl_kill_is_windows_only() {
        assert!(signal_group_wsl("Ubuntu", 4242, false).await.is_err());
    }
}
