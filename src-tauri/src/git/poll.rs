//! The 30 s per-repo git badge poll loop — now a Rust tokio task instead of
//! per-card Tk timers (gui/repo_card/_git.py, inventory-gui.md §28).
//!
//! Each tick refreshes every registered repo's [`StatusSummary`] and emits
//! one [`crate::events::GIT_BADGE`] event per repo through the
//! [`EventEmitter`] abstraction — the frontend never polls. Concurrency is
//! capped at 3 simultaneous `git status` subprocesses, replicating v1's
//! `GIT_BADGE_SEMAPHORE_COUNT` (inventory-gui.md §28 — do not lower the
//! interval, do not raise the cap).
//!
//! TODO(integration): `AppState` is expected to own the badge poller (and the
//! fetch semaphore of 2); commands re-register repos after every workspace
//! scan via [`BadgePoller::set_repos`].

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, RwLock, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

use crate::events::{EventEmitter, GitBadgePayload, GIT_BADGE};

use super::exec::repo_name;
use super::ops::get_status_summary;

/// Badge refresh interval — v1 `BADGE_REFRESH_MS = 30_000`
/// (gui/constants.py, inventory-gui.md §28). Do NOT lower.
pub const BADGE_REFRESH: Duration = Duration::from_secs(30);

/// Max concurrent `git status` subprocesses — v1
/// `GIT_BADGE_SEMAPHORE_COUNT = 3` (inventory-gui.md §28).
pub const GIT_BADGE_SEMAPHORE_COUNT: usize = 3;

/// Handle of the running badge poll task. Dropping it does NOT stop the
/// task — call [`BadgePoller::stop`] (or [`BadgePoller::shutdown`]) so the
/// loop exits at the next scheduling point.
pub struct BadgePoller {
    repos: Arc<RwLock<Vec<PathBuf>>>,
    stop_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl BadgePoller {
    /// Replace the polled repo set (called after every workspace scan).
    /// Takes effect on the next tick.
    pub async fn set_repos(&self, repos: Vec<PathBuf>) {
        *self.repos.write().await = repos;
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

/// Spawn the badge poll loop. The first refresh happens immediately (so
/// cards get badges right after startup/scan), then every [`BADGE_REFRESH`].
///
/// `semaphore` is the ONE `git status` cap shared with the on-demand badge
/// queries (`AppState.badge_semaphore`) — a poller-private semaphore would
/// double the effective cap to 6 (inventory-gui.md §28: 3, do not raise).
pub fn spawn_badge_poller(emitter: Arc<dyn EventEmitter>, semaphore: Arc<Semaphore>) -> BadgePoller {
    let repos: Arc<RwLock<Vec<PathBuf>>> = Arc::default();
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let loop_repos = repos.clone();

    let task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(BADGE_REFRESH);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let snapshot = loop_repos.read().await.clone();
                    refresh_all(&emitter, &semaphore, snapshot).await;
                }
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });

    BadgePoller { repos, stop_tx, task }
}

/// One full refresh pass: query every repo (capped by the semaphore) and
/// emit a [`GIT_BADGE`] event per repo. Also usable on demand (e.g. right
/// after a pull/checkout) via [`refresh_badge`].
async fn refresh_all(
    emitter: &Arc<dyn EventEmitter>,
    semaphore: &Arc<Semaphore>,
    repos: Vec<PathBuf>,
) {
    let mut set = JoinSet::new();
    for repo in repos {
        let emitter = emitter.clone();
        let semaphore = semaphore.clone();
        set.spawn(async move {
            // Closed-semaphore can't happen (we own it); treat as skip.
            let Ok(_permit) = semaphore.acquire().await else { return };
            refresh_badge(emitter.as_ref(), &repo).await;
        });
    }
    while set.join_next().await.is_some() {}
}

/// Query one repo's badge and emit it (the v1 per-card `_refresh_git_badge`).
/// Public so commands can force a refresh right after a git operation.
pub async fn refresh_badge(emitter: &dyn EventEmitter, repo: &std::path::Path) {
    let summary = get_status_summary(repo).await;
    let payload = GitBadgePayload {
        name: repo_name(repo),
        branch: summary.branch,
        behind: summary.behind,
        staged: summary.staged,
        unstaged: summary.unstaged,
        conflicts: summary.conflicts,
    };
    match serde_json::to_value(&payload) {
        Ok(value) => emitter.emit(GIT_BADGE, value),
        Err(err) => log::error!("failed to serialize git badge payload: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::test_support::CollectingEmitter;

    /// Pin the §28 contract values so an accidental edit fails loudly.
    #[test]
    fn poll_contract_values() {
        assert_eq!(BADGE_REFRESH.as_secs(), 30, "badge poll is 30 s — do not lower");
        assert_eq!(GIT_BADGE_SEMAPHORE_COUNT, 3, "badge semaphore is 3");
    }

    #[tokio::test]
    async fn poller_stops_cleanly() {
        let emitter = CollectingEmitter::new();
        let semaphore = Arc::new(Semaphore::new(GIT_BADGE_SEMAPHORE_COUNT));
        let poller = spawn_badge_poller(emitter, semaphore);
        poller.set_repos(Vec::new()).await;
        poller.shutdown().await; // must terminate, not hang
    }

    #[tokio::test]
    async fn refresh_badge_emits_unknown_for_non_repo() {
        // A directory that is not a git repo → v1 default summary
        // (branch "unknown", zeros) still gets emitted so the card clears.
        let emitter = CollectingEmitter::new();
        let dir = std::env::temp_dir();
        refresh_badge(emitter.as_ref(), &dir).await;
        let events = emitter.payloads(GIT_BADGE);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["branch"], "unknown");
        assert_eq!(events[0]["behind"], 0);
    }
}
