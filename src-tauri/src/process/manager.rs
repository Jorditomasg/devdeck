//! [`ProcessManager`] — the registry + supervision core replacing v1's
//! `ServiceLauncher` (§17), `ProcessManager` (§18) and the GUI's own spawn
//! path (§21.1) — section references are inventory-backend.md.
//!
//! One registry keyed by service id (`"repo"` or `"repo::module"`, §8.3)
//! shared by services AND installs, so an install and a run of the same repo
//! are mutually exclusive (§17.1). Per run:
//!
//! - **Spawn** (§21.1, §18): shell-string command (`cmd /C` / `/bin/sh -c`,
//!   the v1 `shell=True`), `cwd` = repo path, env OVERRIDES on top of the
//!   inherited environment (Java env from `java::env::build_java_env`).
//!   Unix: `process_group(0)` so the child owns its process group (the §22.1
//!   fix). Windows: `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` (§21.5).
//! - **Stream** (§18): stdout + stderr pumped into ONE line channel
//!   (reproducing v1's `stderr=STDOUT` merge), lossy UTF-8, ANSI-stripped,
//!   trimmed, empties dropped. Lines drive the [`LineAnalyzer`] state
//!   machine (§21.2) and are batched into `service://log-line` events every
//!   `LOG_BATCH_FLUSH` (75 ms) or `LOG_BATCH_MAX_LINES` (64) — the
//!   architecture-v2.md §3.2 "~50–100 ms or 64 lines" contract.
//! - **Exit** (§21.2 / §17.1): after stream EOF, wait 30 s (service) /
//!   600 s install cap, then kill-and-wait; final status via
//!   [`LineAnalyzer::finalize`]; exit code reported in the final event.
//! - **Stop** (§17.2): [`kill::escalation_plan`] — optional `stop_cmd`
//!   first, then group-SIGTERM with 10 s grace, then group-SIGKILL
//!   (Windows: `taskkill /F /T`).
//! - **shutdown_all** (§21.4): the v1 atexit contract — concurrent stops
//!   bounded by `SHUTDOWN_ALL_CAP`, leftovers force-killed; idempotent and
//!   refuses new spawns once invoked.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch, Mutex};
use tokio::task::JoinSet;

use crate::events::{
    now_ms, EventEmitter, LogStream, ServiceLogPayload, ServiceStatus, ServiceStatusPayload,
};

use super::constants::{
    INSTALL_KILL_GRACE, INSTALL_WAIT_CAP, LINE_CHANNEL_CAPACITY, LOG_BATCH_FLUSH,
    LOG_BATCH_MAX_LINES, SERVICE_EXIT_WAIT_AFTER_EOF, SHUTDOWN_ALL_CAP, STOP_CMD_TIMEOUT,
};
use super::error::ProcessError;
use super::kill::{self, EscalationStep};
use super::line_machine::{strip_ansi, LineAnalyzer};
use super::types::{
    is_terminal, InstallSpec, RunKind, RuntimeState, ServiceSnapshot, ServiceSpec, StopCommand,
    StopOutcome,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Shell used to run a COMMAND STRING, mirroring Python's `shell=True`
/// (§18, §21.1): `cmd /C` on Windows, `/bin/sh -c` on POSIX.
pub(crate) fn shell_invocation(windows: bool) -> (&'static str, &'static str) {
    if windows {
        ("cmd", "/C")
    } else {
        ("/bin/sh", "-c")
    }
}

/// `ui.install.check_dirs` semantics (§17.1, §22.17): the repo counts as
/// installed when ALL listed dirs exist; an EMPTY list always counts as
/// installed (skip auto-install).
pub fn is_installed(repo_path: &Path, check_dirs: &[String]) -> bool {
    check_dirs.iter().all(|d| repo_path.join(d).is_dir())
}

/// A run executing inside a WSL distro: the kill path needs the distro name
/// and the Linux PGID captured from the `__DEVDECK_PID__` marker line
/// (design doc 2026-07-07-wsl-service-execution §2–3).
#[derive(Clone)]
struct WslRun {
    distro: String,
    /// Set once by the supervision reader when the marker line arrives.
    pgid: Arc<OnceLock<u32>>,
}

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

// ---------------------------------------------------------------------------
// Log batching
// ---------------------------------------------------------------------------

/// Accumulates log lines for one run and emits them as a single
/// `service://log-line` event — flushed by the supervision loop every
/// [`LOG_BATCH_FLUSH`] (75 ms) or when [`LOG_BATCH_MAX_LINES`] (64) is
/// reached, whichever comes first (architecture-v2.md §3.2).
struct LogBatcher {
    name: String,
    stream: LogStream,
    lines: Vec<String>,
}

impl LogBatcher {
    fn new(name: String, stream: LogStream) -> Self {
        Self {
            name,
            stream,
            lines: Vec::new(),
        }
    }

    /// Queue a line; `true` means the batch hit [`LOG_BATCH_MAX_LINES`] and
    /// the caller must flush now.
    fn push(&mut self, line: String) -> bool {
        self.lines.push(line);
        self.lines.len() >= LOG_BATCH_MAX_LINES
    }

    /// Emit the queued lines as one event (no-op when empty).
    fn flush(&mut self, emitter: &dyn EventEmitter) {
        if self.lines.is_empty() {
            return;
        }
        emitter.emit_log(&ServiceLogPayload {
            name: self.name.clone(),
            stream: self.stream,
            lines: std::mem::take(&mut self.lines),
            timestamp_ms: now_ms(),
        });
    }
}

/// Emit a set of lines immediately as one batch (system messages like the
/// v1 `[svc]` / `[sys]` log lines, §17.1 / §18).
fn emit_lines_now(emitter: &dyn EventEmitter, name: &str, stream: LogStream, lines: Vec<String>) {
    if lines.is_empty() {
        return;
    }
    emitter.emit_log(&ServiceLogPayload {
        name: name.to_owned(),
        stream,
        lines,
        timestamp_ms: now_ms(),
    });
}

fn emit_status(
    emitter: &dyn EventEmitter,
    name: &str,
    status: ServiceStatus,
    port: Option<u16>,
    pid: Option<u32>,
    exit_code: Option<i32>,
    error: Option<String>,
) {
    emitter.emit_status(&ServiceStatusPayload {
        name: name.to_owned(),
        status,
        exit_code,
        error,
        port,
        pid,
    });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// One tracked run. The supervision task owns the [`Child`]; the registry
/// only needs the pid (kills go to the process GROUP / tree by pid), the
/// stop command, the manual-stop flag and a watch on the live state.
/// `state_tx` is shared (`Arc`) with the supervision task so [`stop`]
/// (`ProcessManager::stop`) can broadcast the transient `stopping` state
/// (ipc-contract.md §1.4 — all 6 states must be emittable).
struct Entry {
    pid: u32,
    stop_cmd: Option<StopCommand>,
    manually_stopped: Arc<AtomicBool>,
    state_tx: Arc<watch::Sender<RuntimeState>>,
    state_rx: watch::Receiver<RuntimeState>,
    wsl: Option<WslRun>,
}

struct Inner {
    emitter: Arc<dyn EventEmitter>,
    services: Mutex<HashMap<String, Entry>>,
    shutting_down: AtomicBool,
}

/// Subprocess registry + supervisor. Cheap to clone (shared `Arc` core) —
/// the integration layer puts one instance in `AppState` and wires
/// [`ProcessManager::shutdown_all`] to Tauri's exit lifecycle (§21.4).
#[derive(Clone)]
pub struct ProcessManager {
    inner: Arc<Inner>,
}

impl ProcessManager {
    pub fn new(emitter: Arc<dyn EventEmitter>) -> Self {
        Self {
            inner: Arc::new(Inner {
                emitter,
                services: Mutex::new(HashMap::new()),
                shutting_down: AtomicBool::new(false),
            }),
        }
    }

    // -- queries ------------------------------------------------------------

    /// v1 `is_running` (§17): tracked AND the run has not reached a terminal
    /// status yet.
    pub async fn is_running(&self, id: &str) -> bool {
        self.inner
            .services
            .lock()
            .await
            .get(id)
            .map(|e| !is_terminal(e.state_rx.borrow().status))
            .unwrap_or(false)
    }

    /// v1 `get_status` (§17): untracked ⇒ `stopped`, else the live status.
    pub async fn status(&self, id: &str) -> ServiceStatus {
        self.inner
            .services
            .lock()
            .await
            .get(id)
            .map(|e| e.state_rx.borrow().status)
            .unwrap_or(ServiceStatus::Stopped)
    }

    /// Snapshot of every tracked run (v1 `get_all_services` copy, §17).
    pub async fn snapshots(&self) -> Vec<ServiceSnapshot> {
        self.inner
            .services
            .lock()
            .await
            .iter()
            .map(|(id, e)| {
                let state = *e.state_rx.borrow();
                ServiceSnapshot {
                    id: id.clone(),
                    status: state.status,
                    port: state.port,
                    pid: Some(e.pid),
                }
            })
            .collect()
    }

    // -- spawning -----------------------------------------------------------

    /// Start a long-lived service (§21.1-21.2). Returns the child pid.
    /// Status events: `starting` at spawn; with no `ready_pattern` the run
    /// additionally jumps straight to `running` (§21.2).
    pub async fn start_service(&self, spec: ServiceSpec) -> Result<u32, ProcessError> {
        let ServiceSpec {
            id,
            command,
            cwd,
            env,
            ready_pattern,
            error_pattern,
            port_patterns,
            known_port,
            stop_cmd,
        } = spec;
        let analyzer = LineAnalyzer::for_service(
            ready_pattern.as_deref(),
            error_pattern.as_deref(),
            &port_patterns,
            known_port,
        );
        // The spec carries the repo-type `stop_cmd` as a bare command string;
        // bind it to the service's cwd/env here so the stop path can run it
        // through the same shell environment as the start (§22.6 / §7.4).
        let stop_cmd = stop_cmd.map(|command| StopCommand {
            command,
            cwd: cwd.clone(),
            env: env.clone(),
        });
        self.spawn_run(
            id,
            command,
            cwd,
            env,
            stop_cmd,
            RunKind::Service,
            analyzer,
            Vec::new(),
        )
        .await
    }

    /// Run an install/reinstall command (§17.1): distinct `installing`
    /// status, the 600 s post-EOF wait cap, kill-on-timeout. Shares the
    /// registry with services, so it refuses while the repo is running.
    pub async fn install(&self, spec: InstallSpec) -> Result<u32, ProcessError> {
        // v1 §17.1 intro log lines, verbatim.
        let mut intro = vec![format!(
            "[svc] Running installation for {}: {}",
            spec.id, spec.command
        )];
        if let Some(home) = spec.env.get("JAVA_HOME") {
            intro.push(format!("[svc] Using JAVA_HOME: {home}"));
        }
        self.spawn_run(
            spec.id,
            spec.command,
            spec.cwd,
            spec.env,
            None,
            RunKind::Install,
            LineAnalyzer::for_install(),
            intro,
        )
        .await
    }

    /// Shared spawn path: validate (§17.1/§18 refusals) → spawn → register →
    /// emit initial status → hand off to the supervision task.
    #[allow(clippy::too_many_arguments)]
    async fn spawn_run(
        &self,
        id: String,
        command: String,
        cwd: PathBuf,
        env: HashMap<String, String>,
        stop_cmd: Option<StopCommand>,
        kind: RunKind,
        analyzer: LineAnalyzer,
        intro_lines: Vec<String>,
    ) -> Result<u32, ProcessError> {
        if self.inner.shutting_down.load(Ordering::SeqCst) {
            return Err(ProcessError::ShuttingDown);
        }
        if command.trim().is_empty() {
            return Err(ProcessError::EmptyCommand(id));
        }
        if !cwd.is_dir() {
            return Err(ProcessError::InvalidWorkdir(cwd.display().to_string()));
        }
        let stream = match kind {
            RunKind::Service => LogStream::Service,
            RunKind::Install => LogStream::Install,
        };

        // Hold the registry lock across check + spawn + insert so two
        // concurrent starts of the same id cannot both pass the check.
        // (Command::spawn is synchronous and non-blocking.)
        let mut services = self.inner.services.lock().await;
        if let Some(existing) = services.get(&id) {
            if !is_terminal(existing.state_rx.borrow().status) {
                return Err(ProcessError::AlreadyRunning(id));
            }
        }

        let (mut command_builder, wsl) = build_command(&command, &cwd, &env, true);
        let mut child = command_builder
            .spawn()
            .map_err(|source| ProcessError::Spawn {
                id: id.clone(),
                source,
            })?;
        let pid = child.id().ok_or_else(|| ProcessError::Spawn {
            id: id.clone(),
            source: std::io::Error::other("child exited before its pid could be read"),
        })?;

        let initial = RuntimeState {
            status: analyzer.status(),
            port: analyzer.port(),
            exit_code: None,
        };
        let (state_tx, state_rx) = watch::channel(initial);
        let state_tx = Arc::new(state_tx);
        let manually_stopped = Arc::new(AtomicBool::new(false));
        services.insert(
            id.clone(),
            Entry {
                pid,
                stop_cmd,
                manually_stopped: manually_stopped.clone(),
                state_tx: state_tx.clone(),
                state_rx,
                wsl: wsl.clone(),
            },
        );
        drop(services);

        // Initial status events: `starting`/`installing` at spawn; a service
        // with no ready_pattern jumps straight to `running` (§21.2 — v1
        // emitted both transitions, we keep the sequence).
        let emitter = self.inner.emitter.as_ref();
        let spawn_status = match kind {
            RunKind::Service => ServiceStatus::Starting,
            RunKind::Install => ServiceStatus::Installing,
        };
        emit_status(emitter, &id, spawn_status, analyzer.port(), Some(pid), None, None);
        if kind == RunKind::Service && analyzer.status() == ServiceStatus::Running {
            emit_status(
                emitter,
                &id,
                ServiceStatus::Running,
                analyzer.port(),
                Some(pid),
                None,
                None,
            );
        }
        emit_lines_now(emitter, &id, stream, intro_lines);

        // stdout + stderr pumped into ONE channel — the v1 `stderr=STDOUT`
        // merge (§18), kept as two readers because tokio cannot dup pipes
        // portably; ordering inside each pipe is preserved.
        let (line_tx, line_rx) = mpsc::channel(LINE_CHANNEL_CAPACITY);
        if let Some(out) = child.stdout.take() {
            tokio::spawn(pump_lines(out, line_tx.clone()));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(pump_lines(err, line_tx.clone()));
        }
        drop(line_tx); // channel closes when both pumps finish ⇒ stream EOF

        tokio::spawn(supervise(
            self.inner.clone(),
            id,
            kind,
            child,
            pid,
            line_rx,
            analyzer,
            state_tx,
            manually_stopped,
            wsl,
        ));

        Ok(pid)
    }

    // -- stopping -----------------------------------------------------------

    /// Stop a tracked run (§17.2): walks [`kill::escalation_plan`] —
    /// repo-type `stop_cmd` first when defined (architecture-v2.md §7.1
    /// fix 4), then group-SIGTERM with the 10 s grace, then group-SIGKILL
    /// (Windows: `taskkill /F /T`). Returns [`StopOutcome::Untracked`] when
    /// not registered, [`StopOutcome::AlreadyTerminal`] when the run already
    /// finished, [`StopOutcome::Stopped`] otherwise — even on the force
    /// path, matching v1 (§17.2 "still marked stopped, return True").
    pub async fn stop(&self, id: &str) -> Result<StopOutcome, ProcessError> {
        let entry = {
            let services = self.inner.services.lock().await;
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
        };
        let emitter = self.inner.emitter.as_ref();
        let Some((pid, stop_cmd, manually_stopped, state_tx, state_rx, wsl)) = entry else {
            // v1: `[svc] <name> is not running`, return False (§17.2).
            emit_lines_now(
                emitter,
                id,
                LogStream::Service,
                vec![format!("[svc] {id} is not running")],
            );
            return Ok(StopOutcome::Untracked);
        };
        if is_terminal(state_rx.borrow().status) {
            return Ok(StopOutcome::AlreadyTerminal); // already finishing — nothing to kill
        }

        manually_stopped.store(true, Ordering::SeqCst);
        // Broadcast the transient `stopping` state BEFORE escalation starts
        // (ipc-contract.md §1.4 — the frontend disables the card's buttons
        // on it; without this the card jumps straight to `stopped`).
        let port = state_rx.borrow().port;
        let _ = state_tx.send(RuntimeState {
            status: ServiceStatus::Stopping,
            port,
            exit_code: None,
        });
        emit_status(emitter, id, ServiceStatus::Stopping, port, Some(pid), None, None);
        emit_lines_now(
            emitter,
            id,
            LogStream::Service,
            vec![format!("[svc] Stopping {id}...")],
        );
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

        for step in kill::escalation_plan(stop_cmd.is_some()) {
            match step {
                EscalationStep::StopCmd { timeout } => {
                    if let Some(sc) = &stop_cmd {
                        run_stop_cmd(emitter, id, sc, timeout).await;
                        if is_terminal(state_rx.borrow().status) {
                            return Ok(StopOutcome::Stopped);
                        }
                    }
                }
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
            }
        }
        Ok(StopOutcome::Stopped)
    }

    /// Run a repo-type `stop_cmd` for an UNTRACKED repo. Needed because
    /// detaching starts (docker-infra `docker-compose up -d`) exit
    /// immediately, so by stop time nothing is registered — but the compose
    /// stack must still be downed (architecture-v2.md §7.1 fix 4).
    pub async fn run_stop_command(&self, id: &str, stop_cmd: &StopCommand) {
        run_stop_cmd(self.inner.emitter.as_ref(), id, stop_cmd, STOP_CMD_TIMEOUT).await;
    }

    /// Stop everything — the v1 atexit contract (§21.4), now wired to
    /// Tauri's exit lifecycle by the integration layer. Idempotent; refuses
    /// new spawns from the first call on; total time bounded by
    /// [`SHUTDOWN_ALL_CAP`], after which any survivor gets a best-effort
    /// force-kill (v2 decision documented in `constants.rs`).
    pub async fn shutdown_all(&self) {
        self.inner.shutting_down.store(true, Ordering::SeqCst);
        let ids: Vec<String> = self.inner.services.lock().await.keys().cloned().collect();
        if ids.is_empty() {
            return;
        }
        let mut set = JoinSet::new();
        for id in ids {
            let mgr = self.clone();
            set.spawn(async move {
                let _ = mgr.stop(&id).await;
            });
        }
        let drain = async move { while set.join_next().await.is_some() {} };
        if tokio::time::timeout(SHUTDOWN_ALL_CAP, drain).await.is_err() {
            // Cap exceeded (e.g. a slow stop_cmd) — force-kill survivors.
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
        }
    }
}

// ---------------------------------------------------------------------------
// Supervision internals
// ---------------------------------------------------------------------------

/// Wait until the run reaches a terminal status (or its supervisor is gone,
/// which implies the run finished), bounded by `cap`.
async fn wait_terminal(mut rx: watch::Receiver<RuntimeState>, cap: Duration) -> bool {
    tokio::time::timeout(cap, async move {
        loop {
            if is_terminal(rx.borrow_and_update().status) {
                return;
            }
            if rx.changed().await.is_err() {
                return; // sender dropped ⇒ supervision finished
            }
        }
    })
    .await
    .is_ok()
}

/// Kill a run's whole tree. WSL runs get the in-distro group kill (the
/// Linux tree is unreachable from taskkill); the wsl.exe bridge is
/// taskkilled ONLY on the forced step — on the graceful step the bridge
/// must exit NATURALLY when bash exits, so `wait_terminal` observes real
/// tree death and the ForceKill escalation still runs when the tree
/// ignores SIGTERM (final-review fix, design doc
/// 2026-07-07-wsl-service-execution-design §3).
async fn kill_run_tree(id: &str, pid: u32, wsl: Option<&WslRun>, force: bool) {
    if let Some(w) = wsl {
        match w.pgid.get() {
            Some(&pgid) => {
                if let Err(err) = kill::signal_group_wsl(&w.distro, pgid, force).await {
                    log::warn!(
                        "in-distro kill (force={force}) of '{id}' (distro {}, pgid {pgid}) failed: {err}",
                        w.distro
                    );
                }
            }
            // Stop raced the marker line: nothing to signal in-distro yet;
            // on the forced step the bridge kill below still runs.
            None => log::warn!("'{id}': Linux pgid not captured; cannot signal the in-distro tree"),
        }
        // Final safety net + bridge reap — forced step ONLY. Killing the
        // bridge on the graceful step would EOF the pipes and finalize the
        // run before SIGTERM had its grace window / before ForceKill could
        // escalate on a SIGTERM-ignoring tree.
        if force {
            if let Err(err) = kill::force_kill_tree(pid).await {
                log::warn!("bridge kill (force) of '{id}' (pid {pid}) failed: {err}");
            }
        }
        return;
    }
    let result = if force {
        kill::force_kill_tree(pid).await
    } else {
        kill::terminate_tree(pid).await
    };
    if let Err(err) = result {
        log::warn!("tree kill (force={force}) of '{id}' (pid {pid}) failed: {err}");
    }
}

/// Pump one output pipe into the shared line channel: lossy UTF-8 decode
/// (§21.5 `errors='replace'`), ANSI strip (§21.2), trim, drop empties (§18).
async fn pump_lines<R: AsyncRead + Unpin>(reader: R, tx: mpsc::Sender<String>) {
    let mut reader = BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                let decoded = String::from_utf8_lossy(&buf);
                let stripped = strip_ansi(decoded.as_ref());
                let line = stripped.trim();
                if !line.is_empty() && tx.send(line.to_owned()).await.is_err() {
                    break; // supervisor gone
                }
            }
            Err(err) => {
                log::debug!("output pipe read error: {err}");
                break;
            }
        }
    }
}

/// Per-run supervision task: drives the line state machine and log batching
/// until stream EOF, then runs the bounded exit-wait (§21.2 service /
/// §17.1 install), finalizes the status, logs the v1 exit lines, deregisters
/// and emits the terminal event.
#[allow(clippy::too_many_arguments)]
async fn supervise(
    inner: Arc<Inner>,
    id: String,
    kind: RunKind,
    mut child: Child,
    pid: u32,
    mut line_rx: mpsc::Receiver<String>,
    mut analyzer: LineAnalyzer,
    state_tx: Arc<watch::Sender<RuntimeState>>,
    manually_stopped: Arc<AtomicBool>,
    wsl: Option<WslRun>,
) {
    let emitter = inner.emitter.as_ref();
    let stream = match kind {
        RunKind::Service => LogStream::Service,
        RunKind::Install => LogStream::Install,
    };
    let mut batch = LogBatcher::new(id.clone(), stream);
    let mut flush_timer = tokio::time::interval(LOG_BATCH_FLUSH);
    flush_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // ---- streaming phase: until both pipes EOF (§18) -----------------------
    loop {
        tokio::select! {
            maybe_line = line_rx.recv() => match maybe_line {
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
                    if effects.status_changed.is_some() || effects.port_detected.is_some() {
                        let _ = state_tx.send(RuntimeState {
                            status: analyzer.status(),
                            port: analyzer.port(),
                            exit_code: None,
                        });
                        emit_status(
                            emitter, &id, analyzer.status(), analyzer.port(),
                            Some(pid), None, None,
                        );
                    }
                    if batch.push(line) {
                        batch.flush(emitter); // early flush at 64 lines (§3.2)
                    }
                }
                None => break,
            },
            _ = flush_timer.tick() => batch.flush(emitter), // 75 ms cadence (§3.2)
        }
    }
    batch.flush(emitter);

    // ---- exit phase: bounded wait, then kill (§21.2 / §17.1) --------------
    let (wait_cap, kill_grace) = match kind {
        RunKind::Service => (SERVICE_EXIT_WAIT_AFTER_EOF, super::constants::STOP_FORCE_WAIT),
        RunKind::Install => (INSTALL_WAIT_CAP, INSTALL_KILL_GRACE),
    };
    let exit_code = match tokio::time::timeout(wait_cap, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        Ok(Err(err)) => {
            log::error!("wait() failed for '{id}': {err}");
            None
        }
        Err(_) => {
            // Post-EOF wait cap exceeded — kill the tree and re-wait
            // (v1 install: 600 s cap then kill()+wait(5), §17.1; v1
            // service: 30 s then kill, §21.2).
            if kind == RunKind::Install {
                emit_lines_now(
                    emitter,
                    &id,
                    stream,
                    vec![format!(
                        "[svc] ⚠️ {id} install timed out after 10 min, killing process"
                    )],
                );
            }
            kill_run_tree(&id, pid, wsl.as_ref(), true).await;
            match tokio::time::timeout(kill_grace, child.wait()).await {
                Ok(Ok(status)) => status.code(),
                _ => None, // kill_on_drop reaps the direct child as last resort
            }
        }
    };

    // Capture the pre-finalize status to tell "error pattern matched" apart
    // from "died while still starting" in the terminal event's `error` field
    // (ipc-contract.md §3 — `ServiceStatusPayload.error`).
    let pre_exit_status = analyzer.status();
    let final_status = analyzer.finalize(manually_stopped.load(Ordering::SeqCst));
    let error_message = (final_status == ServiceStatus::Error).then(|| {
        if pre_exit_status == ServiceStatus::Error {
            "error pattern matched".to_owned()
        } else {
            format!(
                "exited while starting, code {}",
                exit_code.map_or_else(|| "unknown".to_owned(), |c| c.to_string())
            )
        }
    });

    // v1 exit log lines (§17.1 install, §18 service), verbatim.
    let exit_line = match kind {
        RunKind::Install => match exit_code {
            Some(0) => format!("[svc] ✅ {id} installed successfully"),
            Some(rc) => format!("[svc] {id} installation finished with exit code: {rc}"),
            None => format!("[svc] {id} installation finished with exit code: unknown"),
        },
        RunKind::Service => format!(
            "[sys] {id} process exited (code {})",
            exit_code.map_or_else(|| "unknown".to_owned(), |c| c.to_string())
        ),
    };
    emit_lines_now(emitter, &id, stream, vec![exit_line]);

    // Deregister FIRST (pid-guarded so a fresh respawn of the same id can
    // never be removed by this finished supervisor), then broadcast the
    // terminal state — stop() waiters hold their own receiver clones.
    {
        let mut services = inner.services.lock().await;
        if services.get(&id).map(|e| e.pid) == Some(pid) {
            services.remove(&id);
        }
    }
    let _ = state_tx.send(RuntimeState {
        status: final_status,
        port: analyzer.port(),
        exit_code,
    });
    emit_status(
        emitter,
        &id,
        final_status,
        analyzer.port(),
        Some(pid),
        exit_code,
        error_message,
    );
}

/// Run a repo-type `stop_cmd` through the platform shell with the service's
/// cwd/env, bounded by `timeout`; captured output is forwarded to the
/// service log as one batch (architecture-v2.md §7.1 fix 4 — v1 never ran
/// `stop_cmd`, §22.6).
async fn run_stop_cmd(emitter: &dyn EventEmitter, id: &str, sc: &StopCommand, timeout: Duration) {
    emit_lines_now(
        emitter,
        id,
        LogStream::Service,
        vec![format!("[svc] Running stop command for {id}: {}", sc.command)],
    );
    // ponytail: a WSL stop_cmd that HANGS leaks its in-distro (setsid'd)
    // process — kill_on_drop only reaches the wsl.exe bridge. Stop commands
    // are short (compose down); revisit with a tracked in-distro kill if a
    // long-running stop_cmd ever ships.
    let (mut cmd, _) = build_command(&sc.command, &sc.cwd, &sc.env, false);
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) => {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let lines: Vec<String> = text
                .lines()
                .map(|l| strip_ansi(l).trim().to_owned())
                .filter(|l| !l.is_empty())
                // WSL stop_cmds run via bash -ilc — drop its no-tty noise (design doc §2)
                .filter(|l| !crate::wsl::is_bash_noise(l))
                .collect();
            emit_lines_now(emitter, id, LogStream::Service, lines);
        }
        Ok(Err(err)) => emit_lines_now(
            emitter,
            id,
            LogStream::Service,
            vec![format!("[svc] stop command for {id} failed: {err}")],
        ),
        Err(_) => emit_lines_now(
            emitter,
            id,
            LogStream::Service,
            vec![format!(
                "[svc] stop command for {id} timed out after {}s",
                timeout.as_secs()
            )],
        ),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::test_support::CollectingEmitter;
    use crate::events::SERVICE_LOG_LINE;

    // -- pure: command building (deliverable: per-platform, no spawn) -------

    #[test]
    fn shell_invocation_windows_uses_cmd_slash_c() {
        assert_eq!(shell_invocation(true), ("cmd", "/C"));
    }

    #[test]
    fn shell_invocation_unix_uses_sh_dash_c() {
        assert_eq!(shell_invocation(false), ("/bin/sh", "-c"));
    }

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
            assert_eq!(args[..8], ["-d", "Ubuntu", "--cd", "/home/j/boa2-frontend",
                                   "--exec", "setsid", "-w", "bash"]);
            assert!(args.last().unwrap().contains("__DEVDECK_PID__"));
            assert!(args.last().unwrap().ends_with("npm start"));
        } else {
            assert!(wsl.is_none(), "non-Windows never routes");
        }
        // Drive-letter / Unix paths never route, any platform.
        let (_, wsl) = build_command("npm start", Path::new(r"C:\repos\app"), &env, true);
        assert!(wsl.is_none());
    }

    // -- pure: install check_dirs semantics (§22.17) -------------------------

    #[test]
    fn is_installed_check_dirs_semantics() {
        let dir = std::env::temp_dir().join(format!("dm2-install-check-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("target")).unwrap();
        // No check_dirs ⇒ always installed (skip auto-install).
        assert!(is_installed(&dir, &[]));
        assert!(is_installed(&dir, &["target".into()]));
        // ALL dirs must exist.
        assert!(!is_installed(&dir, &["target".into(), "node_modules".into()]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -- batching ------------------------------------------------------------

    #[test]
    fn batcher_emits_one_event_with_all_lines_and_clears() {
        let emitter = CollectingEmitter::new();
        let mut batch = LogBatcher::new("svc".into(), LogStream::Service);
        assert!(!batch.push("a".into()));
        assert!(!batch.push("b".into()));
        batch.flush(emitter.as_ref());
        let batches = emitter.payloads(SERVICE_LOG_LINE);
        assert_eq!(batches.len(), 1, "one batch event, not one per line");
        assert_eq!(batches[0]["lines"], serde_json::json!(["a", "b"]));
        assert_eq!(batches[0]["stream"], "service");
        // Flushing an empty batch emits nothing.
        batch.flush(emitter.as_ref());
        assert_eq!(emitter.payloads(SERVICE_LOG_LINE).len(), 1);
    }

    #[test]
    fn batcher_requests_flush_at_the_64_line_cap() {
        let mut batch = LogBatcher::new("svc".into(), LogStream::Install);
        for i in 0..LOG_BATCH_MAX_LINES - 1 {
            assert!(!batch.push(format!("line {i}")));
        }
        assert!(
            batch.push("the 64th".into()),
            "batch must request an early flush at LOG_BATCH_MAX_LINES (§3.2)"
        );
    }

    // -- validation refusals (no process spawned, cross-platform) ------------

    fn collecting_manager() -> (std::sync::Arc<CollectingEmitter>, ProcessManager) {
        let emitter = CollectingEmitter::new();
        let mgr = ProcessManager::new(emitter.clone());
        (emitter, mgr)
    }

    fn svc(id: &str, command: &str) -> ServiceSpec {
        ServiceSpec {
            id: id.into(),
            command: command.into(),
            cwd: std::env::temp_dir(),
            env: HashMap::new(),
            ready_pattern: None,
            error_pattern: None,
            port_patterns: Vec::new(),
            known_port: None,
            stop_cmd: None,
        }
    }

    #[tokio::test]
    async fn empty_command_is_refused() {
        let (_, mgr) = collecting_manager();
        let err = mgr.start_service(svc("x", "   ")).await.unwrap_err();
        assert!(matches!(err, ProcessError::EmptyCommand(_)), "{err:?}");
    }

    #[tokio::test]
    async fn missing_workdir_is_refused() {
        let (_, mgr) = collecting_manager();
        let mut spec = svc("x", "echo hi");
        spec.cwd = PathBuf::from("/definitely/not/a/dir/dm2-tests");
        let err = mgr.start_service(spec).await.unwrap_err();
        assert!(matches!(err, ProcessError::InvalidWorkdir(_)), "{err:?}");
    }

    #[tokio::test]
    async fn stop_of_untracked_id_returns_untracked_and_logs_v1_line() {
        let (emitter, mgr) = collecting_manager();
        assert_eq!(mgr.stop("ghost").await.unwrap(), StopOutcome::Untracked);
        let lines = emitter.log_lines_for("ghost");
        assert_eq!(lines, vec!["[svc] ghost is not running".to_owned()]);
    }

    #[tokio::test]
    async fn untracked_status_is_stopped() {
        let (_, mgr) = collecting_manager();
        assert_eq!(mgr.status("ghost").await, ServiceStatus::Stopped);
        assert!(!mgr.is_running("ghost").await);
    }

    // -- real-process lifecycle (Unix only: relies on /bin/sh) ---------------

    #[cfg(unix)]
    mod unix_lifecycle {
        use super::*;

        /// Poll until the run leaves the registry, then give the supervisor
        /// a beat to emit its terminal event (emitted right after
        /// deregistration).
        async fn wait_finished(mgr: &ProcessManager, id: &str) {
            tokio::time::timeout(Duration::from_secs(15), async {
                while mgr.is_running(id).await {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("run should finish in time");
            tokio::time::sleep(Duration::from_millis(150)).await;
        }

        #[tokio::test]
        async fn service_without_ready_pattern_goes_starting_running_stopped() {
            let (emitter, mgr) = collecting_manager();
            let pid = mgr
                .start_service(svc("echoer", "echo hello-from-test"))
                .await
                .unwrap();
            assert!(pid > 0);
            wait_finished(&mgr, "echoer").await;
            assert_eq!(
                emitter.statuses_for("echoer"),
                vec!["starting", "running", "stopped"]
            );
            assert!(emitter
                .log_lines_for("echoer")
                .iter()
                .any(|l| l == "hello-from-test"));
        }

        #[tokio::test]
        async fn ready_pattern_and_port_detection_drive_the_state_machine() {
            let (emitter, mgr) = collecting_manager();
            let mut spec = svc(
                "web",
                r"printf 'listening on port 1234\nREADY to serve\n'",
            );
            spec.ready_pattern = Some("READY".into());
            spec.port_patterns = vec![r"port\s+(\d+)".into()];
            mgr.start_service(spec).await.unwrap();
            wait_finished(&mgr, "web").await;
            assert_eq!(
                emitter.statuses_for("web"),
                vec!["starting", "starting", "running", "stopped"],
                "port line re-emits starting with the port, then READY flips to running"
            );
            assert_eq!(emitter.last_port_for("web"), Some(1234));
        }

        #[tokio::test]
        async fn error_pattern_yields_error_and_death_while_erroring_stays_error() {
            let (emitter, mgr) = collecting_manager();
            let mut spec = svc("bad", "echo FATAL boom");
            spec.ready_pattern = Some("READY".into());
            spec.error_pattern = Some("FATAL".into());
            mgr.start_service(spec).await.unwrap();
            wait_finished(&mgr, "bad").await;
            let statuses = emitter.statuses_for("bad");
            assert_eq!(statuses.last().map(String::as_str), Some("error"));
            assert!(statuses.contains(&"error".to_owned()));
        }

        #[tokio::test]
        async fn install_lifecycle_emits_installing_then_stopped_with_v1_logs() {
            let (emitter, mgr) = collecting_manager();
            let spec = InstallSpec {
                id: "lib".into(),
                command: "echo installing-stuff".into(),
                cwd: std::env::temp_dir(),
                env: HashMap::new(),
            };
            mgr.install(spec).await.unwrap();
            wait_finished(&mgr, "lib").await;
            assert_eq!(emitter.statuses_for("lib"), vec!["installing", "stopped"]);
            let lines = emitter.log_lines_for("lib");
            assert!(lines
                .iter()
                .any(|l| l == "[svc] Running installation for lib: echo installing-stuff"));
            assert!(lines.iter().any(|l| l.contains("installed successfully")));
        }

        #[tokio::test]
        async fn second_start_of_a_running_id_is_refused() {
            let (_, mgr) = collecting_manager();
            mgr.start_service(svc("dup", "sleep 30")).await.unwrap();
            let err = mgr.start_service(svc("dup", "sleep 30")).await.unwrap_err();
            assert!(matches!(err, ProcessError::AlreadyRunning(_)), "{err:?}");
            mgr.shutdown_all().await;
        }

        #[tokio::test]
        async fn stop_terminates_a_long_running_service_as_stopped_not_error() {
            let (emitter, mgr) = collecting_manager();
            mgr.start_service(svc("sleeper", "sleep 30")).await.unwrap();
            assert!(mgr.is_running("sleeper").await);
            assert_eq!(mgr.stop("sleeper").await.unwrap(), StopOutcome::Stopped);
            wait_finished(&mgr, "sleeper").await;
            // Manual stop while still `running` ⇒ transient `stopping`,
            // final `stopped` (§21.2 + ipc-contract.md §1.4).
            let statuses = emitter.statuses_for("sleeper");
            assert!(statuses.contains(&"stopping".to_owned()));
            assert_eq!(statuses.last().map(String::as_str), Some("stopped"));
        }

        #[tokio::test]
        async fn death_while_starting_reports_error_message() {
            let (emitter, mgr) = collecting_manager();
            let mut spec = svc("flaky", "true"); // exits 0 before any READY line
            spec.ready_pattern = Some("READY".into());
            mgr.start_service(spec).await.unwrap();
            wait_finished(&mgr, "flaky").await;
            let terminal = emitter
                .payloads(crate::events::SERVICE_STATUS_CHANGED)
                .into_iter()
                .filter(|p| p["name"] == "flaky")
                .last()
                .expect("terminal status event");
            assert_eq!(terminal["status"], "error");
            assert_eq!(terminal["error"], "exited while starting, code 0");
        }

        #[tokio::test]
        async fn shutdown_all_is_idempotent_and_blocks_new_spawns() {
            let (_, mgr) = collecting_manager();
            mgr.start_service(svc("a", "sleep 30")).await.unwrap();
            mgr.start_service(svc("b", "sleep 30")).await.unwrap();
            mgr.shutdown_all().await;
            wait_finished(&mgr, "a").await;
            wait_finished(&mgr, "b").await;
            assert!(!mgr.is_running("a").await);
            assert!(!mgr.is_running("b").await);
            // Second call: no tracked services, returns immediately.
            mgr.shutdown_all().await;
            // New spawns are refused after shutdown (§17.1-equivalent guard).
            let err = mgr.start_service(svc("c", "echo hi")).await.unwrap_err();
            assert!(matches!(err, ProcessError::ShuttingDown), "{err:?}");
        }
    }
}
