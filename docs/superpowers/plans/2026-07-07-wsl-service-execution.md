# WSL Service Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Services of repos on WSL UNC shares (`\\wsl.localhost\<distro>\...`) start, install and stop INSIDE the distro, with a kill path that reliably terminates the Linux process tree; docker compose commands for those repos also run in-distro.

**Architecture:** A shared `src-tauri/src/wsl.rs` module (extracted from `git/exec.rs`) detects WSL paths and builds `wsl.exe` invocations. The ProcessManager spawns WSL runs as `wsl.exe -d <distro> --cd <path> --exec setsid bash -ilc '<exports>; echo "__DEVDECK_PID__$$"; <command>'`; the supervision reader captures the Linux PGID from the marker line; the stop escalation keeps its exact plan/timeouts but executes kills in-distro (`kill -TERM/-KILL -- -<pgid>`), always followed by `taskkill` on the `wsl.exe` bridge as safety net.

**Tech Stack:** Rust (tokio), `wsl.exe` CLI, bash, existing DevDeck process supervision.

**Spec:** `docs/superpowers/specs/2026-07-02-git-suite-design.md` is unrelated; this plan implements `docs/superpowers/specs/2026-07-07-wsl-service-execution-design.md`.

## Global Constraints

- Timing constants are untouchable (§21.5): stop_cmd 60 s, Terminate wait 10 s, ForceKill wait 5 s, taskkill 15 s, install cap 600 s, shutdown cap 30 s.
- IPC contract untouched: 101 commands / 7 events; no new commands, no frontend changes, no i18n changes.
- `Cargo.lock` untouched (`time` pinned at 0.3.47). No new dependencies.
- The Unix build must compile and behave identically (WSL detection returns `None` off-Windows).
- Every Windows spawn uses `CREATE_NO_WINDOW` (§21.5).
- **Git rule:** Claude NEVER runs `git commit`/`push`. Each task's commit step means: hand the exact command to the user (they run it). Conventional commits, no AI attribution.
- Test runs: the crate does NOT compile natively on WSL (GTK). Per-task verification from WSL is `cargo xwin check`; actual `cargo test` runs on native Windows (user or CI).
- One-time setup before the first check: `npm run build` (the `tauri::generate_context!` macro needs the Angular dist).

---

### Task 1: Extract shared `wsl.rs` module

**Files:**
- Create: `src-tauri/src/wsl.rs`
- Modify: `src-tauri/src/lib.rs` (module list, after `pub mod terminal;`)
- Modify: `src-tauri/src/git/exec.rs` (remove moved code; use the shared module)

**Interfaces:**
- Produces: `crate::wsl::WslPath { pub distro: String, pub linux_path: String }`, `crate::wsl::wsl_path_for(&Path) -> Option<WslPath>`, `crate::wsl::base_command(distro: &str) -> tokio::process::Command` (a `wsl.exe` command with `-d <distro>` and `WSL_UTF8=1` set).
- Consumes: current `git/exec.rs` definitions (lines ~51–93: `WslPath`, `wsl_path_for`, `parse_wsl_path`; tests at ~196–255).

- [ ] **Step 1: Create `src-tauri/src/wsl.rs`**

Move `WslPath`, `wsl_path_for`, `parse_wsl_path` VERBATIM from `git/exec.rs` (keep every comment), then add `base_command`. Resulting file skeleton:

```rust
//! WSL path detection and `wsl.exe` invocation shared by git, process
//! supervision and docker (design doc 2026-07-07-wsl-service-execution).
//! A repo addressed through a WSL UNC share (`\\wsl.localhost\<distro>\...`
//! or legacy `\\wsl$\...`) runs its commands INSIDE the distro.

use std::path::Path;

use tokio::process::Command;

/// A repo living inside a WSL distro, addressed from Windows via its UNC
/// share. `linux_path` is absolute inside the distro (`/home/...`).
#[cfg_attr(not(windows), allow(dead_code))]
pub struct WslPath {
    pub distro: String,
    pub linux_path: String,
}

// … `wsl_path_for` and `parse_wsl_path` moved VERBATIM from git/exec.rs
// (change visibility from `pub(crate)` to `pub` on wsl_path_for) …

/// The base `wsl.exe -d <distro>` invocation. WSL_UTF8: wsl.exe's OWN
/// diagnostics (bad distro, --cd failure) are UTF-16 by default; force
/// UTF-8 so they survive `from_utf8_lossy` (moved from git/exec.rs).
pub fn base_command(distro: &str) -> Command {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-d", distro]).env("WSL_UTF8", "1");
    cmd
}

#[cfg(test)]
mod tests {
    // … the whole `parse_wsl_path` test suite moved VERBATIM from
    // git/exec.rs (tests `parses_wsl_localhost_share`,
    // `parses_legacy_wsl_dollar_share`, `parses_verbatim_unc_form`,
    // forward-slash + rejection tests, incl. any local `parse` helper) …
}
```

- [ ] **Step 2: Register the module in `lib.rs`**

After `pub mod terminal;` add:

```rust
pub mod wsl;
```

- [ ] **Step 3: Point `git/exec.rs` at the shared module**

Delete the moved block (struct + two fns + their tests) from `git/exec.rs` and add at its imports:

```rust
pub(crate) use crate::wsl::wsl_path_for; // re-export: git/ops.rs imports it from here
```

Rewrite `git_command`'s WSL branch to use the shared base (drop the duplicated `WSL_UTF8` comment/env):

```rust
fn git_command(repo: &Path) -> Command {
    #[cfg(windows)]
    if let Some(wsl) = wsl_path_for(repo) {
        let mut cmd = crate::wsl::base_command(&wsl.distro);
        cmd.args(["--cd", &wsl.linux_path, "--exec", "git"]);
        return cmd;
    }
    let mut cmd = Command::new("git");
    cmd.current_dir(repo);
    cmd
}
```

`git/exec.rs` test module: remove the `parse_wsl_path` import from `use super::{is_option_like, parse_wsl_path};` (the moved tests took it along).

- [ ] **Step 4: Compile check**

Run: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests`
Expected: clean (warnings ok, zero errors). If `wsl_path_for` visibility errors appear in `git/ops.rs`, the re-export in Step 3 is missing.

- [ ] **Step 5: Hand the user the commit**

```bash
git add src-tauri/src/wsl.rs src-tauri/src/lib.rs src-tauri/src/git/exec.rs
git commit -m "refactor(wsl): extract shared WSL path detection module from git"
```

---

### Task 2: Pure WSL run builders (script, PID line, noise filter, kill script)

**Files:**
- Modify: `src-tauri/src/wsl.rs` (add functions + tests)

**Interfaces:**
- Produces (all in `crate::wsl`):
  - `pub fn shell_script(command: &str, env: &HashMap<String, String>, emit_pid: bool) -> String`
  - `pub fn parse_pid_line(line: &str) -> Option<u32>`
  - `pub fn is_bash_noise(line: &str) -> bool`
  - `pub fn kill_group_script(pgid: u32, force: bool) -> String`
  - `pub fn exec_in_distro(wsl: &WslPath, script: &str) -> Command` — service/install spawns
  - `pub fn exec_plain(wsl: &WslPath, program: &str) -> Command` — docker-style direct exec (caller appends args)
- Consumes: Task 1's `WslPath`, `base_command`.

- [ ] **Step 1: Write the failing tests** (in `wsl.rs` `mod tests`)

```rust
use std::collections::HashMap;

fn args_of(cmd: &Command) -> Vec<String> {
    cmd.as_std()
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn shell_script_exports_env_emits_pid_then_runs_command() {
    let mut env = HashMap::new();
    env.insert("SPRING_PROFILES_ACTIVE".to_string(), "dev".to_string());
    assert_eq!(
        shell_script("npm start", &env, true),
        "export 'SPRING_PROFILES_ACTIVE=dev'; echo \"__DEVDECK_PID__$$\"; npm start"
    );
}

#[test]
fn shell_script_sorts_env_keys_deterministically() {
    let mut env = HashMap::new();
    env.insert("B".to_string(), "2".to_string());
    env.insert("A".to_string(), "1".to_string());
    assert_eq!(
        shell_script("run", &env, false),
        "export 'A=1'; export 'B=2'; run"
    );
}

#[test]
fn shell_script_escapes_single_quotes_in_values() {
    let mut env = HashMap::new();
    env.insert("JAVA_OPTS".to_string(), "-Dname='x y'".to_string());
    assert_eq!(
        shell_script("mvn spring-boot:run", &env, false),
        r"export 'JAVA_OPTS=-Dname='\''x y'\'''; mvn spring-boot:run"
    );
}

#[test]
fn shell_script_without_env_or_pid_is_the_bare_command() {
    assert_eq!(
        shell_script("docker-compose down", &HashMap::new(), false),
        "docker-compose down"
    );
}

#[test]
fn pid_line_parses_marker_and_rejects_everything_else() {
    assert_eq!(parse_pid_line("__DEVDECK_PID__4242"), Some(4242));
    assert_eq!(parse_pid_line("__DEVDECK_PID__"), None);
    assert_eq!(parse_pid_line("__DEVDECK_PID__x1"), None);
    assert_eq!(parse_pid_line("npm start"), None);
    assert_eq!(parse_pid_line("x __DEVDECK_PID__1"), None); // prefix only
}

#[test]
fn bash_noise_filter_matches_exactly_the_two_no_tty_lines() {
    assert!(is_bash_noise(
        "bash: cannot set terminal process group (-1): Inappropriate ioctl for device"
    ));
    assert!(is_bash_noise("bash: no job control in this shell"));
    assert!(!is_bash_noise("bash: npm: command not found")); // real error — must pass
    assert!(!is_bash_noise("Compiled successfully."));
}

#[test]
fn kill_group_script_signals_the_negative_pgid() {
    assert_eq!(kill_group_script(4242, false), "kill -TERM -- -4242");
    assert_eq!(kill_group_script(4242, true), "kill -KILL -- -4242");
}

#[test]
fn exec_in_distro_builds_setsid_login_interactive_bash() {
    let w = WslPath { distro: "Ubuntu".into(), linux_path: "/home/j/app".into() };
    let cmd = exec_in_distro(&w, "echo hi");
    assert_eq!(cmd.as_std().get_program().to_string_lossy(), "wsl.exe");
    assert_eq!(
        args_of(&cmd),
        ["-d", "Ubuntu", "--cd", "/home/j/app", "--exec", "setsid", "bash", "-ilc", "echo hi"]
    );
}

#[test]
fn exec_plain_builds_direct_exec_without_shell() {
    let w = WslPath { distro: "Ubuntu".into(), linux_path: "/srv/stack".into() };
    let cmd = exec_plain(&w, "docker");
    assert_eq!(
        args_of(&cmd),
        ["-d", "Ubuntu", "--cd", "/srv/stack", "--exec", "docker"]
    );
}
```

- [ ] **Step 2: Verify the tests fail to compile**

Run: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests`
Expected: errors — `shell_script` etc. not found.

- [ ] **Step 3: Implement**

```rust
/// POSIX single-quote escaping: `'` → `'\''`.
fn sq_escape(s: &str) -> String {
    s.replace('\'', r"'\''")
}

/// The bash script for an in-distro run: profile env as `export` entries
/// (env set on the Windows wsl.exe process does NOT cross into Linux),
/// optional Linux-PGID marker, then the user command. NOT `exec`-prefixed:
/// compound commands (`a && b`) must keep bash as the setsid group leader,
/// and `$$` already identifies the whole tree.
pub fn shell_script(command: &str, env: &HashMap<String, String>, emit_pid: bool) -> String {
    let mut script = String::new();
    let mut keys: Vec<&String> = env.keys().collect();
    keys.sort(); // deterministic output (HashMap order is random)
    for k in keys {
        script.push_str(&format!("export '{}={}'; ", sq_escape(k), sq_escape(&env[k])));
    }
    if emit_pid {
        script.push_str("echo \"__DEVDECK_PID__$$\"; ");
    }
    script.push_str(command);
    script
}

/// Parse the PGID marker emitted as the run's first stdout line. Anchored:
/// the WHOLE (already-trimmed) line must be marker + digits.
pub fn parse_pid_line(line: &str) -> Option<u32> {
    line.strip_prefix("__DEVDECK_PID__")?.parse().ok()
}

/// The two stderr lines `bash -i` emits without a tty. Filtered from WSL
/// run logs (design doc §2). ponytail: exact-prefix match — a service
/// legitimately printing these exact lines loses them; acceptable.
pub fn is_bash_noise(line: &str) -> bool {
    line.starts_with("bash: cannot set terminal process group")
        || line == "bash: no job control in this shell"
}

/// `kill` invocation for the whole Linux process group (negative pgid),
/// run via `/bin/sh -c` inside the distro.
pub fn kill_group_script(pgid: u32, force: bool) -> String {
    let sig = if force { "KILL" } else { "TERM" };
    format!("kill -{sig} -- -{pgid}")
}

/// Spawn a service/install command inside the distro: `setsid` makes bash
/// its own session/group leader (the mirror of the Unix `process_group(0)`
/// spawn), `bash -ilc` loads the FULL .bashrc — Ubuntu's interactivity
/// guard returns before nvm init in non-interactive shells, so `-i` is
/// required, not optional.
pub fn exec_in_distro(wsl: &WslPath, script: &str) -> Command {
    let mut cmd = base_command(&wsl.distro);
    cmd.args(["--cd", &wsl.linux_path, "--exec", "setsid", "bash", "-ilc", script]);
    cmd
}

/// Run a program directly inside the distro (no shell, no PID protocol) —
/// short-lived commands like docker compose queries, mirroring git routing.
pub fn exec_plain(wsl: &WslPath, program: &str) -> Command {
    let mut cmd = base_command(&wsl.distro);
    cmd.args(["--cd", &wsl.linux_path, "--exec", program]);
    cmd
}
```

Add `use std::collections::HashMap;` to the module imports.

- [ ] **Step 4: Verify compile + (on Windows) tests pass**

From WSL: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests` → clean.
On native Windows (user/CI): `cargo test --manifest-path src-tauri/Cargo.toml wsl::` → all new tests PASS.

- [ ] **Step 5: Hand the user the commit**

```bash
git add src-tauri/src/wsl.rs
git commit -m "feat(wsl): in-distro run script, PID marker and kill-script builders"
```

---

### Task 3: In-distro group kill primitive (`kill.rs`)

**Files:**
- Modify: `src-tauri/src/process/kill.rs`

**Interfaces:**
- Produces: `pub async fn signal_group_wsl(distro: &str, pgid: u32, force: bool) -> Result<(), ProcessError>`
- Consumes: `crate::wsl::kill_group_script` (Task 2), `ProcessError::Kill`, `TASKKILL_TIMEOUT`, `CREATE_NO_WINDOW`.

- [ ] **Step 1: Write the failing test** (in `kill.rs` `mod tests`)

```rust
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
```

- [ ] **Step 2: Verify it fails to compile**

Run: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests`
Expected: error — `signal_group_wsl` not found.

- [ ] **Step 3: Implement**

Add below `force_kill_tree`:

```rust
/// Signal the LINUX process group of a WSL run from Windows: the in-distro
/// equivalent of [`signal_group`], executed as
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
```

- [ ] **Step 4: Verify compile + (on Windows) tests**

From WSL: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests` → clean.

- [ ] **Step 5: Hand the user the commit**

```bash
git add src-tauri/src/process/kill.rs
git commit -m "feat(process): in-distro process-group kill for WSL runs"
```

---

### Task 4: Route spawn through WSL and capture the Linux PGID

**Files:**
- Modify: `src-tauri/src/process/manager.rs`

**Interfaces:**
- Consumes: `crate::wsl::{wsl_path_for, shell_script, exec_in_distro, parse_pid_line, is_bash_noise}` (Tasks 1–2).
- Produces: `struct WslRun { distro: String, pgid: Arc<OnceLock<u32>> }` (manager-private, `#[derive(Clone)]`); `build_command(command, cwd, env, emit_pid) -> (Command, Option<WslRun>)`; `Entry` gains `wsl: Option<WslRun>`; `supervise` gains a `wsl: Option<WslRun>` parameter. Task 5 relies on `Entry.wsl` and `WslRun.pgid.get()`.

- [ ] **Step 1: Write the failing test** (manager.rs `mod tests`)

Replace the test `unc_cwd_gets_pushd_wrapper_others_do_not` (the palliative dies in this task) with:

```rust
#[test]
fn build_command_routes_unc_paths_to_wsl_only_on_windows() {
    let env = HashMap::new();
    let unc = Path::new(r"\\wsl.localhost\Ubuntu\home\j\boa2-frontend");
    let (cmd, wsl) = build_command("npm start", unc, &env, true);
    if cfg!(windows) {
        let w = wsl.expect("UNC path must produce a WSL run on Windows");
        assert_eq!(w.distro, "Ubuntu");
        assert!(w.pgid.get().is_none(), "pgid is captured later, from the marker line");
        assert_eq!(cmd.as_std().get_program().to_string_lossy(), "wsl.exe");
        let args: Vec<String> = cmd.as_std().get_args()
            .map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args[..7], ["-d", "Ubuntu", "--cd", "/home/j/boa2-frontend",
                               "--exec", "setsid", "bash"]);
        assert!(args.last().unwrap().contains("__DEVDECK_PID__"));
        assert!(args.last().unwrap().ends_with("npm start"));
    } else {
        assert!(wsl.is_none(), "non-Windows never routes");
    }
    // Drive-letter / Unix paths never route, any platform.
    let (_, wsl) = build_command("npm start", Path::new(r"C:\repos\app"), &env, true);
    assert!(wsl.is_none());
}
```

- [ ] **Step 2: Verify it fails to compile**

Run: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests`
Expected: error — `build_command` takes 3 args and returns `Command`.

- [ ] **Step 3: Implement the spawn side**

In `manager.rs`:

1. Imports: add `use std::sync::OnceLock;`.
2. DELETE `unc_pushd_wrap` and its doc comment (superseded palliative).
3. Add next to `build_command`:

```rust
/// A run executing inside a WSL distro: the kill path needs the distro name
/// and the Linux PGID captured from the `__DEVDECK_PID__` marker line
/// (design doc 2026-07-07-wsl-service-execution §2–3).
#[derive(Clone)]
struct WslRun {
    distro: String,
    /// Set once by the supervision reader when the marker line arrives.
    pgid: Arc<OnceLock<u32>>,
}
```

4. Replace `build_command` with:

```rust
/// Build the platform shell command for a run: merged-output piping, env
/// overrides on the inherited environment, own process group on Unix
/// (§22.1 fix), `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` on Windows
/// (§21.5). A cwd on a WSL UNC share runs INSIDE the distro instead
/// (design doc 2026-07-07-wsl-service-execution): cmd.exe rejects UNC
/// working dirs, and the Windows toolchain must not touch Linux-built
/// node_modules. `emit_pid` adds the Linux-PGID marker (services/installs
/// need it for the kill path; captured-output stop_cmds must NOT log it).
fn build_command(
    command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
    emit_pid: bool,
) -> (Command, Option<WslRun>) {
    let (mut cmd, wsl) = match crate::wsl::wsl_path_for(cwd) {
        Some(w) => {
            let script = crate::wsl::shell_script(command, env, emit_pid);
            let run = WslRun {
                distro: w.distro.clone(),
                pgid: Arc::new(OnceLock::new()),
            };
            // No .current_dir(): --cd positions us inside the distro; no
            // .envs(): Windows-side env does not cross into Linux — the
            // script's exports carry it.
            (crate::wsl::exec_in_distro(&w, &script), Some(run))
        }
        None => {
            let (program, flag) = shell_invocation(cfg!(windows));
            let mut cmd = Command::new(program);
            cmd.arg(flag).arg(command).current_dir(cwd).envs(env);
            (cmd, None)
        }
    };
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        // Own process group ⇒ killpg(child_pid) can never touch the app
        // (architecture-v2.md §7.1 fix 1).
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use super::constants::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    (cmd, wsl)
}
```

5. In `spawn_run` (line ~399), replace the spawn expression:

```rust
        let (mut command_builder, wsl) = build_command(&command, &cwd, &env, true);
        let mut child = command_builder
            .spawn()
            .map_err(|source| ProcessError::Spawn {
                id: id.clone(),
                source,
            })?;
```

6. `Entry` struct: add field `wsl: Option<WslRun>,` and set `wsl: wsl.clone(),` in the `services.insert(...)` literal.

7. `supervise` call site: pass `wsl` as a new argument (after `manually_stopped`).

8. In `run_stop_cmd` (line ~816), replace:

```rust
    let (mut cmd, _) = build_command(&sc.command, &sc.cwd, &sc.env, false);
```

- [ ] **Step 4: Implement the reader side (PGID capture + noise filter)**

`supervise` signature gains `wsl: Option<WslRun>` (add `#[allow(clippy::too_many_arguments)]` is already present). In the streaming loop, at the TOP of the `Some(line)` arm (before `analyzer.analyze`):

```rust
                Some(line) => {
                    if let Some(w) = &wsl {
                        // WSL runs only: swallow bash's no-tty noise and
                        // capture the Linux PGID marker (never logged,
                        // never fed to the ready-pattern analyzer).
                        if crate::wsl::is_bash_noise(&line) {
                            continue;
                        }
                        if w.pgid.get().is_none() {
                            if let Some(pgid) = crate::wsl::parse_pid_line(&line) {
                                let _ = w.pgid.set(pgid);
                                continue;
                            }
                        }
                    }
                    let effects = analyzer.analyze(&line);
                    // … rest of the arm unchanged …
```

- [ ] **Step 5: Verify compile**

Run: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests`
Expected: clean. (The `wsl` param is not yet used by any kill site — a `unused` warning on Unix builds is acceptable until Task 5; silence with `let _ = &wsl;` ONLY if it is a hard error.)

- [ ] **Step 6: Hand the user the commit**

```bash
git add src-tauri/src/process/manager.rs
git commit -m "feat(process): spawn WSL-repo services inside the distro with PGID capture"
```

---

### Task 5: Wire the in-distro kill path into every stop site

**Files:**
- Modify: `src-tauri/src/process/manager.rs`

**Interfaces:**
- Consumes: `Entry.wsl`, `WslRun` (Task 4), `kill::signal_group_wsl` (Task 3), `kill::{terminate_tree, force_kill_tree}` (existing).
- Produces: `async fn kill_run_tree(id: &str, pid: u32, wsl: Option<&WslRun>, force: bool)` used by `stop`, `supervise`, `shutdown_all`.

- [ ] **Step 1: Add the shared kill helper** (below `wait_terminal`)

```rust
/// Kill a run's whole tree. WSL runs get the in-distro group kill FIRST
/// (the Linux tree is unreachable from taskkill), then the Windows-side
/// tree kill always runs — it reaps the wsl.exe bridge and doubles as the
/// final safety net (design doc 2026-07-07-wsl-service-execution §3).
async fn kill_run_tree(id: &str, pid: u32, wsl: Option<&WslRun>, force: bool) {
    if let Some(w) = wsl {
        match w.pgid.get() {
            Some(&pgid) => {
                if let Err(err) = kill::signal_group_wsl(&w.distro, pgid, force).await {
                    log::warn!(
                        "in-distro kill of '{id}' (distro {}, pgid {pgid}) failed: {err}",
                        w.distro
                    );
                }
            }
            // Stop raced the marker line: nothing to signal in-distro yet;
            // the bridge kill below is the best available action.
            None => log::warn!("'{id}': Linux pgid not captured; killing only the wsl.exe bridge"),
        }
    }
    let result = if force {
        kill::force_kill_tree(pid).await
    } else {
        kill::terminate_tree(pid).await
    };
    if let Err(err) = result {
        log::warn!("tree kill of '{id}' (pid {pid}) failed: {err}");
    }
}
```

- [ ] **Step 2: Use it in `stop()`**

1. The entry snapshot tuple gains `e.wsl.clone()`:

```rust
            services.get(id).map(|e| {
                (
                    e.pid,
                    e.stop_cmd.clone(),
                    e.manually_stopped.clone(),
                    e.state_tx.clone(),
                    e.state_rx.clone(),
                    e.wsl.clone(),
                )
            })
```

and the destructuring `let Some((pid, stop_cmd, manually_stopped, state_tx, state_rx, wsl)) = entry else { … }`.

2. After the `[svc] Stopping {id}...` emit, surface the race in the service log (design §3):

```rust
        if let Some(w) = &wsl {
            if w.pgid.get().is_none() {
                emit_lines_now(
                    emitter,
                    id,
                    LogStream::Service,
                    vec![format!(
                        "[sys] {id}: Linux pid not captured yet; stop may only reach the WSL bridge"
                    )],
                );
            }
        }
```

3. Replace both kill calls in the escalation match:

```rust
                EscalationStep::Terminate { wait } => {
                    kill_run_tree(id, pid, wsl.as_ref(), false).await;
                    if wait_terminal(state_rx.clone(), wait).await {
                        return Ok(StopOutcome::Stopped);
                    }
                }
                EscalationStep::ForceKill { wait } => {
                    // v1's `kill()` fallback path logged a force-stop (§17.2).
                    emit_lines_now(
                        emitter,
                        id,
                        LogStream::Service,
                        vec![format!("[svc] {id} force-stopped: graceful stop timed out")],
                    );
                    kill_run_tree(id, pid, wsl.as_ref(), true).await;
                    let _ = wait_terminal(state_rx.clone(), wait).await;
                }
```

(The old inline `if let Err(err) = kill::terminate_tree(pid)…` warnings move into the helper.)

- [ ] **Step 3: Use it in `supervise`'s post-EOF timeout kill**

Replace `if let Err(err) = kill::force_kill_tree(pid).await { … }` (line ~740) with:

```rust
            kill_run_tree(&id, pid, wsl.as_ref(), true).await;
```

(`wsl` is the parameter added in Task 4.)

- [ ] **Step 4: Use it in `shutdown_all`'s survivor sweep**

Replace the leftover collection + loop:

```rust
            let leftovers: Vec<(String, u32, Option<WslRun>)> = self
                .inner
                .services
                .lock()
                .await
                .iter()
                .map(|(id, e)| (id.clone(), e.pid, e.wsl.clone()))
                .collect();
            for (id, pid, wsl) in leftovers {
                kill_run_tree(&id, pid, wsl.as_ref(), true).await;
            }
```

- [ ] **Step 5: Verify compile, then behavior checks on Windows**

From WSL: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests` → clean.
On native Windows: `cargo test --manifest-path src-tauri/Cargo.toml` → full suite PASS (existing stop/supervise tests exercise the non-WSL path of `kill_run_tree`).

- [ ] **Step 6: Hand the user the commit**

```bash
git add src-tauri/src/process/manager.rs
git commit -m "feat(process): in-distro kill escalation for WSL runs with bridge safety net"
```

---

### Task 6: Route docker compose through the distro

**Files:**
- Modify: `src-tauri/src/docker/exec.rs`

**Interfaces:**
- Consumes: `crate::wsl::{wsl_path_for, exec_plain}` (Tasks 1–2).
- Produces: no new public API — `run_raw` and `compose_streaming_command` route internally; `run_compose` forces compose v2 for WSL dirs.

- [ ] **Step 1: Route `run_raw`**

Replace the `Command` construction at the top of `run_raw`:

```rust
    let mut cmd = match cwd.and_then(crate::wsl::wsl_path_for) {
        // Compose dir inside a WSL distro ⇒ run docker IN the distro
        // (native docker installs, not only Docker Desktop — design doc
        // 2026-07-07-wsl-service-execution §4). PATH note: --exec uses the
        // default WSL env (/usr/bin), where apt/docker-ce installs live.
        Some(w) => {
            let mut cmd = crate::wsl::exec_plain(&w, program);
            cmd.args(args);
            cmd
        }
        None => {
            let mut cmd = Command::new(program);
            cmd.args(args);
            if let Some(dir) = cwd {
                cmd.current_dir(dir);
            }
            cmd
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
```

(Keep the existing `CREATE_NO_WINDOW` block and the timeout/output tail unchanged. Note `wsl_path_for` takes `&Path`; `cwd` is `Option<&Path>`, so `cwd.and_then(crate::wsl::wsl_path_for)` works as-is.)

- [ ] **Step 2: Force compose v2 for WSL dirs in `run_compose`**

The global `compose_flavor()` probe runs on the WINDOWS side and says nothing about the distro. After computing `cwd`, override the flavor:

```rust
    let cwd = compose_file.parent();

    // ponytail: inside a distro assume compose v2 (`docker compose`) —
    // docker-ce has shipped the plugin for years; per-distro probing if a
    // legacy-only distro ever shows up.
    let flavor = if cwd.is_some_and(|d| crate::wsl::wsl_path_for(d).is_some()) {
        ComposeFlavor::DockerCompose2
    } else {
        compose_flavor().await
    };

    let mut full: Vec<&str> = Vec::with_capacity(args.len() + 4);
    let program = match flavor {
        ComposeFlavor::DockerCompose2 => {
            full.push("compose");
            "docker"
        }
        ComposeFlavor::LegacyBinary => "docker-compose",
    };
```

- [ ] **Step 3: Route `compose_streaming_command` the same way**

Apply the same flavor override (it recomputes `program`/`full` — same snippet as Step 2, using `compose_file.parent()`), and replace its `Command` construction + `current_dir` block:

```rust
    let mut cmd = match compose_file.parent().and_then(crate::wsl::wsl_path_for) {
        Some(w) => {
            let mut cmd = crate::wsl::exec_plain(&w, program);
            cmd.args(&full);
            cmd
        }
        None => {
            let mut cmd = Command::new(program);
            cmd.args(&full);
            if let Some(dir) = compose_file.parent() {
                cmd.current_dir(dir);
            }
            cmd
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
```

(Keep the `CREATE_NO_WINDOW` block.)

- [ ] **Step 4: Verify compile**

Run: `cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests`
Expected: clean. Known scope note: global `docker info`/`ps` queries (no repo dir) still run Windows-side — the docker status header needs a Windows docker CLI; compose actions for WSL repos do not.

- [ ] **Step 5: Hand the user the commit**

```bash
git add src-tauri/src/docker/exec.rs
git commit -m "feat(docker): run compose commands inside the distro for WSL repos"
```

---

### Task 7: Full verification and release handoff

**Files:** none (verification only)

- [ ] **Step 1: Full cross-compile from WSL**

```bash
npm run build   # once — tauri::generate_context! needs the Angular dist
cargo xwin check --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml --tests
```
Expected: zero errors, zero NEW warnings.

- [ ] **Step 2: Test suite on native Windows (user or CI)**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```
Expected: all Rust tests PASS (incl. the moved `parse_wsl_path` suite, the new `wsl::` builders, `kill.rs` guards, `build_command` routing); vitest suite untouched and green (no frontend changes).

- [ ] **Step 3: Manual smoke test on Windows (the real acceptance test)**

1. `npm run tauri dev` (native Windows) with a workspace containing `\\wsl.localhost\Ubuntu\...\boa2-frontend`.
2. Start the service → log shows NO `__DEVDECK_PID__` line, NO bash noise, and the dev server compiles (Linux node).
3. `wsl -d Ubuntu -- ps -e -o pid,pgid,cmd | grep node` → node processes share one PGID.
4. Stop the service → within ~10 s the same `ps` shows the tree GONE and the card reads stopped.
5. Auto-install: delete `node_modules` inside the distro, start → install runs with Linux npm.
6. Docker repo in WSL (if available): compose up/down works with in-distro docker.

- [ ] **Step 4: Hand the user the final push**

All commits from Tasks 1–6 exist locally. The user pushes to master:

```bash
git push origin master
```

(No version bump/CHANGELOG here — that happens at release time via `/release`, per CLAUDE.md.)
