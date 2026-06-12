//! Git subprocess execution — the only place this module spawns processes.
//!
//! Mirrors v1's `_run_git_command` (inventory-backend.md §10): no shell,
//! `cwd=repo_path`, UTF-8 with lossy replacement, per-command timeout from
//! the v1 table (§21.5), `CREATE_NO_WINDOW` on Windows. Parsing lives in
//! [`super::parse`] so it stays pure and unit-testable.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::types::GitError;

/// v1 timeout table for git (inventory-backend.md §10, §21.5), in seconds.
pub(crate) const T_QUERY: u64 = 10; // status/branch/reflog/diff queries
pub(crate) const T_FAST: u64 = 5; // rev-parse / rev-list / remote get-url
pub(crate) const T_BRANCH_OP: u64 = 30; // checkout / reset / clean / branch -D / merge --abort
pub(crate) const T_FETCH: u64 = 60; // git fetch --all --prune (badge refresh path)
pub(crate) const T_FETCH_QUIET: u64 = 30; // git fetch --quiet
pub(crate) const T_LONG: u64 = 120; // pull / merge / push / merge-pipeline fetch

/// Captured output of a finished git command.
#[derive(Debug)]
pub(crate) struct GitOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl GitOutput {
    /// `stdout + "\n" + stderr`, trimmed — v1's combined-message convention.
    pub fn combined(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr).trim().to_string()
    }

    /// v1's `(stderr or stdout).strip()` error-message preference.
    pub fn error_message(&self) -> String {
        let err = self.stderr.trim();
        if err.is_empty() { self.stdout.trim().to_string() } else { err.to_string() }
    }
}

/// Run `git <args>` in `repo` with a timeout. The child is killed if the
/// timeout elapses (`kill_on_drop`).
pub(crate) async fn run_git(
    repo: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<GitOutput, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // CREATE_NO_WINDOW — every v1 subprocess uses it (inventory §21.5).
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| GitError::Timeout(timeout_secs))?
        .map_err(|e| GitError::Spawn(e.to_string()))?;

    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Repo display name = directory basename (v1 `os.path.basename(repo_path)`).
pub(crate) fn repo_name(repo: &Path) -> String {
    repo.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo.display().to_string())
}
