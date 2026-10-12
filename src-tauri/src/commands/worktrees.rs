//! Git worktree commands (ipc-contract.md §2.4, git-worktrees design
//! docs/superpowers/specs/2026-10-12-git-worktrees-design.md).
//!
//! Worktrees surface as child `RepoInfo`s (`"<repo>@<folder>"`, `parent`) in
//! `scan_workspace`; after add / remove / prune the frontend re-runs the scan.
//! Deleting the worktree's branch reuses `git_delete_branch`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use super::error::{AppError, CmdResult};
use super::{op_log_sink, repo_log_name};
use crate::domain::RepoInfo;
use crate::events::LogStream;
use crate::git::worktrees::{self, AddMode};
use crate::git::OpOutput;
use crate::state::AppState;

/// `git_worktree_add` result: `OpOutput` + the new worktree's repo name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAddResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

fn find_repo(state: &AppState, name: &str) -> Result<RepoInfo, AppError> {
    state
        .repos_snapshot()
        .into_iter()
        .find(|r| r.name == name)
        .ok_or_else(|| AppError::invalid_args(format!("unknown repo '{name}'")))
}

fn sink(app: &tauri::AppHandle, repo: &Path) -> crate::git::LogSink {
    op_log_sink(app.clone(), repo_log_name(app, repo), LogStream::Git)
}

/// Reject a port already assigned to ANOTHER worktree.
fn check_port_free(state: &AppState, name: &str, port: u16) -> Result<(), AppError> {
    if port == 0 {
        return Err(AppError::invalid_args("port must be 1-65535"));
    }
    let config = state.config.load()?;
    match config.worktree_ports.iter().find(|(n, p)| **p == port && n.as_str() != name) {
        Some((other, _)) => Err(AppError::invalid_args(format!("port {port} is already used by {other}"))),
        None => Ok(()),
    }
}

/// `git_worktree_suggest_port { repoName }` → first free port above the
/// parent's (static `server.port`, else its live port); `null` when unknown.
#[tauri::command]
pub async fn git_worktree_suggest_port(
    state: State<'_, AppState>,
    repo_name: String,
) -> CmdResult<Option<u16>> {
    let repo = find_repo(&state, &repo_name)?;
    let Some(base) = repo.server_port.or(state.process.port_of(&repo.name).await) else {
        return Ok(None);
    };
    let taken: Vec<u16> = state.config.load()?.worktree_ports.into_values().collect();
    Ok(worktrees::suggest_port(base, &taken, crate::process::manager::port_bindable))
}

/// `git_worktree_add { repoName, branch, mode, base?, port? }` →
/// `{ ok, message, name? }`. Creates `<root>/<repo>.worktrees/<folder>` and
/// stores the port for the new worktree.
#[tauri::command]
pub async fn git_worktree_add(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_name: String,
    branch: String,
    mode: AddMode,
    base: Option<String>,
    port: Option<u16>,
) -> CmdResult<WorktreeAddResult> {
    let repo = find_repo(&state, &repo_name)?;
    let parent = PathBuf::from(&repo.path);
    let name = format!("{}@{}", repo.name, worktrees::folder_for_branch(branch.trim()));
    if let Some(port) = port {
        check_port_free(&state, &name, port)?;
    }
    let log = sink(&app, &parent);
    match worktrees::add(&parent, &branch, mode, base.as_deref(), Some(&log)).await {
        Ok(_) => {
            if let Some(port) = port {
                state.config.update(|c| {
                    c.worktree_ports.insert(name.clone(), port);
                })?;
            }
            Ok(WorktreeAddResult { ok: true, message: String::new(), name: Some(name) })
        }
        Err(out) => Ok(WorktreeAddResult { ok: false, message: out.message, name: None }),
    }
}

/// `git_worktree_remove { name, force }` → `OpOutput`. Stops every run of the
/// worktree (`name`, `name::*`) with the normal escalation FIRST, then
/// `git worktree remove [--force]` in the parent, then drops the worktree's
/// own config (port, repo state, command profiles, active envs).
#[tauri::command]
pub async fn git_worktree_remove(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    name: String,
    force: bool,
) -> CmdResult<OpOutput> {
    let wt = find_repo(&state, &name)?;
    let parent_name = wt
        .parent
        .clone()
        .ok_or_else(|| AppError::invalid_args(format!("'{name}' is not a worktree")))?;
    let parent = find_repo(&state, &parent_name)?;

    let module_prefix = format!("{name}::");
    for snap in state.process.snapshots().await {
        if snap.id == name || snap.id.starts_with(&module_prefix) {
            if let Err(err) = state.process.stop(&snap.id).await {
                log::warn!("worktree remove: stopping {}: {err}", snap.id);
            }
        }
    }

    let parent_path = PathBuf::from(&parent.path);
    let log = sink(&app, &parent_path);
    let out = worktrees::remove(&parent_path, Path::new(&wt.path), force, Some(&log)).await;
    if out.ok {
        state.config.update(|c| {
            c.worktree_ports.remove(&name);
            c.repo_state.remove(&name);
            c.command_profiles.remove(&name);
            c.active_configs.retain(|k, _| !k.starts_with(&module_prefix));
        })?;
    }
    Ok(out)
}

/// `git_worktree_prune { repoName }` → `OpOutput`.
#[tauri::command]
pub async fn git_worktree_prune(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_name: String,
) -> CmdResult<OpOutput> {
    let repo = PathBuf::from(find_repo(&state, &repo_name)?.path);
    let log = sink(&app, &repo);
    Ok(worktrees::prune(&repo, Some(&log)).await)
}

/// `set_worktree_port { name, port }` — `null` clears it. Rejects a port
/// already assigned to another worktree. Applies on the next start.
#[tauri::command]
pub async fn set_worktree_port(
    state: State<'_, AppState>,
    name: String,
    port: Option<u16>,
) -> CmdResult<()> {
    if let Some(port) = port {
        check_port_free(&state, &name, port)?;
    }
    state.config.update(|c| match port {
        Some(port) => {
            c.worktree_ports.insert(name, port);
        }
        None => {
            c.worktree_ports.remove(&name);
        }
    })?;
    Ok(())
}
