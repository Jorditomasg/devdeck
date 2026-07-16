//! Process supervision commands (ipc-contract.md §2.3).
//!
//! All four mutating commands return immediately; progress and results
//! arrive via `service://status-changed` / `service://log-line`. They
//! reject (`kind: "process"`) only when the spec cannot be built (unknown
//! id, no command) or the id is already active.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::State;

use super::error::{AppError, CmdResult};
use crate::config::AppConfig;
use crate::domain::RepoInfo;
use crate::java;
use crate::process::constants::SHUTDOWN_ALL_CAP;
use crate::process::{
    InstallSpec, ServiceSnapshot, ServiceSpec, StopCommand, StopOutcome,
};
use crate::state::AppState;

/// Card restart delay for ordinary processes (inventory-gui.md §28).
pub(crate) const RESTART_DELAY: Duration = Duration::from_millis(300);

// RESTART_DELAY_DOCKER deleted — the value now lives in docker-infra.yml
// as run.restart_delay_ms.

/// #3 `start_service { serviceId, javaLabel? }`.
#[tauri::command]
pub async fn start_service(
    state: State<'_, AppState>,
    service_id: String,
    java_label: Option<String>,
) -> CmdResult<()> {
    let config = load_config(&state);
    let repo = find_repo(&state, &service_id)?;
    let env = java_env_from_config(&config, java_label.as_deref());
    let override_cmd = resolved_command_override(&config, &repo.name);
    let spec = build_service_spec(&repo, &service_id, override_cmd.as_deref(), env)?;
    state.process.start_service(spec).await?;
    Ok(())
}

/// #4 `stop_service { serviceId }` — graceful `stop_cmd` (when declared) +
/// tree-kill with SIGTERM→SIGKILL escalation happens inside the manager;
/// an UNTRACKED id (e.g. detached docker-infra stack after an app restart)
/// falls back to running the repo's `stop_cmd` directly. The whole stop
/// (incl. the fallback) runs detached so the command returns immediately —
/// progress arrives via `service://status-changed` (contract §2.3,
/// "all mutating commands return immediately").
#[tauri::command]
pub async fn stop_service(state: State<'_, AppState>, service_id: String) -> CmdResult<()> {
    let process = state.process.clone();
    let fallback_stop = state
        .find_repo_for_service(&service_id)
        .and_then(|repo| untracked_stop_command(&repo));

    tauri::async_runtime::spawn(async move {
        match process.stop(&service_id).await {
            // Only a genuinely UNTRACKED id gets the stop_cmd fallback — a
            // tracked-but-terminal run (e.g. crashed compose) already had
            // its stop_cmd chance (process::StopOutcome doc).
            Ok(StopOutcome::Untracked) => {
                if let Some(stop_cmd) = fallback_stop {
                    process.run_stop_command(&service_id, &stop_cmd).await;
                }
            }
            Ok(StopOutcome::Stopped | StopOutcome::AlreadyTerminal) => {}
            Err(err) => log::warn!("stop_service {service_id}: {err}"),
        }
    });
    Ok(())
}

/// #5 `restart_service { serviceId, javaLabel? }` —
/// stop + delayed start (300 ms process / 2000 ms docker, inventory-gui.md §28).
/// The spec is validated up-front (so bad input still rejects); the
/// stop/sleep/start sequence runs detached so the command returns
/// immediately per contract.
#[tauri::command]
pub async fn restart_service(
    state: State<'_, AppState>,
    service_id: String,
    java_label: Option<String>,
) -> CmdResult<()> {
    let config = load_config(&state);
    let repo = find_repo(&state, &service_id)?;
    let env = java_env_from_config(&config, java_label.as_deref());
    let override_cmd = resolved_command_override(&config, &repo.name);
    let spec = build_service_spec(&repo, &service_id, override_cmd.as_deref(), env)?;
    let delay = restart_delay(&repo);
    let process = state.process.clone();
    let fallback_stop = untracked_stop_command(&repo);

    tauri::async_runtime::spawn(async move {
        let id = spec.id.clone();
        // Capture the last detected port BEFORE stopping — the supervisor
        // deregisters the entry on exit, so it is unreadable afterwards.
        let port = process.port_of(&id).await;
        match process.stop(&id).await {
            // Untracked only — see stop_service for the rationale.
            Ok(StopOutcome::Untracked) => {
                if let Some(stop_cmd) = fallback_stop {
                    process.run_stop_command(&id, &stop_cmd).await;
                }
            }
            Ok(StopOutcome::Stopped | StopOutcome::AlreadyTerminal) => {}
            Err(err) => log::warn!("restart {id}: stop phase failed: {err}"),
        }
        // stop() returning does not guarantee the socket was released (a
        // tree member may have survived the kill) — without this guard the
        // relaunch races the old listener and dies with "port in use".
        if let Some(port) = port {
            process.wait_port_free(&id, port).await;
        }
        tokio::time::sleep(delay).await;
        if let Err(err) = process.start_service(spec).await {
            log::error!("restart {id}: start phase failed: {err}");
        }
    });
    Ok(())
}

/// #6 `install_dependencies { serviceId, reinstall, javaLabel? }` —
/// `install_cmd` / OS-resolved `reinstall_cmd`, 600 s cap + 5 s kill grace
/// (`process::constants`); the shared registry makes install and run of the
/// same id mutually exclusive (inventory-backend.md §17.1).
#[tauri::command]
pub async fn install_dependencies(
    state: State<'_, AppState>,
    service_id: String,
    reinstall: bool,
    java_label: Option<String>,
) -> CmdResult<()> {
    let repo = find_repo(&state, &service_id)?;
    let command = if reinstall {
        repo.run_reinstall_cmd.clone()
    } else {
        repo.run_install_cmd.clone()
    };
    let command = command
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| {
            AppError::process(format!(
                "no {} command defined for service '{service_id}'",
                if reinstall { "reinstall" } else { "install" }
            ))
        })?;

    let env = java_env_from_config(&load_config(&state), java_label.as_deref());
    state
        .process
        .install(InstallSpec {
            id: service_id,
            command,
            cwd: PathBuf::from(&repo.path),
            env,
        })
        .await?;
    Ok(())
}

/// #7 `list_services` → `ServiceSnapshot[]` — registry snapshot so a
/// restarted frontend re-hydrates without losing running services
/// (architecture-v2.md §2).
#[tauri::command]
pub async fn list_services(state: State<'_, AppState>) -> CmdResult<Vec<ServiceSnapshot>> {
    Ok(state.process.snapshots().await)
}

/// #8 `stop_all_services` — stop every tracked service concurrently,
/// bounded by `SHUTDOWN_ALL_CAP` (30 s).
///
/// Deliberately NOT `ProcessManager::shutdown_all`: that latches the
/// manager's shutting-down flag and refuses every later spawn — correct for
/// app exit (where `lib.rs` wires it), wrong for the Global Panel's
/// "Stop All" button, after which the user keeps starting services.
/// Observable semantics (everything stopped, ≤30 s) match the contract.
#[tauri::command]
pub async fn stop_all_services(state: State<'_, AppState>) -> CmdResult<()> {
    let ids: Vec<String> = state
        .process
        .snapshots()
        .await
        .into_iter()
        .map(|s| s.id)
        .collect();
    let process = state.process.clone();
    let timed_out = tokio::time::timeout(SHUTDOWN_ALL_CAP, async move {
        let mut handles = Vec::new();
        for id in ids {
            let p = process.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                if let Err(err) = p.stop(&id).await {
                    log::warn!("stop_all: failed to stop {id}: {err}");
                }
            }));
        }
        for handle in handles {
            let _ = handle.await;
        }
    })
    .await
    .is_err();

    if timed_out {
        // Cap exceeded (e.g. a slow stop_cmd) — force-kill the survivors,
        // mirroring `ProcessManager::shutdown_all` (inventory-backend.md
        // §21.4: nothing may outlive the stop-all).
        for snapshot in state.process.snapshots().await {
            let Some(pid) = snapshot.pid else { continue };
            if let Err(err) = crate::process::kill::force_kill_tree(pid).await {
                log::warn!(
                    "stop_all: force-kill of survivor {} (pid {pid}) failed: {err}",
                    snapshot.id
                );
            }
        }
    }
    Ok(())
}

/// `is_installed { path, checkDirs }` → `boolean` — the
/// `ui.install.check_dirs` probe (inventory-backend.md §17.1, §22.17): the
/// repo counts as installed when ALL listed dirs exist; an EMPTY list always
/// counts as installed. Lets the frontend decide whether to offer
/// auto-install before `start_service` (ipc-contract.md §2.3 #59).
#[tauri::command]
pub async fn is_installed(path: String, check_dirs: Vec<String>) -> CmdResult<bool> {
    Ok(crate::process::is_installed(Path::new(&path), &check_dirs))
}

// ---------------------------------------------------------------------------
// Spec building (pure where possible — unit-tested below)
// ---------------------------------------------------------------------------

fn find_repo(state: &State<'_, AppState>, service_id: &str) -> Result<RepoInfo, AppError> {
    state.find_repo_for_service(service_id).ok_or_else(|| {
        AppError::process(format!(
            "unknown service id '{service_id}' — repo not in the last scan"
        ))
    })
}

fn load_config(state: &State<'_, AppState>) -> AppConfig {
    state.config.load().unwrap_or_else(|err| {
        log::warn!("process command: config unavailable, using defaults: {err}");
        AppConfig::default()
    })
}

/// Resolve a JDK display label to launch-env overrides through the
/// `java_versions` registry (ipc-contract.md §2.3 #3). Unknown labels mean
/// system default → no overrides.
pub(crate) fn java_env_from_config(
    config: &AppConfig,
    java_label: Option<&str>,
) -> HashMap<String, String> {
    match java_label {
        Some(label) if !label.is_empty() => config
            .java_versions
            .get(label)
            .map(|home| java::build_java_env(home))
            .unwrap_or_default(),
        _ => HashMap::new(),
    }
}

/// Resolve the active command-profile line for a repo (`None` = repo default).
fn resolved_command_override(config: &AppConfig, repo_name: &str) -> Option<String> {
    let name = config.repo_state.get(repo_name)?.command_profile.as_ref()?;
    config.command_profiles_for(repo_name).get(name).cloned()
}

/// Build the `ServiceSpec` from the scanned `RepoInfo` + per-start
/// override (ipc-contract.md §2.3 #3). Rejects (`kind: "process"`) when
/// neither a command override nor a detected `run_command` exists.
pub(crate) fn build_service_spec(
    repo: &RepoInfo,
    service_id: &str,
    command_override: Option<&str>,
    env: HashMap<String, String>,
) -> Result<ServiceSpec, AppError> {
    let command = command_override
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned)
        .or_else(|| repo.run_command.clone().filter(|c| !c.trim().is_empty()))
        .ok_or_else(|| {
            AppError::process(format!("no run command defined for service '{service_id}'"))
        })?;

    Ok(ServiceSpec {
        id: service_id.to_owned(),
        command,
        cwd: PathBuf::from(&repo.path),
        env,
        ready_pattern: repo.ready_pattern.clone(),
        error_pattern: repo.error_pattern.clone(),
        port_patterns: repo.port_patterns.clone(),
        known_port: repo.server_port,
        stop_cmd: repo.stop_command.clone(),
    })
}

/// `stop_cmd` fallback for an UNTRACKED service (detached docker-infra
/// stack): command + repo cwd, no env overrides.
pub(crate) fn untracked_stop_command(repo: &RepoInfo) -> Option<StopCommand> {
    repo.stop_command
        .as_ref()
        .filter(|c| !c.trim().is_empty())
        .map(|c| StopCommand {
            command: c.clone(),
            cwd: PathBuf::from(&repo.path),
            env: HashMap::new(),
        })
}

/// Restart delay for a repo: the type's declared `restart_delay_ms`, else
/// 300 ms (inventory-gui.md §28 card restart delays).
pub(crate) fn restart_delay(repo: &RepoInfo) -> Duration {
    repo.restart_delay_ms
        .map(Duration::from_millis)
        .unwrap_or(RESTART_DELAY)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str) -> RepoInfo {
        RepoInfo {
            name: name.into(),
            path: format!("/ws/{name}"),
            run_command: Some("mvn spring-boot:run".into()),
            ready_pattern: Some("Started .* in".into()),
            server_port: Some(8080),
            ..Default::default()
        }
    }

    /// Alias matching the plan's helper name used in the new tests.
    fn test_repo_with_run_command(cmd: &str) -> RepoInfo {
        RepoInfo {
            name: "svc".into(),
            path: "/ws/svc".into(),
            run_command: Some(cmd.into()),
            ..Default::default()
        }
    }

    #[test]
    fn command_override_replaces_base() {
        let repo = test_repo_with_run_command("mvn spring-boot:run");
        let spec = build_service_spec(&repo, "svc", Some("mvn -Pbatch spring-boot:run --job=x"), HashMap::new()).unwrap();
        assert_eq!(spec.command, "mvn -Pbatch spring-boot:run --job=x");
    }

    #[test]
    fn no_override_uses_repo_default() {
        let repo = test_repo_with_run_command("mvn spring-boot:run");
        let spec = build_service_spec(&repo, "svc", None, HashMap::new()).unwrap();
        assert_eq!(spec.command, "mvn spring-boot:run");
    }

    #[test]
    fn blank_override_uses_repo_default() {
        let repo = test_repo_with_run_command("mvn spring-boot:run");
        let spec = build_service_spec(&repo, "svc", Some("  "), HashMap::new()).unwrap();
        assert_eq!(spec.command, "mvn spring-boot:run");
    }

    #[test]
    fn no_command_at_all_rejects_with_process_kind() {
        let mut r = repo("api");
        r.run_command = None;
        let err = build_service_spec(&r, "api", None, HashMap::new()).unwrap_err();
        assert_eq!(err.kind, "process");
        assert!(err.message.contains("api"));
    }

    #[test]
    fn build_spec_id_and_port_forwarded() {
        let spec =
            build_service_spec(&repo("api"), "api", Some("  npm start  "), HashMap::new())
                .unwrap();
        assert_eq!(spec.command, "npm start");
        assert_eq!(spec.id, "api");
        assert_eq!(spec.known_port, Some(8080));
    }

    #[test]
    fn restart_delay_uses_declared_value_then_default() {
        let mut r = RepoInfo {
            restart_delay_ms: Some(2000),
            ..Default::default()
        };
        assert_eq!(restart_delay(&r), Duration::from_millis(2000));
        r.restart_delay_ms = None;
        assert_eq!(restart_delay(&r), Duration::from_millis(300));
    }

    #[test]
    fn java_env_ignores_unknown_labels() {
        let mut config = AppConfig::default();
        config
            .java_versions
            .insert("Java 17 (jdk-17)".into(), "/nonexistent/jdk".into());

        assert!(java_env_from_config(&config, None).is_empty());
        assert!(java_env_from_config(&config, Some("Java 99")).is_empty());
        // Known label but invalid dir → build_java_env returns empty
        // (unmodified environment).
        assert!(java_env_from_config(&config, Some("Java 17 (jdk-17)")).is_empty());
    }

    #[test]
    fn untracked_stop_command_only_when_declared() {
        let mut r = repo("infra");
        assert!(untracked_stop_command(&r).is_none());
        r.stop_command = Some("docker-compose down".into());
        let stop = untracked_stop_command(&r).unwrap();
        assert_eq!(stop.command, "docker-compose down");
        assert_eq!(stop.cwd, PathBuf::from("/ws/infra"));
    }
}
