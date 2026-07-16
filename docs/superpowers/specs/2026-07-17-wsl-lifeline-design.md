# WSL Services — Lifeline Pipe (in-distro KILL_ON_JOB_CLOSE) — Design

**Date:** 2026-07-17
**Status:** Implemented
**Problem:** WSL runs deliberately get no Job Object (the tree lives inside the distro; a job on the `wsl.exe` bridge kills only the bridge). Their only kill primitive is `wsl.exe … kill -- -pgid`, which fails silently when wsl.exe is slow/wedged or the PGID marker was never captured — and on a DevDeck CRASH nothing runs at all. Orphaned Linux trees keep ports bound until the user does `wsl --shutdown`. Independently, app exit ran the FULL stop ladder per WSL service (SIGTERM crossing + 10 s grace + force + 5 s, 30 s global cap, serial leftovers) → the window froze for 10-45 s on close.

**Goal:** Every WSL service tree dies when DevDeck dies — exit, stop, or crash — with zero setup inside the distro, and app exit closes in well under a second for WSL workloads.

## Decisions (with rationale)

- **Lifeline pipe, not pid-files or an in-distro daemon.** Supervised WSL runs spawn with a PIPED stdin that DevDeck holds and never writes to. The generated bash script starts with:
  `exec 3<&0 0</dev/null; { read -r -u 3 _; kill -KILL -- -$$; } >/dev/null 2>&1 & `
  The watchdog parks on fd 3; `read` returns only on EOF — which happens when DevDeck drops the write end (stop escalation, exit fast path, deregistration) **or dies for any reason** (the OS closes the handle; the relay teardown propagates EOF). It then SIGKILLs the whole setsid group from INSIDE the distro: no wsl.exe crossing, immune to a wedged bridge, works without the PGID marker. This is the exact Linux mirror of `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Pid-file sweeps only clean up on the NEXT launch; a daemon violates the zero-install rule (see the persistent-shell design).
- **fd 3, not fd 0, for the watchdog.** Without job control (`bash -ilc`, no tty), POSIX assigns `/dev/null` to a background job's stdin — a plain `read` would fire at startup. `exec 3<&0` snapshots the real pipe first; `0</dev/null` then re-nulls the shell's own stdin so the SERVICE still sees /dev/null exactly as before (a service that reads stdin must not block on a silent pipe).
- **Watchdog stdio → /dev/null.** The background subshell must NOT inherit the run's stdout/stderr pipes: it outlives bash, and holding those write ends would prevent stream EOF — a service exiting on its own would never finalize. (Caught in review; behavior-verified.)
- **Stop ladder unchanged; lifeline severed on ForceKill.** Graceful SIGTERM courtesy stays for user-initiated stops. The force step drops the lifeline BEFORE the in-distro `kill -9`, so force no longer depends on a healthy bridge or a captured pgid.
- **Exit fast path in `shutdown_all`.** WSL runs WITHOUT a `stop_cmd` skip the ladder: sever lifeline → `wait_terminal(LIFELINE_EXIT_WAIT = 3 s)` → in-distro force kill only as belt. Runs WITH a `stop_cmd` (compose down) keep the full ladder — their cleanup is semantic, not just process death. Non-WSL runs are untouched.
- **Registry owns the write end** (`Entry.lifeline`), so its lifetime is the run's registration: normal self-exit → finalize → deregister → drop → the lone watchdog process reaps itself. No leaks between runs.

## Addendum (same day): two root causes found by lab-testing against REAL nx

Reproduced the original "restart says port 4200 in use" against nx 23 in a live
WSL distro. TWO independent production bugs surfaced:

1. **dash rejects the in-distro kill syntax.** `/bin/sh` on Ubuntu is dash, and
   dash's kill builtin fails `kill -KILL -- -pgid` with `Illegal number: -`
   (exit 2). The in-distro group kill shipped by the WSL service feature —
   graceful AND force — **never killed anything on Ubuntu**. Only the bridge
   `taskkill` worked; the Linux tree always survived. This alone explains the
   user-visible bug end to end ("graceful stop timed out", port held forever,
   `wsl --shutdown` as the only cure). Fix: the POSIX `-s SIG` form
   (`kill -s KILL -- $p -pgid`), which dash accepts (ESRCH → "No such
   process" — the success marker `signal_group_wsl` already checks).
2. **nx setsids tasks out of the group.** nx's Rust pseudo-terminal runs the
   dev server (`node-MainThread`) in its OWN session, so even a WORKING group
   kill (and the first lifeline watchdog) misses it. Fix: both the watchdog
   and `kill_group_script` now do a DESCENDANT WALK (`pgrep -P` recursion from
   the setsid root) and signal walked pids + the group. The walk catches PTY
   escapees while their parent chain is alive (it is — the nx client holds the
   PTY child). Watchdog subtlety: `s=$BASHPID` must be captured in the
   subshell BEFORE any `$( )` (a command substitution fork has its own
   BASHPID) and kills are per-pid with the group LAST — otherwise the watchdog
   SIGKILLs itself mid-loop and later pids never get signaled (lab-verified
   failure mode). ponytail: a double-forked daemon whose parent chain is gone
   still escapes the walk — only cgroups would catch it; accept.

## Verified behavior (live — real nx 23 serve tree + setsid bash)

- Sever lifeline under a running `nx run web:serve` → bash group AND the
  session-escaped PTY dev server all dead; port released (~ms).
- Fixed force script under dash kills the same full tree; stderr clean.
- Graceful `SIGTERM` to walked pids + group: nx tears down its PTY task (dev
  server exits) — graceful stop now actually works, so most stops never reach
  the force step.
- Service exits on its own → stdout EOF in ~1 ms (watchdog holds no pipes);
  watchdog reaped on lifeline drop.
- PGID marker still parsed; `ready`-pattern output unaffected.

## What does NOT change

- Non-WSL runs: stdin stays null (a never-written pipe would hang stdin-reading tools; Job Object / process group already covers them).
- `stop_cmd` runs and one-shot stop commands: no watchdog, no marker (script built with `emit_pid: false`).
- No IPC/frontend/i18n changes; timing constants only gain `LIFELINE_EXIT_WAIT` (pinned by test).
