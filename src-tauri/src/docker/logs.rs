//! Live `docker compose logs -f` streaming into the shared `LogCache` +
//! `service://log-line` pipeline (design doc 2026-07-05 docker-live-logs).
//!
//! Unlike the one-shot `docker_compose_logs` snapshot, this follows a compose
//! service in real time so the docker log surface behaves like every other
//! log: seeded from `get_log_backlog`, kept fresh by live events, detachable
//! via `open_log_window`.
//!
//! Laziness contract (the whole point): a stream exists ONLY while at least
//! one viewer (the in-dialog panel or a detached window) is attached. Attach
//! is ref-counted per synthetic id, so two viewers of the same log share ONE
//! `logs -f` process (no duplicate lines); the process is killed the moment
//! the last viewer detaches. Nothing runs for docker logs nobody is watching.
//!
//! Synthetic id (also the `?log=` value and `LogCache` key), self-describing
//! so a freshly-loaded detached window can re-attach from the id alone:
//! `docker::<composeFile>::<service>` (empty `<service>` = whole stack). No
//! path contains `::` and no compose service name contains `::`, so the id
//! splits unambiguously on the LAST `::`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader, Lines};
use tokio::task::JoinHandle;

use crate::events::{now_ms, EventEmitter, LogStream, ServiceLogPayload};
use crate::process::line_machine::strip_ansi;

use super::exec::compose_streaming_command;

/// Recent lines replayed by `logs -f --tail` when a stream starts — matches
/// the per-service `LogCache` cap, so the window backlog is naturally full.
const START_TAIL: u32 = 500;

/// The `docker::` prefix that marks a synthetic docker-log service id.
pub const DOCKER_LOG_PREFIX: &str = "docker::";

/// One live stream: the follower task plus how many viewers hold it open.
struct Stream {
    task: JoinHandle<()>,
    refs: usize,
}

/// Ref-counted registry of live `docker compose logs -f` followers, keyed by
/// synthetic id. Held in `AppState`; every read/mutate goes through the mutex
/// (the guard is never held across an await — the spawn is synchronous).
pub struct DockerLogManager {
    emitter: Arc<dyn EventEmitter>,
    streams: Mutex<HashMap<String, Stream>>,
}

impl DockerLogManager {
    pub fn new(emitter: Arc<dyn EventEmitter>) -> Self {
        DockerLogManager { emitter, streams: Mutex::new(HashMap::new()) }
    }

    /// Attach a viewer to `service_id`'s live log, starting the follower on the
    /// first attach and just bumping the ref-count on later ones. No-op (and no
    /// stream) when the id is not a docker-log id.
    pub fn attach(&self, service_id: &str) {
        let Some((compose_file, service)) = parse_docker_log_id(service_id) else {
            return;
        };
        let mut streams = self.streams.lock().expect("docker log registry poisoned");
        if let Some(stream) = streams.get_mut(service_id) {
            stream.refs += 1;
            return;
        }
        let task = spawn_follower(
            self.emitter.clone(),
            service_id.to_string(),
            compose_file,
            service,
        );
        streams.insert(service_id.to_string(), Stream { task, refs: 1 });
    }

    /// Detach a viewer; the last detach aborts the follower task (dropping its
    /// child, which is `kill_on_drop`, so the `logs -f` process dies).
    pub fn detach(&self, service_id: &str) {
        let mut streams = self.streams.lock().expect("docker log registry poisoned");
        if let Some(stream) = streams.get_mut(service_id) {
            stream.refs = stream.refs.saturating_sub(1);
            if stream.refs == 0 {
                if let Some(stream) = streams.remove(service_id) {
                    stream.task.abort();
                }
            }
        }
    }
}

/// Split a `docker::<file>::<service>` id into `(compose_file, service)`.
/// `None` for anything without the prefix. Service may be empty (whole stack).
/// Splits on the LAST `::` because a file path never contains `::` and a
/// compose service name never contains `::`.
fn parse_docker_log_id(service_id: &str) -> Option<(PathBuf, Option<String>)> {
    let rest = service_id.strip_prefix(DOCKER_LOG_PREFIX)?;
    let (file, service) = rest.rsplit_once("::")?;
    let service = if service.is_empty() { None } else { Some(service.to_string()) };
    Some((PathBuf::from(file), service))
}

/// Spawn the follower task: run `compose logs -f --tail=500 [service]` and pump
/// each stdout/stderr line (ANSI-stripped) through the emitter as a
/// single-line `service://log-line` batch under `service_id`. The emitter both
/// forwards to the Tauri bus AND mirrors into `LogCache`, so attached viewers
/// and later `get_log_backlog` seeds both see the lines.
fn spawn_follower(
    emitter: Arc<dyn EventEmitter>,
    service_id: String,
    compose_file: PathBuf,
    service: Option<String>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let tail = START_TAIL.to_string();
        let mut args: Vec<&str> = vec!["logs", "-f", "--tail", &tail];
        if let Some(svc) = &service {
            args.push(svc.as_str());
        }
        let mut cmd = compose_streaming_command(&compose_file, &args).await;

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                emit_line(&emitter, &service_id, &format!("[docker] log stream error: {err}"));
                return;
            }
        };

        // Merge stdout + stderr into one line stream (compose interleaves both).
        let mut out = child.stdout.take().map(|s| BufReader::new(s).lines());
        let mut err = child.stderr.take().map(|s| BufReader::new(s).lines());
        loop {
            let (line, is_out) = tokio::select! {
                l = next_line(&mut out), if out.is_some() => (l, true),
                l = next_line(&mut err), if err.is_some() => (l, false),
                else => break,
            };
            match line {
                Some(l) => emit_line(&emitter, &service_id, strip_ansi(&l).trim_end()),
                None if is_out => out = None,
                None => err = None,
            }
            if out.is_none() && err.is_none() {
                break;
            }
        }
    })
}

/// Next line from an optional reader (`None` reader never resolves — the
/// `if …is_some()` select guard keeps it from being polled).
async fn next_line<R: AsyncBufRead + Unpin>(reader: &mut Option<Lines<R>>) -> Option<String> {
    match reader {
        Some(r) => r.next_line().await.ok().flatten(),
        None => None,
    }
}

/// Emit one already-decoded, non-empty line as a single-line docker log batch.
fn emit_line(emitter: &Arc<dyn EventEmitter>, service_id: &str, line: &str) {
    if line.is_empty() {
        return;
    }
    emitter.emit_log(&ServiceLogPayload {
        name: service_id.to_string(),
        stream: LogStream::Docker,
        lines: vec![line.to_string()],
        timestamp_ms: now_ms(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_file_and_service() {
        let (file, svc) = parse_docker_log_id("docker::/ws/infra/docker-compose.yml::api").unwrap();
        assert_eq!(file, PathBuf::from("/ws/infra/docker-compose.yml"));
        assert_eq!(svc, Some("api".to_string()));
    }

    #[test]
    fn empty_service_is_whole_stack() {
        let (file, svc) = parse_docker_log_id("docker::/ws/dc.yml::").unwrap();
        assert_eq!(file, PathBuf::from("/ws/dc.yml"));
        assert_eq!(svc, None);
    }

    #[test]
    fn windows_path_with_drive_colon_is_fine() {
        // Single `:` (drive letter) must NOT confuse the last-`::` split.
        let (file, svc) = parse_docker_log_id("docker::C:\\ws\\docker-compose.yml::db").unwrap();
        assert_eq!(file, PathBuf::from("C:\\ws\\docker-compose.yml"));
        assert_eq!(svc, Some("db".to_string()));
    }

    #[test]
    fn non_docker_id_is_none() {
        assert!(parse_docker_log_id("api::root").is_none());
        assert!(parse_docker_log_id("__global__").is_none());
    }
}
