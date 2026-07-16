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

## Verified behavior (live, setsid bash — identical semantics in-distro)

- Sever lifeline while tree runs → whole group (incl. `sleep 30`) SIGKILLed in ~1 ms.
- Service exits on its own → stdout EOF in ~1 ms (watchdog holds no pipes); watchdog reaped on lifeline drop.
- PGID marker still parsed; `ready`-pattern output unaffected.

## What does NOT change

- Non-WSL runs: stdin stays null (a never-written pipe would hang stdin-reading tools; Job Object / process group already covers them).
- `stop_cmd` runs and one-shot stop commands: no watchdog, no marker (script built with `emit_pid: false`).
- No IPC/frontend/i18n changes; timing constants only gain `LIFELINE_EXIT_WAIT` (pinned by test).
