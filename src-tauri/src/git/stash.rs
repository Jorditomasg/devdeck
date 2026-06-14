//! Git stash operations — the stash-management dialog surface (no v1
//! equivalent). Every mutation shells out through [`super::exec`] and folds
//! failures into [`OpOutput`], consistent with the rest of the git surface.

use std::path::Path;

use super::exec::{repo_name, run_git, run_logged_op, T_BRANCH_OP, T_QUERY};
use super::parse;
use super::types::{emit, LogSink, OpOutput, StashEntry};

/// `git stash list` parsed into entries (newest = index 0). Never fails: any
/// error yields an empty list (query-style, like `get_branches`).
pub async fn stash_list(repo: &Path) -> Vec<StashEntry> {
    match run_git(repo, &["stash", "list", "--format=%gd%x1f%gs"], T_QUERY).await {
        Ok(out) if out.success => parse::parse_stash_list(&out.stdout),
        _ => Vec::new(),
    }
}

/// `git stash push [-u] [-m <message>]`. A blank/`None` message omits `-m`;
/// `include_untracked` adds `-u`. With nothing to stash git exits 0 with
/// "No local changes to save", surfaced as `ok: true` + that message.
pub async fn stash_push(
    repo: &Path,
    message: Option<&str>,
    include_untracked: bool,
    log: Option<&LogSink>,
) -> OpOutput {
    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    let trimmed = message.map(str::trim).filter(|m| !m.is_empty());
    if let Some(msg) = trimmed {
        args.push("-m");
        args.push(msg);
    }
    emit(log, &format!("[git] {}: git {}", repo_name(repo), args.join(" ")));
    run_logged_op(repo, &args, T_BRANCH_OP, log).await
}

/// `git stash apply stash@{index}` — applies, KEEPS the entry.
pub async fn stash_apply(repo: &Path, index: usize, log: Option<&LogSink>) -> OpOutput {
    stash_ref_op(repo, "apply", index, log).await
}

/// `git stash pop stash@{index}` — applies AND drops the entry.
pub async fn stash_pop(repo: &Path, index: usize, log: Option<&LogSink>) -> OpOutput {
    stash_ref_op(repo, "pop", index, log).await
}

/// `git stash drop stash@{index}` — discards the entry without applying.
pub async fn stash_drop(repo: &Path, index: usize, log: Option<&LogSink>) -> OpOutput {
    stash_ref_op(repo, "drop", index, log).await
}

async fn stash_ref_op(repo: &Path, sub: &str, index: usize, log: Option<&LogSink>) -> OpOutput {
    let stash_ref = format!("stash@{{{index}}}");
    emit(log, &format!("[git] {}: git stash {sub} {stash_ref}", repo_name(repo)));
    run_logged_op(repo, &["stash", sub, &stash_ref], T_BRANCH_OP, log).await
}
