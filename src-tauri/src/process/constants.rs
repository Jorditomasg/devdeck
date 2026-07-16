//! Process-supervision constants, ported VERBATIM from the v1 timeout table
//! (inventory-backend.md §21.5) and the v1 spawn/stop code paths (§17, §18,
//! §21.2). Do NOT tune these without updating the migration contract.

use std::time::Duration;

// ---------------------------------------------------------------------------
// Timeouts — v1 timeout table (§21.5) + per-call-site values
// ---------------------------------------------------------------------------

/// Install wait cap: "install wait cap 600 s" (§21.5). v1 applied it to
/// `process.wait(timeout=600)` AFTER stream EOF (service_launcher.py §17.1),
/// not as a wall-clock cap — we keep that exact semantic.
pub const INSTALL_WAIT_CAP: Duration = Duration::from_secs(600);

/// After an install times out, v1 did `kill()` then `wait(5)` (§17.1).
pub const INSTALL_KILL_GRACE: Duration = Duration::from_secs(5);

/// After a service's output stream EOFs, v1 waited up to 30 s for exit, then
/// killed (gui/repo_card/_actions.py, §21.2).
pub const SERVICE_EXIT_WAIT_AFTER_EOF: Duration = Duration::from_secs(30);

/// Graceful stop wait: "service stop wait 10 s (launcher)" (§21.5, §17.2).
/// On Unix this is the SIGTERM → SIGKILL escalation window.
pub const STOP_GRACEFUL_WAIT: Duration = Duration::from_secs(10);

/// Wait after the forced kill (SIGKILL / direct-child terminate) before
/// giving up — mirrors v1's `kill()` + short wait fallback (§17.1, §18).
pub const STOP_FORCE_WAIT: Duration = Duration::from_secs(5);

/// `taskkill /F /T /PID` subprocess timeout: "taskkill 15 s" (§21.5 — the
/// launcher value; ProcessManager used 10 s, we standardize on 15 s).
pub const TASKKILL_TIMEOUT: Duration = Duration::from_secs(15);

/// Timeout for a repo-type `stop_cmd` (docker-infra `docker-compose down`).
/// v2 value: matches "compose down/stop 60 s" (§21.5, §9) since the only
/// shipped `stop_cmd` is a compose down. v1 never ran `stop_cmd` (§22.6).
pub const STOP_CMD_TIMEOUT: Duration = Duration::from_secs(60);

/// Restart-only guard: after stop, wait up to this long for the service's
/// last-known port to become bindable again before relaunching. Covers kill
/// paths where a tree member survives (or the OS releases the socket late)
/// so the relaunch doesn't die with "port already in use". v2 addition — no
/// v1 equivalent (v1 restarts raced the port exactly like the bug report).
pub const PORT_RELEASE_WAIT: Duration = Duration::from_secs(10);

/// Poll cadence for [`PORT_RELEASE_WAIT`].
pub const PORT_RELEASE_POLL: Duration = Duration::from_millis(500);

/// Total bound for `shutdown_all` on app exit. v2 decision (no v1 equivalent
/// — v1 relied on unbounded serial atexit hooks, §21.4): stops run
/// concurrently, each bounded by stop_cmd (60 s worst case) + graceful (10 s)
/// + force (5 s); anything still alive after this cap gets a best-effort
/// force-kill and we return.
pub const SHUTDOWN_ALL_CAP: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Log batching (architecture-v2.md §3.2: flush every ~50-100 ms or 64 lines)
// ---------------------------------------------------------------------------

/// Flush interval for batched `service://log-line` events.
pub const LOG_BATCH_FLUSH: Duration = Duration::from_millis(75);

/// Max lines per batch before an early flush.
pub const LOG_BATCH_MAX_LINES: usize = 64;

/// Capacity of the per-service line channel (readers → supervision loop).
pub const LINE_CHANNEL_CAPACITY: usize = 1024;

// ---------------------------------------------------------------------------
// Windows process creation flags (§21.5: every spawn uses CREATE_NO_WINDOW;
// long-lived services also CREATE_NEW_PROCESS_GROUP). Raw constants — no
// windows crate needed.
// ---------------------------------------------------------------------------

/// `CREATE_NO_WINDOW` — suppress the console window flash.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `CREATE_NEW_PROCESS_GROUP` — detach the child's console process group.
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

// ---------------------------------------------------------------------------
// Pattern fallbacks
// ---------------------------------------------------------------------------

/// Port-detection fallback regexes used when a repo type declares no
/// `port_patterns` (gui/constants.py:31-35, inventory-backend.md §20).
/// Group 1 must capture the port number; matching is case-insensitive
/// (§21.2: `re.IGNORECASE`).
pub const FALLBACK_PORT_PATTERNS: [&str; 2] = [
    r"http://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)",
    r"(?:listening on|bound to).*?port\s+(\d+)",
];

/// ANSI escape stripper, byte-for-byte the v1 regex
/// (gui/repo_card/_actions.py:13, inventory-backend.md §21.2).
pub const ANSI_ESCAPE_PATTERN: &str = r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])";

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity-pin the §21.5 table values so an accidental edit fails loudly.
    #[test]
    fn timeout_table_matches_v1_contract() {
        assert_eq!(INSTALL_WAIT_CAP.as_secs(), 600, "install wait cap is 600 s");
        assert_eq!(INSTALL_KILL_GRACE.as_secs(), 5);
        assert_eq!(SERVICE_EXIT_WAIT_AFTER_EOF.as_secs(), 30);
        assert_eq!(STOP_GRACEFUL_WAIT.as_secs(), 10, "service stop wait 10 s");
        assert_eq!(STOP_FORCE_WAIT.as_secs(), 5);
        assert_eq!(TASKKILL_TIMEOUT.as_secs(), 15, "taskkill 15 s");
        assert_eq!(STOP_CMD_TIMEOUT.as_secs(), 60, "compose down/stop 60 s");
    }

    #[test]
    fn port_release_guard_is_bounded_and_polls_sanely() {
        assert_eq!(PORT_RELEASE_WAIT.as_secs(), 10);
        assert_eq!(PORT_RELEASE_POLL.as_millis(), 500);
        assert!(PORT_RELEASE_POLL < PORT_RELEASE_WAIT);
    }

    #[test]
    fn shutdown_cap_covers_one_full_escalation() {
        // graceful + force must fit inside the total shutdown bound.
        assert!(SHUTDOWN_ALL_CAP >= STOP_GRACEFUL_WAIT + STOP_FORCE_WAIT);
    }

    #[test]
    fn log_batching_within_contract_window() {
        // architecture-v2.md §3.2: ~50-100 ms or 64 lines.
        assert!(LOG_BATCH_FLUSH.as_millis() >= 50 && LOG_BATCH_FLUSH.as_millis() <= 100);
        assert_eq!(LOG_BATCH_MAX_LINES, 64);
    }

    #[test]
    fn windows_creation_flags_are_the_winapi_values() {
        assert_eq!(CREATE_NO_WINDOW, 0x08000000);
        assert_eq!(CREATE_NEW_PROCESS_GROUP, 0x00000200);
    }
}
