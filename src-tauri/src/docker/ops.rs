//! High-level async docker/compose operations — the typed port of
//! `core/db_manager.py` (inventory-backend.md §9).
//!
//! All functions swallow failures into defaults / [`OpOutput`] exactly like
//! v1 (§5 backend: returns data/bools, never raises). Log lines keep the v1
//! `[docker]` / `[db]` prefixes byte-compatibly.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::events::DockerServiceState;

use super::exec::{run_compose, run_docker, T_DOWN, T_QUERY, T_UP};
use super::parse;
use super::types::{emit, ComposeService, ContainerInfo, LogSink, OpOutput};

/// `docker info` exit 0 (v1 `is_docker_available`, 10 s).
pub async fn is_docker_available() -> bool {
    matches!(run_docker(&["info"], T_QUERY).await, Ok(out) if out.success)
}

/// True when a container whose name contains `container_name` is running
/// (v1 `is_container_running` — substring match on the filtered `docker ps`
/// output).
pub async fn is_container_running(container_name: &str) -> bool {
    let filter = format!("name={container_name}");
    match run_docker(
        &["ps", "--filter", &filter, "--format", "{{.Names}}"],
        T_QUERY,
    )
    .await
    {
        Ok(out) => out.stdout.contains(container_name),
        Err(_) => false,
    }
}

/// Running containers, optionally filtered by a project prefix SUBSTRING
/// (v1 `get_running_containers`).
pub async fn get_running_containers(project_prefix: &str) -> Vec<ContainerInfo> {
    match run_docker(
        &["ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"],
        T_QUERY,
    )
    .await
    {
        Ok(out) if out.success => parse::parse_running_containers(&out.stdout, project_prefix),
        _ => Vec::new(),
    }
}

/// Parse a compose file's service list (v1 `parse_compose_services`); `[]`
/// on read/parse errors, like v1.
pub async fn parse_compose_services(compose_file: &Path) -> Vec<ComposeService> {
    let Ok(content) = tokio::fs::read_to_string(compose_file).await else {
        return Vec::new();
    };
    parse::parse_compose_yaml(&content).unwrap_or_default()
}

/// `{service: running|stopped}` over ALL services in the file — not-running
/// ⇒ stopped (v1 `get_compose_service_status`, 10 s). `{}` on any failure.
pub async fn get_compose_service_status(
    compose_file: &Path,
) -> BTreeMap<String, DockerServiceState> {
    let all_services = parse_compose_services(compose_file).await;
    if all_services.is_empty() {
        return BTreeMap::new();
    }
    let running = match run_compose(
        compose_file,
        &["ps", "--services", "--filter", "status=running"],
        T_QUERY,
    )
    .await
    {
        Ok(out) if out.success => out.stdout,
        _ => String::new(),
    };
    parse::build_status_map(&all_services, &running)
}

/// Tail logs for one compose service (v1 `docker_compose_logs`, 10 s) —
/// `stdout + "\n" + stderr` like v1.
pub async fn docker_compose_logs(compose_file: &Path, service: &str, tail: u32) -> String {
    let tail_s = tail.to_string();
    match run_compose(
        compose_file,
        &["logs", "--tail", &tail_s, service],
        T_QUERY,
    )
    .await
    {
        Ok(out) => format!("{}\n{}", out.stdout.trim(), out.stderr.trim()),
        Err(e) => format!("Error retrieving logs: {e}"),
    }
}

/// `compose up -d [services…]` (v1 `docker_compose_up`, 120 s).
pub async fn docker_compose_up(
    compose_file: &Path,
    services: Option<&[String]>,
    log: Option<&LogSink>,
) -> OpOutput {
    let fname = file_name(compose_file);
    let svc_str = match services {
        Some(svcs) if !svcs.is_empty() => svcs.join(", "),
        _ => "all".to_string(),
    };
    emit(log, &format!("[docker] Starting {svc_str} from {fname}..."));

    let mut args: Vec<&str> = vec!["up", "-d"];
    if let Some(svcs) = services {
        args.extend(svcs.iter().map(String::as_str));
    }
    match run_compose(compose_file, &args, T_UP).await {
        Ok(out) => {
            let msg = out.combined();
            if out.success {
                emit(log, &format!("[docker] {fname}: Services started"));
            } else {
                emit(log, &format!("[docker] {fname}: FAILED - {msg}"));
            }
            OpOutput { ok: out.success, message: msg }
        }
        Err(e) => {
            emit(log, &format!("[docker] Error: {e}"));
            OpOutput::fail(e.to_string())
        }
    }
}

/// `compose down` (v1 `docker_compose_down`, 60 s). v1 logged
/// "Services stopped" even on failure — kept for parity.
pub async fn docker_compose_down(compose_file: &Path, log: Option<&LogSink>) -> OpOutput {
    let fname = file_name(compose_file);
    emit(log, &format!("[docker] Stopping services from {fname}..."));
    match run_compose(compose_file, &["down"], T_DOWN).await {
        Ok(out) => {
            emit(log, &format!("[docker] {fname}: Services stopped"));
            OpOutput { ok: out.success, message: out.combined() }
        }
        Err(e) => {
            emit(log, &format!("[docker] Error: {e}"));
            OpOutput::fail(e.to_string())
        }
    }
}

/// Start one service (v1 `start_service_compose`).
pub async fn start_service_compose(
    compose_file: &Path,
    service: &str,
    log: Option<&LogSink>,
) -> OpOutput {
    docker_compose_up(compose_file, Some(&[service.to_string()]), log).await
}

/// Stop one service via `compose stop <service>` (60 s), or the whole stack
/// via `down` when no service is given (v1 `stop_service_compose`).
pub async fn stop_service_compose(
    compose_file: &Path,
    service: Option<&str>,
    log: Option<&LogSink>,
) -> OpOutput {
    let Some(service) = service else {
        return docker_compose_down(compose_file, log).await;
    };
    emit(log, &format!("[docker] Stopping {service}..."));
    match run_compose(compose_file, &["stop", service], T_DOWN).await {
        Ok(out) => OpOutput { ok: out.success, message: out.combined() },
        Err(e) => {
            emit(log, &format!("[docker] Error stopping {service}: {e}"));
            OpOutput::fail(e.to_string())
        }
    }
}

/// Find the compose file of an infra repo (v1 `_get_compose_file`):
/// `docker-compose*.yml` + `docker-compose*.yaml` in `infra_path`, preferring
/// the first whose PATH contains `mysql`, else the first. `None` if none.
pub fn find_compose_file(infra_path: &Path) -> Option<PathBuf> {
    let Ok(entries) = std::fs::read_dir(infra_path) else { return None };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            name.starts_with("docker-compose")
                && (name.ends_with(".yml") || name.ends_with(".yaml"))
                && p.is_file()
        })
        .collect();
    files.sort(); // deterministic (v1 glob order was OS-dependent)
    files
        .iter()
        .find(|p| p.to_string_lossy().contains("mysql"))
        .or_else(|| files.first())
        .cloned()
}

/// Start MySQL: `up -d mysqldb` from the infra repo's compose file
/// (v1 `start_mysql`).
pub async fn start_mysql(infra_path: &Path, log: Option<&LogSink>) -> OpOutput {
    let Some(compose_file) = find_compose_file(infra_path) else {
        let msg = format!("No docker-compose file found in {}", infra_path.display());
        emit(log, &format!("[db] {msg}"));
        return OpOutput::fail(msg);
    };
    docker_compose_up(&compose_file, Some(&["mysqldb".to_string()]), log).await
}

/// Stop the infra stack (v1 `stop_mysql` — a full `down`).
pub async fn stop_mysql(infra_path: &Path, log: Option<&LogSink>) -> OpOutput {
    let Some(compose_file) = find_compose_file(infra_path) else {
        return OpOutput::fail("No docker-compose file found");
    };
    docker_compose_down(&compose_file, log).await
}

/// True when any running container's name contains `mysql` or `mysqldb`,
/// case-insensitive (v1 `is_mysql_running`).
pub async fn is_mysql_running() -> bool {
    get_running_containers("")
        .await
        .iter()
        .any(|c| {
            let name = c.name.to_lowercase();
            name.contains("mysql") || name.contains("mysqldb")
        })
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_infra(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dm2-docker-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn find_compose_file_prefers_mysql_path() {
        let dir = temp_infra("find");
        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::write(dir.join("docker-compose.mysql.yaml"), "services: {}\n").unwrap();
        std::fs::write(dir.join("unrelated.yml"), "x: 1\n").unwrap();
        let found = find_compose_file(&dir).unwrap();
        assert!(found.to_string_lossy().contains("mysql"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_compose_file_falls_back_to_first_sorted() {
        let dir = temp_infra("first");
        std::fs::write(dir.join("docker-compose.zz.yml"), "").unwrap();
        std::fs::write(dir.join("docker-compose.aa.yml"), "").unwrap();
        let found = find_compose_file(&dir).unwrap();
        assert!(found.ends_with("docker-compose.aa.yml"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_compose_file_none_when_absent() {
        let dir = temp_infra("none");
        assert_eq!(find_compose_file(&dir), None);
        assert_eq!(find_compose_file(Path::new("/definitely/missing/dm2")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn parse_compose_services_missing_file_is_empty() {
        let missing = Path::new("/definitely/missing/docker-compose.yml");
        assert!(parse_compose_services(missing).await.is_empty());
        assert!(get_compose_service_status(missing).await.is_empty());
    }
}
