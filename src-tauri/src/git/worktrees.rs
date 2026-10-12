//! Git worktrees (`git worktree …`) — docs/superpowers/specs/2026-10-12-git-worktrees-design.md.
//!
//! NOT to be confused with [`super::worktree`] (the working-tree changes
//! window). Worktrees live in `<root>/<repo>.worktrees/<folder>`, a sibling of
//! the parent repo, so they share its filesystem (Windows or WSL distro) and
//! the git routing in [`super::exec`] applies unchanged. `add` passes git a
//! RELATIVE target (`../<repo>.worktrees/<folder>`) so the same argv works for
//! Windows git and in-distro git alike.

use std::path::{Path, PathBuf};

use super::exec::{is_option_like, repo_name, run_git, run_logged_op, T_BRANCH_OP, T_FAST, T_LONG, T_QUERY};
use super::types::{emit, LogSink, OpOutput};

/// Suffix of the sibling directory holding a repo's worktrees. The workspace
/// scanner skips directories ending with it.
pub const WORKTREES_DIR_SUFFIX: &str = ".worktrees";

/// One `git worktree list --porcelain` record.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorktreeEntry {
    /// Path as git prints it (Linux path for in-distro git).
    pub path: String,
    /// Short branch name; `None` = detached HEAD (or bare).
    pub branch: Option<String>,
    pub bare: bool,
}

/// How `add` picks the worktree's branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddMode {
    /// Create `branch` off `base` (HEAD when absent).
    New,
    /// Check out the existing local `branch`.
    Existing,
    /// Create local `branch` tracking the remote ref `base` (e.g. `origin/x`).
    Remote,
}

/// All worktrees of `repo` (the first entry is the main worktree).
pub async fn list(repo: &Path) -> Result<Vec<WorktreeEntry>, String> {
    let out = run_git(repo, &["worktree", "list", "--porcelain"], T_QUERY)
        .await
        .map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.error_message());
    }
    Ok(parse_list(&out.stdout))
}

/// Host (Windows-visible) path of a worktree path printed by `repo`'s git:
/// in-distro git prints Linux paths, re-rooted onto the repo's UNC share.
pub fn host_path(repo: &Path, git_path: &str) -> PathBuf {
    match super::exec::wsl_path_for(repo) {
        Some(wsl) => PathBuf::from(format!(r"\\wsl.localhost\{}{}", wsl.distro, git_path.replace('/', "\\"))),
        None => PathBuf::from(git_path),
    }
}

/// Inverse of [`host_path`]: the path `repo`'s git understands.
fn git_path(path: &Path) -> String {
    match super::exec::wsl_path_for(path) {
        Some(wsl) => wsl.linux_path,
        None => path.display().to_string(),
    }
}

/// `<repo-parent>/<repo-dir>.worktrees/<folder>` — where `add` puts a branch.
pub fn target_dir(repo: &Path, branch: &str) -> PathBuf {
    let parent = repo.parent().unwrap_or(repo);
    parent
        .join(format!("{}{WORKTREES_DIR_SUFFIX}", repo_name(repo)))
        .join(folder_for_branch(branch))
}

/// `git worktree add` into [`target_dir`]. Returns the new worktree's host
/// path on success.
pub async fn add(
    repo: &Path,
    branch: &str,
    mode: AddMode,
    base: Option<&str>,
    log: Option<&LogSink>,
) -> Result<PathBuf, OpOutput> {
    let branch = branch.trim();
    let base = base.map(str::trim).filter(|b| !b.is_empty());
    if branch.is_empty() || is_option_like(branch) || base.is_some_and(is_option_like) {
        return Err(OpOutput::fail(format!("invalid branch name: {branch}")));
    }
    if mode == AddMode::Remote && base.is_none() {
        return Err(OpOutput::fail("a remote branch is required"));
    }
    let valid = run_git(repo, &["check-ref-format", "--branch", branch], T_FAST).await;
    if !matches!(valid, Ok(ref out) if out.success) {
        return Err(OpOutput::fail(format!("invalid branch name: {branch}")));
    }
    let target = target_dir(repo, branch);
    if target.exists() {
        return Err(OpOutput::fail(format!("folder already exists: {}", target.display())));
    }
    let rel = format!(
        "../{}{WORKTREES_DIR_SUFFIX}/{}",
        repo_name(repo),
        folder_for_branch(branch)
    );
    let mut args: Vec<&str> = vec!["worktree", "add"];
    match mode {
        AddMode::New => args.extend(["-b", branch, rel.as_str()]),
        AddMode::Existing => args.extend([rel.as_str(), branch]),
        AddMode::Remote => args.extend(["--track", "-b", branch, rel.as_str()]),
    }
    if mode != AddMode::Existing {
        args.extend(base);
    }
    emit(log, &format!("[git] {}: git {}", repo_name(repo), args.join(" ")));
    let out = run_logged_op(repo, &args, T_LONG, log).await;
    if out.ok { Ok(target) } else { Err(out) }
}

/// `git worktree remove [--force] <worktree>`, run in the parent repo.
pub async fn remove(repo: &Path, worktree: &Path, force: bool, log: Option<&LogSink>) -> OpOutput {
    let path = git_path(worktree);
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    emit(log, &format!("[git] {}: git {}", repo_name(repo), args.join(" ")));
    run_logged_op(repo, &args, T_BRANCH_OP, log).await
}

/// `git worktree prune` — forget worktrees whose folder is gone.
pub async fn prune(repo: &Path, log: Option<&LogSink>) -> OpOutput {
    emit(log, &format!("[git] {}: git worktree prune", repo_name(repo)));
    run_logged_op(repo, &["worktree", "prune", "-v"], T_BRANCH_OP, log).await
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested below)
// ---------------------------------------------------------------------------

/// Parse `git worktree list --porcelain`: blank-line separated records of
/// `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<b>` / `detached` /
/// `bare` / `locked` / `prunable` lines.
fn parse_list(stdout: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            entries.extend(current.take());
            current = Some(WorktreeEntry { path: path.to_string(), ..Default::default() });
        } else if let Some(entry) = current.as_mut() {
            if let Some(r) = line.strip_prefix("branch ") {
                entry.branch = Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string());
            } else if line == "bare" {
                entry.bare = true;
            }
        }
    }
    entries.extend(current);
    entries
}

/// Branch → folder name: anything outside `[A-Za-z0-9._-]` becomes `-`
/// (`feature/x` → `feature-x`).
pub fn folder_for_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect()
}

/// First port above `base` that is neither `taken` nor rejected by
/// `bindable`. ponytail: linear probe of ≤ 100 ports, plenty for a dev box.
pub fn suggest_port(base: u16, taken: &[u16], bindable: impl Fn(u16) -> bool) -> Option<u16> {
    (1..=100u16)
        .filter_map(|i| base.checked_add(i))
        .find(|p| !taken.contains(p) && bindable(*p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_list() {
        let raw = "worktree /ws/app\nHEAD aaa\nbranch refs/heads/main\n\n\
worktree /ws/app.worktrees/feature-x\nHEAD bbb\nbranch refs/heads/feature/x\nlocked\n\n\
worktree /ws/app.worktrees/det\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n\n";
        let list = parse_list(raw);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].path, "/ws/app.worktrees/feature-x");
        assert_eq!(list[1].branch.as_deref(), Some("feature/x"));
        assert_eq!(list[2].branch, None);
        assert!(parse_list("worktree /ws/b.git\nbare\n")[0].bare);
        assert!(parse_list("").is_empty());
    }

    #[test]
    fn sanitizes_branch_folders() {
        assert_eq!(folder_for_branch("feature/x"), "feature-x");
        assert_eq!(folder_for_branch("fix/JIRA-12_a.b"), "fix-JIRA-12_a.b");
        assert_eq!(folder_for_branch("a b:c"), "a-b-c");
    }

    #[test]
    fn target_is_sibling_worktrees_dir() {
        let t = target_dir(Path::new("/ws/app"), "feature/x");
        assert_eq!(t, Path::new("/ws/app.worktrees/feature-x"));
    }

    #[test]
    fn suggests_first_free_port() {
        assert_eq!(suggest_port(8080, &[], |_| true), Some(8081));
        assert_eq!(suggest_port(8080, &[8081, 8082], |_| true), Some(8083));
        assert_eq!(suggest_port(8080, &[8081], |p| p != 8082), Some(8083));
        assert_eq!(suggest_port(65535, &[], |_| true), None);
    }
}
