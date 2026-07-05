//! Docker commands (ipc-contract.md §2.8).
//!
//! Compose operation logs flow through `service://log-line` with
//! `stream: "docker"`; the log `name` is the compose file's repo directory
//! (its parent's basename) so lines land on the owning card.
//!
//! Mutations resolve with `OpOutput { ok, message }` — domain failures never
//! reject (ipc-contract.md §1.3); only infrastructure failures would
//! (`kind: "docker"`), and the ops layer folds those too (v1 parity).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::error::CmdResult;
use super::{op_log_sink, path_basename};
use crate::docker::{self, ComposeService, OpOutput, StatusTarget};
use crate::events::{
    DockerSelectionPayload, DockerServiceState, EventEmitter, LogStream, DOCKER_SELECTION,
};
use crate::state::AppState;

/// Log `name` for a compose operation: the repo directory containing the
/// compose file (falls back to the file's own basename at a filesystem root).
fn compose_card_name(compose_file: &Path) -> String {
    compose_file
        .parent()
        .filter(|p| p.file_name().is_some())
        .map(|p| path_basename(p))
        .unwrap_or_else(|| path_basename(compose_file))
}

/// Fold per-service [`OpOutput`]s into one: `ok` when ALL succeeded,
/// messages joined with newlines (used by `docker_compose_stop` over a
/// service list). Pure — unit-tested below.
fn fold_op_outputs(outputs: Vec<OpOutput>) -> OpOutput {
    let ok = outputs.iter().all(|o| o.ok);
    let message = outputs
        .iter()
        .map(|o| o.message.as_str())
        .filter(|m| !m.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    OpOutput { ok, message }
}

/// #47 `docker_available` → `boolean` (`docker info`, never rejects).
#[tauri::command]
pub async fn docker_available() -> CmdResult<bool> {
    Ok(docker::is_docker_available().await)
}

/// #48 `docker_compose_services { composeFile }` → `ComposeService[]`.
#[tauri::command]
pub async fn docker_compose_services(compose_file: String) -> CmdResult<Vec<ComposeService>> {
    Ok(docker::parse_compose_services(Path::new(&compose_file)).await)
}

/// #49 `docker_compose_up { composeFile, services? }` → `OpOutput`
/// (`compose up -d`, 120 s timeout).
#[tauri::command]
pub async fn docker_compose_up(
    app: tauri::AppHandle,
    compose_file: String,
    services: Option<Vec<String>>,
) -> CmdResult<OpOutput> {
    let file = PathBuf::from(compose_file);
    let sink = op_log_sink(app, compose_card_name(&file), LogStream::Docker);
    Ok(docker::docker_compose_up(&file, services.as_deref(), Some(&sink)).await)
}

/// #50 `docker_compose_stop { composeFile, services? }` → `OpOutput`
/// (`docker::stop_service_compose`, 60 s per service).
///
/// v1 semantics: no services ⇒ the whole stack goes down; with services,
/// each is stopped via `compose stop <svc>` and the results are folded
/// (`ok` = all ok).
#[tauri::command]
pub async fn docker_compose_stop(
    app: tauri::AppHandle,
    compose_file: String,
    services: Option<Vec<String>>,
) -> CmdResult<OpOutput> {
    let file = PathBuf::from(compose_file);
    let sink = op_log_sink(app, compose_card_name(&file), LogStream::Docker);

    let services = services.unwrap_or_default();
    if services.is_empty() {
        return Ok(docker::stop_service_compose(&file, None, Some(&sink)).await);
    }
    let mut outputs = Vec::with_capacity(services.len());
    for service in &services {
        outputs
            .push(docker::stop_service_compose(&file, Some(service.as_str()), Some(&sink)).await);
    }
    Ok(fold_op_outputs(outputs))
}

/// #51 `docker_compose_down { composeFile }` → `OpOutput`
/// (`compose down`, 60 s).
#[tauri::command]
pub async fn docker_compose_down(
    app: tauri::AppHandle,
    compose_file: String,
) -> CmdResult<OpOutput> {
    let file = PathBuf::from(compose_file);
    let sink = op_log_sink(app, compose_card_name(&file), LogStream::Docker);
    Ok(docker::docker_compose_down(&file, Some(&sink)).await)
}

/// #52 `docker_compose_status { composeFile, services }` →
/// `Record<string, DockerServiceState>` (on-demand; the 15 s poll also
/// pushes `docker://status`).
///
/// The ops layer reports ALL services in the file; the result is scoped to
/// the requested `services` (empty list ⇒ all), with requested-but-unknown
/// names reported `stopped` (v1: not-running ⇒ stopped).
#[tauri::command]
pub async fn docker_compose_status(
    compose_file: String,
    services: Vec<String>,
) -> CmdResult<BTreeMap<String, DockerServiceState>> {
    let full = docker::get_compose_service_status(Path::new(&compose_file)).await;
    if services.is_empty() {
        return Ok(full);
    }
    Ok(services
        .into_iter()
        .map(|name| {
            let state = full
                .get(&name)
                .copied()
                .unwrap_or(DockerServiceState::Stopped);
            (name, state)
        })
        .collect())
}

/// #53 `docker_compose_logs { composeFile, service, tail }` → `string`
/// (`stdout + "\n" + stderr`, v1 parity).
#[tauri::command]
pub async fn docker_compose_logs(
    compose_file: String,
    service: String,
    tail: u32,
) -> CmdResult<String> {
    Ok(docker::docker_compose_logs(Path::new(&compose_file), &service, tail).await)
}

/// #54 `docker_refresh_status { repoName, composeFile, services }` →
/// `void` — forces one poll; the result arrives as a `docker://status`
/// event. The poll reports ALL services in the file (a superset of
/// `services` — the frontend store filters), so the list is accepted for
/// contract compliance but not needed Rust-side.
#[tauri::command]
pub async fn docker_refresh_status(
    app: tauri::AppHandle,
    repo_name: String,
    compose_file: String,
    services: Vec<String>,
) -> CmdResult<()> {
    let _ = services; // superset emitted — see doc comment
    let target = StatusTarget {
        name: repo_name,
        compose_file: PathBuf::from(compose_file),
    };
    docker::refresh_status(&app, &target).await;
    Ok(())
}

/// #55 `docker_log_start { serviceId }` → `void` (docker live-logs, design doc
/// 2026-07-05): attach a viewer to a compose service's live `logs -f` stream.
/// The first attach spawns the follower; later attaches (a second window)
/// share it. `serviceId` is the self-describing `docker::<file>::<service>`
/// id — also the `?log=` value and `LogCache` key, so the existing backlog +
/// detached-window pipeline carries docker logs with zero extra plumbing.
#[tauri::command]
pub async fn docker_log_start(
    state: tauri::State<'_, AppState>,
    service_id: String,
) -> CmdResult<()> {
    state.docker_logs.attach(&service_id);
    Ok(())
}

/// #56 `docker_log_stop { serviceId }` → `void`: detach a viewer. The LAST
/// detach kills the `logs -f` process, so nothing runs for a log nobody is
/// watching (the laziness the feature is built around).
#[tauri::command]
pub async fn docker_log_stop(
    state: tauri::State<'_, AppState>,
    service_id: String,
) -> CmdResult<()> {
    state.docker_logs.detach(&service_id);
    Ok(())
}

/// #57 `set_docker_selection { repoName, file, services, active }` → `void`:
/// pure relay that re-emits the docker selection as `docker://selection` so the
/// main window folds it into card state. The docker-compose dialog runs in its
/// own isolated webview and cannot touch the main window's `WorkspaceStore`
/// directly; routing through Rust keeps the events-are-Rust-only rule intact
/// (design doc 2026-07-05 §selection).
#[tauri::command]
pub async fn set_docker_selection(
    state: tauri::State<'_, AppState>,
    repo_name: String,
    file: String,
    services: Vec<String>,
    active: bool,
) -> CmdResult<()> {
    let payload = DockerSelectionPayload { repo_name, file, services, active };
    if let Ok(value) = serde_json::to_value(&payload) {
        state.emitter.emit(DOCKER_SELECTION, value);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_is_ok_only_when_all_ok() {
        let folded = fold_op_outputs(vec![OpOutput::ok("a"), OpOutput::ok("b")]);
        assert!(folded.ok);
        assert_eq!(folded.message, "a\nb");

        let folded = fold_op_outputs(vec![OpOutput::ok("a"), OpOutput::fail("boom")]);
        assert!(!folded.ok);
        assert_eq!(folded.message, "a\nboom");
    }

    #[test]
    fn fold_skips_empty_messages() {
        let folded = fold_op_outputs(vec![OpOutput::ok(""), OpOutput::ok("done")]);
        assert!(folded.ok);
        assert_eq!(folded.message, "done");
    }

    #[test]
    fn fold_of_nothing_is_ok_and_empty() {
        let folded = fold_op_outputs(Vec::new());
        assert!(folded.ok);
        assert!(folded.message.is_empty());
    }

    #[test]
    fn compose_card_name_is_parent_dir() {
        assert_eq!(
            compose_card_name(Path::new("/ws/infra/docker-compose.yml")),
            "infra"
        );
        // Filesystem root → fall back to the file itself.
        assert_eq!(
            compose_card_name(Path::new("/docker-compose.yml")),
            "docker-compose.yml"
        );
    }
}
