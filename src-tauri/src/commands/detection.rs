//! Detection command (ipc-contract.md §2.2).

use std::path::PathBuf;

use tauri::State;

use super::error::CmdResult;
use crate::config::AppConfig;
use crate::detection;
use crate::docker::StatusTarget;
use crate::domain::RepoInfo;
use crate::events::{EventEmitter, ScanProgressPayload, REPO_SCAN_PROGRESS};
use crate::state::AppState;

/// #2 `scan_workspace { paths }` → `RepoInfo[]`.
///
/// Contract side effects (ipc-contract.md §2.2 notes):
/// - emits `repo://scan-progress` progressively: `"scanning"` at start, one
///   `"classifying"` event per candidate as repos classify (`detected` =
///   repos found so far, `total` = candidate dirs), terminal phase `"done"`;
/// - re-targets the git badge poller and the docker status poller to the
///   scanned repos — the frontend never polls;
/// - caches the result in `AppState` (spec building, profile capture);
/// - fills `danger_flags` from `repo_config_danger` before returning.
///
/// Detection itself (concurrency cap 8, alphabetical order, dedup by path)
/// lives in `detection::detect_repos_for_group`.
#[tauri::command]
pub async fn scan_workspace(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> CmdResult<Vec<RepoInfo>> {
    emit_progress(&app, "scanning", 0, 0);

    let defs = state.repo_defs_snapshot();
    // Progressive per-repo progress (ipc-contract.md §3 repo://scan-progress)
    // — fired by the pipeline after each candidate finishes classifying.
    let progress_app = app.clone();
    let on_progress = move |detected: u32, total: u32| {
        emit_progress(&progress_app, "classifying", detected, total);
    };
    let mut repos =
        detection::detect_repos_for_group(&paths, &defs, Some(&on_progress)).await;

    // Danger flags come from config, not detection (domain/repo_info.rs doc).
    // A broken config must not block scanning — warn and continue empty.
    let config = state.config.load().unwrap_or_else(|err| {
        log::warn!("scan_workspace: config unavailable for danger flags: {err}");
        AppConfig::default()
    });
    fill_danger_flags(&mut repos, &config);

    // Re-target the poll loops (inventory-gui.md §28 cadences).
    let badge_targets: Vec<PathBuf> = repos.iter().map(|r| PathBuf::from(&r.path)).collect();
    state.badge_poller.set_repos(badge_targets).await;
    state
        .docker_poller
        .set_targets(docker_targets(&repos))
        .await;

    state.tray.set_total(repos.len());
    if let Ok(mut guard) = state.repos.write() {
        *guard = repos.clone();
    }

    let n = repos.len() as u32;
    emit_progress(&app, "done", n, n);
    Ok(repos)
}

fn emit_progress(app: &tauri::AppHandle, phase: &str, detected: u32, total: u32) {
    match serde_json::to_value(ScanProgressPayload {
        phase: phase.to_owned(),
        detected,
        total,
    }) {
        Ok(value) => app.emit(REPO_SCAN_PROGRESS, value),
        Err(err) => log::error!("failed to serialize scan progress: {err}"),
    }
}

/// Fill each repo's `danger_flags` with the union of the dangerous env
/// names stored under its module config keys (`"repo::module"`,
/// inventory-backend.md §8.3), sorted and deduplicated.
pub(crate) fn fill_danger_flags(repos: &mut [RepoInfo], config: &AppConfig) {
    for repo in repos.iter_mut() {
        let mut flags: Vec<String> = repo
            .modules
            .iter()
            .flat_map(|m| config.danger_configs(&format!("{}::{}", repo.name, m.key)))
            .collect();
        flags.sort();
        flags.dedup();
        repo.danger_flags = flags;
    }
}

/// One poll target per docker-capable repo: its first (sorted) compose file
/// — the same file the card's checkboxes default to. Other compose files
/// can be polled on demand via `docker_refresh_status` (§2.8 #54).
pub(crate) fn docker_targets(repos: &[RepoInfo]) -> Vec<StatusTarget> {
    repos
        .iter()
        .filter_map(|r| {
            r.docker_compose_files.first().map(|f| StatusTarget {
                name: r.name.clone(),
                compose_file: PathBuf::from(f),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::RepoModule;

    fn repo_with_modules(name: &str, module_keys: &[&str]) -> RepoInfo {
        RepoInfo {
            name: name.into(),
            modules: module_keys
                .iter()
                .map(|k| RepoModule {
                    key: (*k).into(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn danger_flags_union_over_modules_sorted_deduped() {
        let mut config = AppConfig::default();
        config.set_danger_configs("api::root", vec!["prod".into(), "staging".into()]);
        config.set_danger_configs(
            "api::src/main/resources",
            vec!["prod".into(), "uat".into()],
        );

        let mut repos = vec![repo_with_modules("api", &["root", "src/main/resources"])];
        fill_danger_flags(&mut repos, &config);
        assert_eq!(repos[0].danger_flags, vec!["prod", "staging", "uat"]);
    }

    #[test]
    fn danger_flags_empty_when_no_config_entries() {
        let mut repos = vec![repo_with_modules("web", &["root"])];
        fill_danger_flags(&mut repos, &AppConfig::default());
        assert!(repos[0].danger_flags.is_empty());
    }

    #[test]
    fn docker_targets_pick_first_compose_file_only() {
        let mut infra = RepoInfo {
            name: "infra".into(),
            ..Default::default()
        };
        infra.docker_compose_files = vec![
            "/ws/infra/docker-compose.dev.yml".into(),
            "/ws/infra/docker-compose.yml".into(),
        ];
        let plain = RepoInfo {
            name: "api".into(),
            ..Default::default()
        };

        let targets = docker_targets(&[infra, plain]);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].name, "infra");
        assert_eq!(
            targets[0].compose_file,
            PathBuf::from("/ws/infra/docker-compose.dev.yml")
        );
    }
}
