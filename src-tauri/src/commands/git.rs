//! Git commands (ipc-contract.md §2.4).
//!
//! All repo-addressed commands take the ABSOLUTE repo path
//! (`RepoInfo.path`). Operation logs flow through `service://log-line` with
//! `stream: "git"` and `name` = repo name (the path's basename).
//!
//! Mutating operations resolve with `OpOutput { ok, message }` instead of
//! rejecting on domain failures — only infrastructure failures reject
//! (`kind: "git"`) per the v1 "fold failures into the result" semantics
//! (ipc-contract.md §1.3).

use std::path::PathBuf;

use tauri::State;

use super::error::{AppError, CmdResult};
use super::{op_log_sink, path_basename};
use crate::events::LogStream;
use crate::git::{
    self, MergeOutcome, MergeRequest, OpOutput, OrderedBranches, RevertOutcome, RevertPoint,
    StashEntry, StatusSummary, DEFAULT_BRANCH_RECENCY_LIMIT,
};
use crate::state::AppState;

/// Acquire a permit from one of the git semaphores. The semaphores are never
/// closed, so failure here is a programming error surfaced as `kind: "git"`
/// instead of a panic (no `unwrap()` outside tests).
async fn acquire(
    semaphore: &std::sync::Arc<tokio::sync::Semaphore>,
) -> Result<tokio::sync::OwnedSemaphorePermit, AppError> {
    semaphore.clone().acquire_owned().await.map_err(|_| AppError {
        kind: "git".into(),
        message: "git semaphore closed".into(),
    })
}

/// #9 `git_status_summary { repoPath }` → `GitBadge`.
///
/// On-demand badge query; shares the badge concurrency cap (3) with the
/// 30 s poll loop (ipc-contract.md §2.4; inventory-gui.md §28).
#[tauri::command]
pub async fn git_status_summary(
    state: State<'_, AppState>,
    repo_path: String,
) -> CmdResult<StatusSummary> {
    let _permit = acquire(&state.badge_semaphore).await?;
    Ok(git::get_status_summary(&PathBuf::from(repo_path)).await)
}

/// #10 `git_branches { repoPath, limit?, includeRemote? }` → `OrderedBranches`
/// (default limit 7 = `DEFAULT_BRANCH_RECENCY_LIMIT`; `includeRemote` defaults
/// to `true` — v1 parity. The branch-management dialog passes `false` to keep
/// its local-only operations off remote-only names).
#[tauri::command]
pub async fn git_branches(
    repo_path: String,
    limit: Option<usize>,
    include_remote: Option<bool>,
) -> CmdResult<OrderedBranches> {
    let limit = limit.unwrap_or(DEFAULT_BRANCH_RECENCY_LIMIT);
    let include_remote = include_remote.unwrap_or(true);
    Ok(git::get_ordered_branches(&PathBuf::from(repo_path), limit, include_remote).await)
}

/// #11 `git_current_branch { repoPath }` → `string`
/// (the literal `"unknown"` on any failure — v1 parity).
#[tauri::command]
pub async fn git_current_branch(repo_path: String) -> CmdResult<String> {
    Ok(git::get_current_branch(&PathBuf::from(repo_path)).await)
}

/// #12 `git_checkout { repoPath, branch }` → `OpOutput`
/// (with `origin/<branch>` tracking fallback).
#[tauri::command]
pub async fn git_checkout(
    app: tauri::AppHandle,
    repo_path: String,
    branch: String,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::checkout(&repo, &branch, Some(&sink)).await)
}

/// #13 `git_pull { repoPath }` → `OpOutput` (`--ff-only`).
#[tauri::command]
pub async fn git_pull(app: tauri::AppHandle, repo_path: String) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::pull(&repo, Some(&sink)).await)
}

/// #14 `git_fetch { repoPath }` → `OpOutput`
/// (fetch semaphore: 2, inventory-gui.md §28).
#[tauri::command]
pub async fn git_fetch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
) -> CmdResult<OpOutput> {
    let _permit = acquire(&state.fetch_semaphore).await?;
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::fetch(&repo, Some(&sink)).await)
}

/// #15 `git_clone { url, destPath }` → `OpOutput`.
///
/// stderr progress is forwarded as `[git] …` log lines
/// (`stream: "git"`, `name` = dest basename) — `git::ops::clone` already
/// logs each stderr line through the sink, so no separate progress sink is
/// wired here.
#[tauri::command]
pub async fn git_clone(
    app: tauri::AppHandle,
    url: String,
    dest_path: String,
) -> CmdResult<OpOutput> {
    let dest = PathBuf::from(dest_path);
    let sink = op_log_sink(app, path_basename(&dest), LogStream::Git);
    Ok(git::clone(&url, &dest, Some(&sink), None).await)
}

/// #16 `git_clean { repoPath }` → `OpOutput`
/// (add -A, reset --hard, clean -fd).
#[tauri::command]
pub async fn git_clean(app: tauri::AppHandle, repo_path: String) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::clean_repo(&repo, Some(&sink)).await)
}

/// #17 `git_local_changes { repoPath, ignorePatterns }` → `string[]`
/// (merge-dialog dirty preview).
#[tauri::command]
pub async fn git_local_changes(
    repo_path: String,
    ignore_patterns: Vec<String>,
) -> CmdResult<Vec<String>> {
    Ok(git::get_local_changes(&PathBuf::from(repo_path), &ignore_patterns).await)
}

/// #18 `git_has_branch { repoPath, branch }` → `boolean`.
#[tauri::command]
pub async fn git_has_branch(repo_path: String, branch: String) -> CmdResult<bool> {
    Ok(git::has_branch(&PathBuf::from(repo_path), &branch).await)
}

/// #19 `git_capture_revert_point { repoPath, request }` → `RevertPoint`.
/// MUST be invoked before `git_merge` (inventory-backend.md §10.5).
#[tauri::command]
pub async fn git_capture_revert_point(
    repo_path: String,
    request: MergeRequest,
) -> CmdResult<RevertPoint> {
    Ok(git::capture_revert_point(&PathBuf::from(repo_path), &request).await)
}

/// #20 `git_merge { repoPath, request }` → `MergeOutcome` — the full §10.4
/// pipeline; conflicts leave the working tree conflicted (never auto-aborted).
#[tauri::command]
pub async fn git_merge(
    app: tauri::AppHandle,
    repo_path: String,
    request: MergeRequest,
) -> CmdResult<MergeOutcome> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::merge_branch(&repo, &request, Some(&sink)).await)
}

/// #21 `git_revert_merge { repoPath, revertPoint }` → `RevertOutcome`.
#[tauri::command]
pub async fn git_revert_merge(
    app: tauri::AppHandle,
    repo_path: String,
    revert_point: RevertPoint,
) -> CmdResult<RevertOutcome> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::revert_merge(&repo, &revert_point, Some(&sink)).await)
}

/// #22 `git_refresh_badge { repoPath }` → `void` — forces one poll cycle;
/// the result arrives as a `git://badge` event. Shares the badge cap (3).
#[tauri::command]
pub async fn git_refresh_badge(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
) -> CmdResult<()> {
    let _permit = acquire(&state.badge_semaphore).await?;
    git::refresh_badge(&app, &PathBuf::from(repo_path)).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Stash management (ipc-contract.md §2.4 #62–#66) — append-only numbering.
// ---------------------------------------------------------------------------

/// #62 `git_stash_list { repoPath }` → `StashEntry[]`.
#[tauri::command]
pub async fn git_stash_list(repo_path: String) -> CmdResult<Vec<StashEntry>> {
    Ok(git::stash_list(&PathBuf::from(repo_path)).await)
}

/// #63 `git_stash_push { repoPath, message?, includeUntracked }` → `OpOutput`.
#[tauri::command]
pub async fn git_stash_push(
    app: tauri::AppHandle,
    repo_path: String,
    message: Option<String>,
    include_untracked: bool,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::stash_push(&repo, message.as_deref(), include_untracked, Some(&sink)).await)
}

/// #64 `git_stash_apply { repoPath, index }` → `OpOutput` (keeps the entry).
#[tauri::command]
pub async fn git_stash_apply(
    app: tauri::AppHandle,
    repo_path: String,
    index: usize,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::stash_apply(&repo, index, Some(&sink)).await)
}

/// #65 `git_stash_pop { repoPath, index }` → `OpOutput` (applies + drops).
#[tauri::command]
pub async fn git_stash_pop(
    app: tauri::AppHandle,
    repo_path: String,
    index: usize,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::stash_pop(&repo, index, Some(&sink)).await)
}

/// #66 `git_stash_drop { repoPath, index }` → `OpOutput`.
#[tauri::command]
pub async fn git_stash_drop(
    app: tauri::AppHandle,
    repo_path: String,
    index: usize,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::stash_drop(&repo, index, Some(&sink)).await)
}

// ---------------------------------------------------------------------------
// Branch management (ipc-contract.md §2.4 #67–#71).
// ---------------------------------------------------------------------------

/// #67 `git_create_branch { repoPath, name, base?, checkout }` → `OpOutput`.
#[tauri::command]
pub async fn git_create_branch(
    app: tauri::AppHandle,
    repo_path: String,
    name: String,
    base: Option<String>,
    checkout: bool,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::create_branch(&repo, &name, base.as_deref(), checkout, Some(&sink)).await)
}

/// #68 `git_delete_branch { repoPath, name, force }` → `OpOutput`.
#[tauri::command]
pub async fn git_delete_branch(
    app: tauri::AppHandle,
    repo_path: String,
    name: String,
    force: bool,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::delete_branch(&repo, &name, force, Some(&sink)).await)
}

/// #69 `git_delete_remote_branch { repoPath, name }` → `OpOutput`.
#[tauri::command]
pub async fn git_delete_remote_branch(
    app: tauri::AppHandle,
    repo_path: String,
    name: String,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::delete_remote_branch(&repo, &name, Some(&sink)).await)
}

/// #70 `git_rename_branch { repoPath, from?, to }` → `OpOutput`.
#[tauri::command]
pub async fn git_rename_branch(
    app: tauri::AppHandle,
    repo_path: String,
    from: Option<String>,
    to: String,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::rename_branch(&repo, from.as_deref(), &to, Some(&sink)).await)
}

/// #71 `git_publish_branch { repoPath, name }` → `OpOutput` (push -u origin).
#[tauri::command]
pub async fn git_publish_branch(
    app: tauri::AppHandle,
    repo_path: String,
    name: String,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(repo_path);
    let sink = op_log_sink(app, path_basename(&repo), LogStream::Git);
    Ok(git::publish_branch(&repo, &name, Some(&sink)).await)
}
