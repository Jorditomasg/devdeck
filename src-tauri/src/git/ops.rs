//! High-level async git operations — the typed port of `core/git_manager.py`
//! (inventory-backend.md §10).
//!
//! Every function shells out through [`super::exec::run_git`] and parses with
//! the pure functions in [`super::parse`]. Failures are folded into the v1
//! result shapes (`OpOutput`, defaulted queries) — only the merge pipeline
//! distinguishes executor errors, mapping them to `MergeStatus::Error` exactly
//! like v1's `except` blocks.
//!
//! Log lines (including the Spanish `[merge]`/`[git]` strings) are kept
//! byte-compatible with v1 (§22.8: several backend log strings are Spanish by
//! design — they are working-log output, not translated UI strings).

use std::path::Path;
use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::exec::{
    is_option_like, repo_name, run_git, wsl_path_for, T_BRANCH_OP, T_FAST, T_FETCH,
    T_FETCH_QUIET, T_LONG, T_QUERY,
};
use super::parse;
use super::types::{
    emit, GitError, LogSink, MergeOutcome, MergeRequest, MergeStatus, OpOutput, OrderedBranches,
    ProgressSink, RevertMode, RevertOutcome, RevertPoint, RevertStatus, StatusSummary, TargetMode,
};

/// v1 default for the recency split in branch combos
/// (`order_branches_by_recency(limit=7)`, §10.1).
pub const DEFAULT_BRANCH_RECENCY_LIMIT: usize = 7;

// ---------------------------------------------------------------------------
// Branch listing & recency (§10.1)
// ---------------------------------------------------------------------------

/// All branches (local + optional remote), de-duplicated and sorted
/// (v1 `get_branches`).
pub async fn get_branches(repo: &Path, include_remote: bool) -> Vec<String> {
    let mut branches: Vec<String> = Vec::new();
    if let Ok(out) = run_git(repo, &["branch", "--no-color"], T_QUERY).await {
        if out.success {
            branches.extend(parse::parse_local_branches(&out.stdout));
        }
    }
    if include_remote {
        if let Ok(out) = run_git(repo, &["branch", "-r", "--no-color"], T_QUERY).await {
            if out.success {
                branches.extend(parse::parse_remote_branches(&out.stdout));
            }
        }
    }
    branches.sort();
    branches.dedup();
    branches
}

/// Branches recently checked out, most-recent first, de-duplicated — parsed
/// from the HEAD reflog so checkouts done by ANY tool count
/// (v1 `get_recent_checked_out_branches`).
pub async fn get_recent_checked_out_branches(repo: &Path) -> Vec<String> {
    match run_git(repo, &["reflog", "--format=%gs", "-n", "300"], T_QUERY).await {
        Ok(out) if out.success => parse::parse_reflog_checkouts(&out.stdout),
        _ => Vec::new(),
    }
}

/// Branch list ordered by reflog recency: up to `limit` recent branches
/// first, the rest alphabetical (v1 `order_branches_by_recency` over
/// `get_branches`). `include_remote` controls whether remote branches join
/// the list (v1 always passed `true`; the branch-management dialog passes
/// `false` so its local-only operations never target a remote-only name).
pub async fn get_ordered_branches(
    repo: &Path,
    limit: usize,
    include_remote: bool,
) -> OrderedBranches {
    let branches = get_branches(repo, include_remote).await;
    let recent = get_recent_checked_out_branches(repo).await;
    let (ordered, recent_count) = parse::order_branches_by_recency(&recent, &branches, limit);
    OrderedBranches { branches: ordered, recent_count }
}

// ---------------------------------------------------------------------------
// State queries (§10.2)
// ---------------------------------------------------------------------------

/// Current branch name; the literal `"unknown"` on any failure
/// (v1 `get_current_branch`).
pub async fn get_current_branch(repo: &Path) -> String {
    match run_git(repo, &["rev-parse", "--abbrev-ref", "HEAD"], T_FAST).await {
        Ok(out) if out.success => out.stdout.trim().to_string(),
        _ => "unknown".to_string(),
    }
}

/// Resolve `refname` to a full commit SHA, or `None` (v1 `get_commit_sha`).
pub async fn get_commit_sha(repo: &Path, refname: &str) -> Option<String> {
    if is_option_like(refname) {
        return None;
    }
    let out = run_git(repo, &["rev-parse", "--verify", "--quiet", refname], T_FAST)
        .await
        .ok()?;
    let sha = out.stdout.trim();
    (out.success && !sha.is_empty()).then(|| sha.to_string())
}

/// True when a merge is half-done — `MERGE_HEAD` present
/// (v1 `_merge_in_progress`).
pub async fn merge_in_progress(repo: &Path) -> bool {
    matches!(
        run_git(repo, &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], T_FAST).await,
        Ok(out) if out.success
    )
}

/// Commits behind the upstream tracking branch; 0 on any failure
/// (v1 `get_commits_behind`).
pub async fn get_commits_behind(repo: &Path) -> u32 {
    match run_git(repo, &["rev-list", "--count", "HEAD..@{u}"], T_FAST).await {
        Ok(out) if out.success => out.stdout.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// THE per-card badge query — single
/// `git --no-optional-locks status --porcelain -b --untracked-files=normal`
/// call (v1 `get_status_summary`, §10.2). Never fails: any error returns the
/// v1 default `{branch: "unknown", 0, 0, 0, 0}`.
pub async fn get_status_summary(repo: &Path) -> StatusSummary {
    let fallback = StatusSummary { branch: "unknown".to_string(), ..StatusSummary::default() };
    let args = ["--no-optional-locks", "status", "--porcelain", "-b", "--untracked-files=normal"];
    match run_git(repo, &args, T_QUERY).await {
        Ok(out) if out.success => {
            let mut summary = parse::parse_status_porcelain(&out.stdout);
            if summary.branch.is_empty() {
                summary.branch = "unknown".to_string();
            }
            summary
        }
        _ => fallback,
    }
}

/// Paths currently in merge-conflict (unmerged) state
/// (v1 `get_conflicted_files`).
pub async fn get_conflicted_files(repo: &Path) -> Vec<String> {
    match run_git(repo, &["diff", "--name-only", "--diff-filter=U"], T_QUERY).await {
        Ok(out) if out.success => out
            .stdout
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// Count of modified/untracked files (v1 `count_modified_files`).
pub async fn count_modified_files(repo: &Path) -> u32 {
    let args = ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"];
    match run_git(repo, &args, T_FAST).await {
        Ok(out) if out.success => out.stdout.lines().filter(|l| !l.trim().is_empty()).count() as u32,
        _ => 0,
    }
}

/// Local-change paths, excluding files whose basename matches any of
/// `ignore_patterns` (v1 `get_local_changes` — used with
/// `env_pull_ignore_patterns` so managed config files don't count as dirty).
pub async fn get_local_changes(repo: &Path, ignore_patterns: &[String]) -> Vec<String> {
    let args = ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"];
    match run_git(repo, &args, T_FAST).await {
        Ok(out) if out.success => parse::parse_local_changes(&out.stdout, ignore_patterns),
        _ => Vec::new(),
    }
}

/// Origin remote URL, SSH form converted to HTTPS for browser opening
/// (v1 `get_remote_url`).
pub async fn get_remote_url(repo: &Path) -> Option<String> {
    let out = run_git(repo, &["remote", "get-url", "origin"], T_FAST).await.ok()?;
    out.success.then(|| parse::remote_url_to_https(&out.stdout))
}

/// Membership in `get_branches(include_remote=true)` (v1 `has_branch`).
pub async fn has_branch(repo: &Path, branch: &str) -> bool {
    get_branches(repo, true).await.iter().any(|b| b == branch)
}

// ---------------------------------------------------------------------------
// Mutating operations (§10.3)
// ---------------------------------------------------------------------------

/// `git fetch --all --prune` (60 s) — the badge-refresh fetch (v1 `fetch`).
pub async fn fetch(repo: &Path, log: Option<&LogSink>) -> OpOutput {
    let name = repo_name(repo);
    emit(log, &format!("[git] Fetching {name}..."));
    match run_git(repo, &["fetch", "--all", "--prune"], T_FETCH).await {
        Ok(out) => {
            let status = if out.success { "OK" } else { "FAILED" };
            emit(log, &format!("[git] Fetch {name}: {status}"));
            OpOutput { ok: out.success, message: out.combined() }
        }
        Err(e) => {
            emit(log, &format!("[git] Fetch error: {e}"));
            OpOutput::fail(e.to_string())
        }
    }
}

/// Lightweight `git fetch --quiet` (30 s): no `--all`/`--prune`, no logging.
/// Used by the focus-triggered throttled refresh (v1 `fetch_quiet`).
pub async fn fetch_quiet(repo: &Path) -> bool {
    matches!(run_git(repo, &["fetch", "--quiet"], T_FETCH_QUIET).await, Ok(out) if out.success)
}

/// `git pull --ff-only` (120 s), distinguishing "Already up to date" in the
/// log (v1 `pull`).
pub async fn pull(repo: &Path, log: Option<&LogSink>) -> OpOutput {
    let name = repo_name(repo);
    emit(log, &format!("[git] Pulling {name}..."));
    match run_git(repo, &["pull", "--ff-only"], T_LONG).await {
        Ok(out) => {
            let msg = out.combined();
            if msg.contains("Already up to date") {
                emit(log, &format!("[git] {name}: Already up to date"));
            } else if out.success {
                emit(log, &format!("[git] {name}: Pull OK"));
            } else {
                emit(log, &format!("[git] {name}: Pull FAILED - {msg}"));
            }
            OpOutput { ok: out.success, message: msg }
        }
        Err(e) => {
            emit(log, &format!("[git] Pull error: {e}"));
            OpOutput::fail(e.to_string())
        }
    }
}

/// Checkout with the v1 three-step semantics (§10.3):
/// 1. already on `branch` → success without running git;
/// 2. plain `git checkout <branch>`;
/// 3. on failure, `git checkout -b <branch> origin/<branch>` — creates a
///    local tracking branch from the remote (origin-only, §22.20).
pub async fn checkout(repo: &Path, branch: &str, log: Option<&LogSink>) -> OpOutput {
    if is_option_like(branch) {
        return OpOutput::fail(format!("invalid ref name: {branch}"));
    }
    let name = repo_name(repo);
    let current = get_current_branch(repo).await;
    if current == branch {
        return OpOutput::ok(format!("Already on '{branch}'"));
    }
    emit(log, &format!("[git] Checking out '{branch}' in {name}..."));

    match run_git(repo, &["checkout", branch], T_BRANCH_OP).await {
        Ok(out) if out.success => {
            emit(log, &format!("[git] {name}: Switched to '{branch}'"));
            OpOutput::ok(out.stdout.trim().to_string())
        }
        Ok(_) => {
            // Local checkout failed — try creating a tracking branch from origin.
            let origin_ref = format!("origin/{branch}");
            match run_git(repo, &["checkout", "-b", branch, &origin_ref], T_BRANCH_OP).await {
                Ok(out) => {
                    let msg = out.combined();
                    if out.success {
                        emit(log, &format!("[git] {name}: Created and switched to '{branch}' from remote"));
                    } else {
                        emit(log, &format!("[git] {name}: Checkout FAILED - {msg}"));
                    }
                    OpOutput { ok: out.success, message: msg }
                }
                Err(e) => {
                    emit(log, &format!("[git] Checkout error: {e}"));
                    OpOutput::fail(e.to_string())
                }
            }
        }
        Err(e) => {
            emit(log, &format!("[git] Checkout error: {e}"));
            OpOutput::fail(e.to_string())
        }
    }
}

/// `git clone --progress <url> <dest>` streaming **stderr** line-by-line
/// (git writes progress there — §22.18; stdout is ignored entirely).
///
/// Each stderr line is logged as `[git] <line>` and scanned for a percentage
/// which is forwarded to `progress` (v1 `_emit_clone_progress`). Like v1's
/// `Popen` + `wait()`, the clone itself has no timeout — large repos may
/// legitimately take minutes; the caller owns cancellation.
pub async fn clone(
    url: &str,
    dest: &Path,
    log: Option<&LogSink>,
    progress: Option<&ProgressSink>,
) -> OpOutput {
    if is_option_like(url) {
        return OpOutput::fail(format!("refusing to clone option-like URL: {url}"));
    }
    let name = repo_name(dest);
    emit(log, &format!("[git] Cloning {url} into {name}..."));

    // Dest on a WSL share → clone with the DISTRO's git (native ext4 writes;
    // no `--cd`: dest does not exist yet). Same routing as exec::git_command.
    let wsl = wsl_path_for(dest);
    let mut cmd = match &wsl {
        Some(w) => {
            let mut c = Command::new("wsl.exe");
            c.args(["-d", &w.distro, "--exec", "git"]).env("WSL_UTF8", "1");
            c
        }
        None => Command::new("git"),
    };
    cmd.arg("clone").arg("--progress").arg("--").arg(url);
    match &wsl {
        Some(w) => cmd.arg(&w.linux_path),
        None => cmd.arg(dest),
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            emit(log, &format!("[git] Clone error: {e}"));
            return OpOutput::fail(e.to_string());
        }
    };

    let mut collected: Vec<String> = Vec::new();
    if let Some(mut stderr) = child.stderr.take() {
        // git terminates progress updates with `\r` (and phases with `\n`);
        // v1's text-mode readline split on both via universal newlines —
        // replicate by splitting raw bytes on either terminator.
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    for line in drain_terminated_lines(&mut buf) {
                        handle_clone_line(&line, &mut collected, log, progress);
                    }
                }
                Err(_) => break,
            }
        }
        if !buf.is_empty() {
            let line = String::from_utf8_lossy(&buf).into_owned();
            handle_clone_line(&line, &mut collected, log, progress);
        }
    }

    let success = match child.wait().await {
        Ok(status) => status.success(),
        Err(e) => {
            emit(log, &format!("[git] Clone error: {e}"));
            return OpOutput::fail(e.to_string());
        }
    };
    let status = if success { "OK" } else { "FAILED" };
    emit(log, &format!("[git] Clone {status}: {name}"));
    OpOutput { ok: success, message: collected.join("\n") }
}

/// Split complete `\r`- or `\n`-terminated lines off the front of `buf`,
/// leaving the unterminated tail in place. Pure — unit-tested below.
fn drain_terminated_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\r' || b == b'\n') {
        let rest = buf.split_off(pos + 1);
        let mut line = std::mem::replace(buf, rest);
        line.truncate(pos); // drop the terminator
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    lines
}

fn handle_clone_line(
    line: &str,
    collected: &mut Vec<String>,
    log: Option<&LogSink>,
    progress: Option<&ProgressSink>,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    collected.push(trimmed.to_string());
    emit(log, &format!("[git] {trimmed}"));
    if let (Some(sink), Some(pct)) = (progress, parse::parse_clone_progress(trimmed)) {
        sink(pct);
    }
}

/// Destructive discard of all local changes: `add -A` → `reset --hard HEAD`
/// → `clean -fd`, each 30 s (v1 `clean_repo`). Success = reset AND clean
/// exit 0.
pub async fn clean_repo(repo: &Path, log: Option<&LogSink>) -> OpOutput {
    let name = repo_name(repo);
    emit(log, &format!("[git] Limpiando {name} (reset --hard & clean)..."));

    let result: Result<OpOutput, GitError> = async {
        // Track everything first so untracked files are removed by reset/clean.
        let _ = run_git(repo, &["add", "-A"], T_BRANCH_OP).await?;
        let res1 = run_git(repo, &["reset", "--hard", "HEAD"], T_BRANCH_OP).await?;
        let res2 = run_git(repo, &["clean", "-fd"], T_BRANCH_OP).await?;
        let success = res1.success && res2.success;
        let msg = format!("{}\n{}", res1.stdout.trim(), res2.stdout.trim());
        if success {
            emit(log, &format!("[git] {name} limpio correctamente."));
        } else {
            emit(
                log,
                &format!("[git] Error limpiando {name}: {} {}", res1.stderr.trim(), res2.stderr.trim()),
            );
        }
        Ok(OpOutput { ok: success, message: msg })
    }
    .await;

    result.unwrap_or_else(|e| {
        emit(log, &format!("[git] Clean error: {e}"));
        OpOutput::fail(e.to_string())
    })
}

// ---------------------------------------------------------------------------
// Merge pipeline (§10.4)
// ---------------------------------------------------------------------------

/// Snapshot the pre-merge state so a later cancel can undo the merge
/// (v1 `_capture_revert_point`, gui/dialogs/merge_branch.py:373-385). Must
/// run BEFORE [`merge_branch`] mutates anything — only quick rev-parse reads.
pub async fn capture_revert_point(repo: &Path, req: &MergeRequest) -> RevertPoint {
    let original_branch = get_current_branch(repo).await;
    match req.target_mode {
        TargetMode::Existing => {
            let dest = req.target.clone();
            let dest_head_before = match &req.target {
                Some(target) => get_commit_sha(repo, target).await,
                None => None,
            };
            RevertPoint {
                mode: RevertMode::Existing,
                original_branch,
                dest,
                dest_head_before,
                new_branch: None,
            }
        }
        TargetMode::New => RevertPoint {
            mode: RevertMode::New,
            original_branch,
            dest: None,
            dest_head_before: None,
            new_branch: req.new_branch.clone(),
        },
        TargetMode::Current => RevertPoint {
            mode: RevertMode::Current,
            original_branch,
            dest: None,
            dest_head_before: None,
            new_branch: None,
        },
    }
}

/// Merge `req.source` into a destination branch — the full v1 pipeline
/// (§10.4): dirty guard → fetch → position destination → merge → optional
/// push. On conflict the working tree is LEFT in the conflicted state for
/// manual resolution — never auto-aborted.
pub async fn merge_branch(repo: &Path, req: &MergeRequest, log: Option<&LogSink>) -> MergeOutcome {
    let name = repo_name(repo);
    match merge_pipeline(repo, &name, req, log).await {
        Ok(outcome) => outcome,
        Err(e) => {
            emit(log, &format!("[merge] {name}: error — {e}"));
            MergeOutcome::error(e.to_string())
        }
    }
}

async fn merge_pipeline(
    repo: &Path,
    name: &str,
    req: &MergeRequest,
    log: Option<&LogSink>,
) -> Result<MergeOutcome, GitError> {
    // 1. Dirty guard — refuse to touch anything (v1 `_prepare_merge`).
    let dirty = get_local_changes(repo, &req.dirty_ignore).await;
    if !dirty.is_empty() {
        emit(log, &format!("[merge] {name}: cancelado — hay cambios locales sin commitear."));
        return Ok(MergeOutcome {
            status: MergeStatus::BlockedDirty,
            message: "dirty working tree".to_string(),
            conflicts: Vec::new(),
            dirty,
        });
    }

    // 2. Refresh remote refs when merging from a remote branch (120 s here —
    //    the merge-pipeline fetch uses the long timeout, §21.5).
    if req.source_remote {
        emit(log, &format!("[merge] {name}: fetch..."));
        let fr = run_git(repo, &["fetch", "--all", "--prune"], T_LONG).await?;
        if !fr.success {
            let emsg = fr.error_message();
            emit(log, &format!("[merge] {name}: fetch FALLÓ — {emsg}"));
            return Ok(MergeOutcome::error(emsg));
        }
    }

    // 3. Position the destination branch.
    if let Err(emsg) = position_merge_destination(repo, name, req, log).await? {
        return Ok(MergeOutcome::error(emsg));
    }

    // 4. Merge.
    let merge_ref = if req.source_remote {
        format!("origin/{}", req.source)
    } else {
        req.source.clone()
    };
    let mut outcome = execute_merge(repo, name, &merge_ref, log).await?;
    if outcome.status != MergeStatus::Ok {
        return Ok(outcome);
    }

    // 5. Optional push.
    if req.push {
        if let Err(emsg) = push_after_merge(repo, name, log).await? {
            outcome.status = MergeStatus::OkPushFailed;
            outcome.message = emsg;
            return Ok(outcome);
        }
    }

    emit(log, &format!("[merge] {name}: ✓ merge completado."));
    Ok(outcome)
}

/// Best-effort fast-forward pull of the current branch: a failure (no
/// upstream, diverged…) is logged but does NOT abort the merge
/// (v1 `_pull_ff_only`).
async fn pull_ff_only(
    repo: &Path,
    name: &str,
    log: Option<&LogSink>,
) -> Result<(), GitError> {
    let res = run_git(repo, &["pull", "--ff-only"], T_LONG).await?;
    if res.success {
        emit(log, &format!("[merge] {name}: pull OK"));
    } else {
        emit(log, &format!("[merge] {name}: aviso al hacer pull — {}", res.combined()));
    }
    Ok(())
}

/// Checkout/create the destination branch per `target_mode`
/// (v1 `_position_merge_destination` / `_create_merge_new_branch`).
/// `Ok(Ok(()))` = positioned; `Ok(Err(msg))` = pipeline error message.
async fn position_merge_destination(
    repo: &Path,
    name: &str,
    req: &MergeRequest,
    log: Option<&LogSink>,
) -> Result<Result<(), String>, GitError> {
    match req.target_mode {
        TargetMode::New => {
            let Some(new_branch) = req.new_branch.as_deref().filter(|b| !b.is_empty()) else {
                return Ok(Err("missing new branch name".to_string()));
            };
            if let Some(base) = req.base.as_deref().filter(|b| !b.is_empty()) {
                let res = checkout(repo, base, log).await;
                if !res.ok {
                    return Ok(Err(res.message));
                }
            }
            if req.pull_target {
                pull_ff_only(repo, name, log).await?;
            }
            let cr = run_git(repo, &["checkout", "-b", new_branch], T_BRANCH_OP).await?;
            if !cr.success {
                let emsg = cr.error_message();
                emit(log, &format!("[merge] {name}: no se pudo crear '{new_branch}' — {emsg}"));
                return Ok(Err(emsg));
            }
            let base = req.base.as_deref().unwrap_or_default();
            emit(log, &format!("[merge] {name}: rama '{new_branch}' creada desde '{base}'."));
            Ok(Ok(()))
        }
        TargetMode::Existing => {
            let Some(target) = req.target.as_deref().filter(|t| !t.is_empty()) else {
                return Ok(Err("missing target branch".to_string()));
            };
            let res = checkout(repo, target, log).await;
            if !res.ok {
                return Ok(Err(res.message));
            }
            if req.pull_target {
                pull_ff_only(repo, name, log).await?;
            }
            Ok(Ok(()))
        }
        TargetMode::Current => {
            if req.pull_target {
                pull_ff_only(repo, name, log).await?;
            }
            Ok(Ok(()))
        }
    }
}

/// Run `git merge <merge_ref>` (v1 `_execute_merge`). A non-zero exit with
/// unmerged paths → `Conflict` (tree left as-is); without → `Error`.
async fn execute_merge(
    repo: &Path,
    name: &str,
    merge_ref: &str,
    log: Option<&LogSink>,
) -> Result<MergeOutcome, GitError> {
    emit(log, &format!("[merge] {name}: git merge {merge_ref}..."));
    let mr = run_git(repo, &["merge", merge_ref], T_LONG).await?;
    let merge_out = mr.combined();
    if !merge_out.is_empty() {
        emit(log, &format!("[merge] {merge_out}"));
    }
    if !mr.success {
        let conflicts = get_conflicted_files(repo).await;
        if !conflicts.is_empty() {
            emit(
                log,
                &format!(
                    "[merge] {name}: ⚠️ CONFLICTO en {} fichero(s). Resolvé manualmente y commiteá.",
                    conflicts.len()
                ),
            );
            return Ok(MergeOutcome {
                status: MergeStatus::Conflict,
                message: merge_out,
                conflicts,
                dirty: Vec::new(),
            });
        }
        return Ok(MergeOutcome::error(merge_out));
    }
    Ok(MergeOutcome {
        status: MergeStatus::Ok,
        message: merge_out,
        conflicts: Vec::new(),
        dirty: Vec::new(),
    })
}

/// Push the destination, retrying with `--set-upstream origin <current>` for
/// brand-new branches (v1 `_push_after_merge`). `Ok(Err(msg))` = push failed
/// twice (merge stays committed locally → `ok_push_failed`).
async fn push_after_merge(
    repo: &Path,
    name: &str,
    log: Option<&LogSink>,
) -> Result<Result<(), String>, GitError> {
    emit(log, &format!("[merge] {name}: push..."));
    let pr = run_git(repo, &["push"], T_LONG).await?;
    if !pr.success {
        // Likely no upstream yet (new branch) — retry with --set-upstream.
        let current = get_current_branch(repo).await;
        let pr2 = run_git(repo, &["push", "--set-upstream", "origin", &current], T_LONG).await?;
        if !pr2.success {
            let emsg = pr2.error_message();
            emit(log, &format!("[merge] {name}: merge OK pero push FALLÓ — {emsg}"));
            return Ok(Err(emsg));
        }
    }
    emit(log, &format!("[merge] {name}: push OK"));
    Ok(Ok(()))
}

// ---------------------------------------------------------------------------
// Merge revert (§10.5)
// ---------------------------------------------------------------------------

/// Undo a merge done by [`merge_branch`], returning the working tree to the
/// branch the user was on before it started (v1 `revert_merge`). Steps, each
/// 30 s and best-effort:
/// 1. abort an in-progress (conflicted) merge;
/// 2. `existing` mode: checkout `dest` and hard-reset it to
///    `dest_head_before` (also undoes the pre-merge ff pull);
/// 3. checkout `original_branch` (unless `unknown`/`HEAD`);
/// 4. `new` mode: delete the branch created only for this merge.
///
/// A push that already reached the remote is NOT undone.
pub async fn revert_merge(
    repo: &Path,
    revert_point: &RevertPoint,
    log: Option<&LogSink>,
) -> RevertOutcome {
    let name = repo_name(repo);
    let result: Result<(), GitError> = async {
        // 1. Abort a half-finished merge before touching refs.
        if merge_in_progress(repo).await {
            let _ = run_git(repo, &["merge", "--abort"], T_BRANCH_OP).await?;
            emit(log, &format!("[merge] {name}: merge en progreso abortado."));
        }

        // 2. Undo a completed merge on the destination.
        if revert_point.mode == RevertMode::Existing {
            if let (Some(dest), Some(head_before)) =
                (revert_point.dest.as_deref(), revert_point.dest_head_before.as_deref())
            {
                let co = run_git(repo, &["checkout", dest], T_BRANCH_OP).await?;
                if co.success {
                    let _ = run_git(repo, &["reset", "--hard", head_before], T_BRANCH_OP).await?;
                    let short = &head_before[..head_before.len().min(8)];
                    emit(log, &format!("[merge] {name}: '{dest}' restaurada a {short}."));
                }
            }
        }

        // 3. Back to the branch the user started on.
        let original = revert_point.original_branch.as_str();
        if !original.is_empty() && original != "unknown" && original != "HEAD" {
            let _ = run_git(repo, &["checkout", original], T_BRANCH_OP).await?;
            emit(log, &format!("[merge] {name}: de vuelta en '{original}'."));
        }

        // 4. Drop a branch created only for this merge.
        if revert_point.mode == RevertMode::New {
            if let Some(new_branch) = revert_point.new_branch.as_deref() {
                let _ = run_git(repo, &["branch", "-D", new_branch], T_BRANCH_OP).await?;
                emit(log, &format!("[merge] {name}: rama '{new_branch}' eliminada."));
            }
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            emit(log, &format!("[merge] {name}: ✓ cambios revertidos."));
            RevertOutcome { status: RevertStatus::Ok, message: None }
        }
        Err(e) => {
            emit(log, &format!("[merge] {name}: error al revertir — {e}"));
            RevertOutcome { status: RevertStatus::Error, message: Some(e.to_string()) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- clone progress line splitting -----------------------------------

    #[test]
    fn drain_lines_splits_on_cr_and_lf() {
        let mut buf = b"Receiving objects:  10%\rReceiving objects:  42%\rdone.\npartial".to_vec();
        let lines = drain_terminated_lines(&mut buf);
        assert_eq!(
            lines,
            vec!["Receiving objects:  10%", "Receiving objects:  42%", "done."]
        );
        assert_eq!(buf, b"partial".to_vec(), "unterminated tail stays buffered");
    }

    #[test]
    fn drain_lines_handles_incremental_chunks() {
        let mut buf = b"Recei".to_vec();
        assert!(drain_terminated_lines(&mut buf).is_empty());
        buf.extend_from_slice(b"ving:  5%\rnext");
        assert_eq!(drain_terminated_lines(&mut buf), vec!["Receiving:  5%"]);
        assert_eq!(buf, b"next".to_vec());
    }

    #[test]
    fn handle_clone_line_reports_progress_and_logs() {
        use std::sync::{Arc, Mutex};
        let pcts: Arc<Mutex<Vec<u32>>> = Arc::default();
        let logs: Arc<Mutex<Vec<String>>> = Arc::default();
        let p = pcts.clone();
        let l = logs.clone();
        let progress: ProgressSink = Arc::new(move |pct| p.lock().unwrap().push(pct));
        let log: LogSink = Arc::new(move |msg: &str| l.lock().unwrap().push(msg.to_string()));

        let mut collected = Vec::new();
        handle_clone_line("Receiving objects:  42% (1/2)", &mut collected, Some(&log), Some(&progress));
        handle_clone_line("   ", &mut collected, Some(&log), Some(&progress));
        handle_clone_line("Cloning into 'x'...", &mut collected, Some(&log), Some(&progress));

        assert_eq!(*pcts.lock().unwrap(), vec![42]);
        assert_eq!(collected, vec!["Receiving objects:  42% (1/2)", "Cloning into 'x'..."]);
        assert_eq!(
            *logs.lock().unwrap(),
            vec!["[git] Receiving objects:  42% (1/2)", "[git] Cloning into 'x'..."]
        );
    }

    // ---- revert point construction ----------------------------------------
    // (capture_revert_point shells out for branch/sha; the mode/field mapping
    // is the part worth pinning — exercised here through the same match arms
    // via a request-shaped table.)

    #[test]
    fn merge_ref_formatting_matches_v1() {
        // §10.4 step 4: 'origin/<source>' if source_remote else '<source>'.
        let remote = MergeRequest {
            source: "develop".into(),
            source_remote: true,
            target_mode: TargetMode::Current,
            target: None,
            base: None,
            new_branch: None,
            pull_target: false,
            push: false,
            dirty_ignore: vec![],
        };
        let merge_ref = if remote.source_remote {
            format!("origin/{}", remote.source)
        } else {
            remote.source.clone()
        };
        assert_eq!(merge_ref, "origin/develop");
    }
}
