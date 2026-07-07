# WSL Service Execution — Design

**Date:** 2026-07-07
**Status:** Approved
**Problem:** A repo addressed via a WSL UNC share (`\\wsl.localhost\<distro>\...`) cannot be started from DevDeck. cmd.exe rejects UNC working directories ("No se permiten rutas UNC") and falls back to `C:\Windows`, and even with a cwd workaround the WINDOWS toolchain would run against a Linux-built `node_modules`. Git already routes into the distro (`git/exec.rs`); start/stop/install/docker do not.

**Goal:** For WSL repos, run EVERYTHING the ProcessManager and docker module execute *inside the distro* — start command, auto-install, `stop_cmd`, and docker compose polling — with a kill path that reliably terminates the Linux process tree. Activation is automatic by path shape, exactly like git routing. No new IPC commands, no config toggles, no frontend changes.

## Decisions (with rationale)

- **Toolchain discovery: `bash -ilc`.** User's distros are mixed (nvm / system / unknown). Ubuntu's `.bashrc` interactivity guard (`case $- in *i*)`) returns before nvm init in non-interactive shells, so `-i` is required, not optional. Known cost: bash without a tty emits two stderr noise lines ("cannot set terminal process group", "no job control in this shell") — the output reader filters them for WSL runs.
- **Scope: start + install + stop_cmd + docker.** Chosen by the user, including docker (native docker inside the distro must work, not only Docker Desktop).
- **Mechanism: per-operation `wsl.exe` + captured Linux PID** (approach A). A resident supervision daemon inside the distro was considered and rejected: it adds install/versioning/IPC lifecycle for a capability (surviving app restarts) DevDeck does not offer on any platform. `pkill -f` matching was rejected: two repos with `npm start` would kill each other.
- **The `pushd` UNC palliative in `build_command` is removed.** With real routing, UNC paths never reach `cmd /C`; the branch would be dead code.

## 1. Shared module `src-tauri/src/wsl.rs`

Move from `git/exec.rs` (with their unit tests): `WslPath { distro, linux_path }`, `parse_wsl_path`, `wsl_path_for` (Windows-only; always `None` elsewhere). Add `wsl_base_command(distro) -> Command` centralizing `wsl.exe` + `WSL_UTF8=1` (wsl.exe's own diagnostics are UTF-16 without it). Consumers: `git/exec.rs` (existing behavior, unchanged semantics), `process/manager.rs`, `process/kill.rs`, `docker/exec.rs`.

## 2. Spawn inside the distro (`process/manager.rs`)

On Windows, when `wsl_path_for(cwd)` is `Some`, `build_command` produces:

```
wsl.exe -d <distro> --cd <linux_path> --exec setsid bash -ilc '<script>'
```

with `<script>` = `export 'K=V' 'K2=V2'; echo __DEVDECK_PID__$$; exec <command>`:

- `setsid` → bash becomes its own Linux session/group leader — the mirror of the `process_group(0)` the Unix build already uses. `$$` is both PID and PGID; `exec` preserves it, so one number identifies the whole tree.
- Profile env overrides become inline `export` entries (single-quote-escaped). Env set on the Windows `wsl.exe` process does NOT cross into Linux, so `.envs()` alone is insufficient (it stays for the bridge process; the exports are the ones that matter).
- `echo __DEVDECK_PID__$$` → first stdout line; the reader parses it into the run's `linux_pgid` and drops it (never logged, never fed to the ready-pattern analyzer).
- The Windows PID of `wsl.exe` (the bridge) is still supervised exactly as today: bridge exit = service exit, stream EOF semantics unchanged.
- Non-WSL Windows spawns and the entire Unix build are byte-for-byte unchanged.

**Reader-side additions (WSL runs only):**
- PID line: consume first line matching `^__DEVDECK_PID__(\d+)$`.
- Noise filter: drop the two known `bash -i` no-tty stderr lines.

## 3. Kill path (`process/kill.rs`)

Same escalation plan, same §21.5 timeouts — only the executor changes for WSL runs:

| Step | Windows today | WSL run |
|---|---|---|
| StopCmd (60 s) | `cmd /C` in repo | `wsl.exe ... --exec setsid bash -ilc '<stop_cmd>'` |
| Terminate (wait 10 s) | `taskkill /F /T` | `wsl.exe -d <distro> --exec /bin/sh -c 'kill -TERM -- -<pgid>'` |
| ForceKill (wait 5 s) | `taskkill /F /T` | same with `-KILL` |

- `kill` reporting "no such process" = success (tree already dead) — the ESRCH equivalence the Unix path already implements.
- Each in-distro kill invocation is bounded by `TASKKILL_TIMEOUT` (15 s), like taskkill today.
- After the in-distro escalation, ALWAYS `taskkill /F /T` the `wsl.exe` bridge PID: final safety net + reaps the Windows child.
- **Race — stop before the PID line arrived:** fall back to taskkill on the bridge and emit a `[sys]` warning log line. Documented limitation: in that window the Linux tree may briefly survive; the next Terminate on a captured PID cannot exist by definition (no PID), so the bridge kill is the best available action.
- `shutdown_all` uses these same paths, still bounded by `SHUTDOWN_ALL_CAP`.

## 4. Install and docker

- Auto-install (`npm install` etc.) uses the identical WSL wrapper — same spawn shape, same PID capture, so the install-timeout kill (`INSTALL_WAIT_CAP` → kill + `INSTALL_KILL_GRACE`) can kill the Linux tree properly. Toolchain coherence: install and start both run Linux binaries.
- `docker/exec.rs`: when the compose dir is a WSL path, run `wsl.exe -d <distro> --cd <path> --exec docker compose ...` (no shell, no PID protocol — short-lived commands where timeout + `kill_on_drop` suffice, as git does today). Both compose exec sites (status polling and command execution) route.
- `is_installed` / `check_dirs`: unchanged — `Path::is_dir()` over the UNC share works from Windows.

## 5. Errors, i18n, invariants

- Distro stopped/nonexistent → `wsl.exe` exits non-zero with a readable message (thanks to `WSL_UTF8=1`) → existing spawn-error path: `[sys]` log lines + `Error` status. No new error kinds.
- No new user-visible frontend strings → no i18n changes. `[sys]` log lines are English, as existing ones are.
- Invariants preserved: §21.5 timing constants untouched; IPC contract untouched (101 commands / 7 events); `Cargo.lock` untouched; window-handling rules untouched.

## 6. Testing

Pure, cross-platform unit tests (string builders — no spawning):

- `wsl.rs`: `parse_wsl_path` suite moves as-is.
- Script builder: export escaping (values with `'`, spaces), PID marker present, `exec` prefix, command with `&&` survives.
- PID-line parser: match, non-match, mid-stream line NOT treated as PID (first line only).
- Noise filter: exactly the two bash lines dropped, everything else passes.
- Kill command builder: `-TERM`/`-KILL`, `--`, negative PGID, distro name forwarded.
- Escalation: WSL variant preserves plan order and timeouts (pin like `plan_timeouts_match_the_v1_contract`).

Real-spawn coverage stays where it is today (Windows CI; local WSL cannot build Tauri natively — GTK).

## Out of scope

- Supervision daemon inside the distro (rejected — see Decisions).
- WSL routing for java discovery (`java/detect.rs`) and terminal windows — separate features if ever needed.
- Surviving DevDeck restarts: not offered on any platform.
