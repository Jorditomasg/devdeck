//! Detection command (ipc-contract.md §2.2).

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Semaphore;

use tauri::State;

use super::error::CmdResult;
use crate::config::AppConfig;
use crate::detection;
use crate::docker::StatusTarget;
use crate::domain::{RepoInfo, RepoTypeDef};
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
    append_worktrees(&mut repos, &defs, &state.badge_semaphore).await;

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

    state.tray.set_total(repos.iter().filter(|r| r.parent.is_none()).count());
    if let Ok(mut guard) = state.repos.write() {
        *guard = repos.clone();
    }

    let n = repos.len() as u32;
    emit_progress(&app, "done", n, n);
    Ok(repos)
}

/// Append every linked git worktree of each scanned repo as a child
/// `RepoInfo` (`name = "<repo>@<folder>"`, `parent = <repo>`), detected with
/// the normal pipeline on its own path (git-worktrees design). One
/// `git worktree list` per main repo, under the shared badge semaphore. A
/// worktree whose folder is gone or that matches no repo type is skipped.
pub(crate) async fn append_worktrees(
    repos: &mut Vec<RepoInfo>,
    defs: &[RepoTypeDef],
    semaphore: &Arc<Semaphore>,
) {
    let defs = Arc::new(defs.to_vec());
    let handles: Vec<_> = repos
        .iter()
        .map(|parent| {
            let (name, path) = (parent.name.clone(), PathBuf::from(&parent.path));
            let (defs, semaphore) = (Arc::clone(&defs), Arc::clone(semaphore));
            tokio::spawn(async move { worktrees_of(&name, &path, &defs, &semaphore).await })
        })
        .collect();
    for handle in handles {
        repos.extend(handle.await.unwrap_or_default());
    }
    drop_worktrees_listed_as_repos(repos);
}

/// A worktree created outside `<repo>.worktrees/` is also scanned as a
/// top-level folder; keep only the child so it shows under its parent.
fn drop_worktrees_listed_as_repos(repos: &mut Vec<RepoInfo>) {
    let children: std::collections::HashSet<String> = repos
        .iter()
        .filter(|r| r.parent.is_some())
        .map(|r| path_key(&r.path))
        .collect();
    repos.retain(|r| r.parent.is_some() || !children.contains(&path_key(&r.path)));
}

/// git prints `C:/x`, the workspace listing `C:\x`.
fn path_key(path: &str) -> String {
    let key = path
        .replace('\\', "/")
        .trim_end_matches('/')
        .replace("//wsl$/", "//wsl.localhost/");
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

async fn worktrees_of(
    parent: &str,
    repo: &std::path::Path,
    defs: &Arc<Vec<RepoTypeDef>>,
    semaphore: &Semaphore,
) -> Vec<RepoInfo> {
    // Only main repos own worktrees (`.git` dir; a linked worktree has a file).
    if !tokio::fs::metadata(repo.join(".git")).await.is_ok_and(|m| m.is_dir()) {
        return Vec::new();
    }
    let entries = {
        let Ok(_permit) = semaphore.acquire().await else { return Vec::new() };
        crate::git::worktrees::list(repo).await.unwrap_or_default()
    };
    let mut children = Vec::new();
    for entry in entries.into_iter().skip(1).filter(|e| !e.bare) {
        let host = crate::git::worktrees::host_path(repo, &entry.path);
        let Some(folder) = host.file_name().map(|f| f.to_string_lossy().into_owned()) else {
            continue;
        };
        let name = format!("{parent}@{folder}");
        let defs = Arc::clone(defs);
        let classified = tokio::task::spawn_blocking(move || {
            host.is_dir().then(|| detection::classify_repo(&name, &host, &defs)).flatten()
        })
        .await
        .ok()
        .flatten();
        if let Some(mut info) = classified {
            info.parent = Some(parent.to_string());
            info.worktree_branch = entry.branch;
            children.push(info);
        }
    }
    children
}

/// `list_repos` → the last `scan_workspace` result cached in `AppState`
/// (empty before the first scan). Lets dialog windows — separate webviews that
/// never run a scan — hydrate their `ReposStore` so `repoByName` works
/// (docs/migration/dialogs-as-windows.md Phase 3).
#[tauri::command]
pub async fn list_repos(state: State<'_, AppState>) -> CmdResult<Vec<RepoInfo>> {
    Ok(state.repos_snapshot())
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
    fn worktree_also_scanned_as_top_level_repo_is_kept_only_as_child() {
        let repo = |name: &str, path: &str, parent: Option<&str>| RepoInfo {
            name: name.into(),
            path: path.into(),
            parent: parent.map(Into::into),
            ..Default::default()
        };
        let mut repos = vec![
            repo("app", "/ws/app", None),
            repo("app-feat", "/ws/app-feat", None),
            repo("other", "/ws/other", None),
            repo("app@app-feat", "/ws/app-feat/", Some("app")),
        ];
        drop_worktrees_listed_as_repos(&mut repos);
        let names: Vec<_> = repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["app", "other", "app@app-feat"]);
        assert_eq!(path_key(r"\\wsl$\Ubuntu\ws\x"), path_key("//wsl.localhost/Ubuntu/ws/x"));
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
