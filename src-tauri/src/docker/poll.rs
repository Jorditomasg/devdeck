//! The 15 s per-repo docker compose status poll — a Rust tokio task instead
//! of per-card Tk timers (gui/repo_card/_docker.py, inventory-gui.md §28).
//!
//! Each tick queries [`super::ops::get_compose_service_status`] for every
//! registered target and emits one [`crate::events::DOCKER_STATUS`] event per
//! repo through the [`EventEmitter`] abstraction. Do NOT lower the interval
//! (§28 contract).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, RwLock};
use tokio::task::{JoinHandle, JoinSet};

use crate::events::{DockerStatusPayload, EventEmitter, DOCKER_STATUS};

use super::ops::get_compose_service_status;

/// Compose status poll interval — v1 `DOCKER_POLL_MS = 15_000`
/// (gui/constants.py, inventory-gui.md §28). Do NOT lower.
pub const DOCKER_POLL: Duration = Duration::from_secs(15);

/// One polled repo: card name + the compose file driving its checkboxes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusTarget {
    /// Repo/card name — the `name` field of the emitted payload.
    pub name: String,
    pub compose_file: PathBuf,
}

/// Handle of the running status poll task. Call [`StatusPoller::stop`] /
/// [`StatusPoller::shutdown`] to end the loop.
pub struct StatusPoller {
    targets: Arc<RwLock<Vec<StatusTarget>>>,
    stop_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl StatusPoller {
    /// Replace the polled target set (after every workspace scan / when a
    /// docker card changes its active compose file). Next tick picks it up.
    pub async fn set_targets(&self, targets: Vec<StatusTarget>) {
        *self.targets.write().await = targets;
    }

    /// Signal the loop to exit; returns immediately.
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }

    /// Stop and wait for the task to finish.
    pub async fn shutdown(self) {
        self.stop();
        let _ = self.task.await;
    }
}

/// Spawn the compose status poll loop. First refresh happens immediately,
/// then every [`DOCKER_POLL`].
pub fn spawn_status_poller(emitter: Arc<dyn EventEmitter>) -> StatusPoller {
    let targets: Arc<RwLock<Vec<StatusTarget>>> = Arc::default();
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let loop_targets = targets.clone();

    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(DOCKER_POLL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let snapshot = loop_targets.read().await.clone();
                    refresh_all(&emitter, snapshot).await;
                }
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });

    StatusPoller { targets, stop_tx, task }
}

async fn refresh_all(emitter: &Arc<dyn EventEmitter>, targets: Vec<StatusTarget>) {
    let mut set = JoinSet::new();
    for target in targets {
        let emitter = emitter.clone();
        set.spawn(async move {
            refresh_status(emitter.as_ref(), &target).await;
        });
    }
    while set.join_next().await.is_some() {}
}

/// Query one target's compose status and emit it (the v1 per-card
/// `_poll_docker_status`). Public so commands can force a refresh right
/// after an up/down/stop.
pub async fn refresh_status(emitter: &dyn EventEmitter, target: &StatusTarget) {
    let status = get_compose_service_status(&target.compose_file).await;
    let payload = DockerStatusPayload {
        name: target.name.clone(),
        services: status.into_iter().collect::<HashMap<_, _>>(),
    };
    match serde_json::to_value(&payload) {
        Ok(value) => emitter.emit(DOCKER_STATUS, value),
        Err(err) => log::error!("failed to serialize docker status payload: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::test_support::CollectingEmitter;

    /// Pin the §28 contract value so an accidental edit fails loudly.
    #[test]
    fn poll_contract_value() {
        assert_eq!(DOCKER_POLL.as_secs(), 15, "docker poll is 15 s — do not lower");
    }

    #[tokio::test]
    async fn poller_stops_cleanly() {
        let emitter = CollectingEmitter::new();
        let poller = spawn_status_poller(emitter);
        poller.set_targets(Vec::new()).await;
        poller.shutdown().await; // must terminate, not hang
    }

    #[tokio::test]
    async fn refresh_status_emits_for_missing_compose_file() {
        // Missing/unparsable compose file → empty service map, still emitted
        // so the card can clear its checkboxes.
        let emitter = CollectingEmitter::new();
        let target = StatusTarget {
            name: "infra".to_string(),
            compose_file: PathBuf::from("/definitely/missing/docker-compose.yml"),
        };
        refresh_status(emitter.as_ref(), &target).await;
        let events = emitter.payloads(DOCKER_STATUS);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["name"], "infra");
        assert!(events[0]["services"].as_object().unwrap().is_empty());
    }
}
