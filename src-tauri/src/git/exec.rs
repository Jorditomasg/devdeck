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

/// Run a MUTATING git command and fold the result into [`OpOutput`], logging
/// the combined output (the v1 `(ok, message)` idiom). Shared by the
/// stash/branch operation surfaces so they never duplicate the fold logic.
pub(crate) async fn run_logged_op(
    repo: &Path,
    args: &[&str],
    timeout_secs: u64,
    log: Option<&super::types::LogSink>,
) -> super::types::OpOutput {
    use super::types::{emit, OpOutput};
    let name = repo_name(repo);
    match run_git(repo, args, timeout_secs).await {
        Ok(out) if out.success => {
            let msg = out.combined();
            if !msg.is_empty() {
                emit(log, &format!("[git] {name}: {msg}"));
            }
            OpOutput::ok(msg)
        }
        Ok(out) => {
            let msg = out.error_message();
            emit(log, &format!("[git] {name}: {msg}"));
            OpOutput::fail(msg)
        }
        Err(err) => {
            let msg = err.to_string();
            emit(log, &format!("[git] {name}: {msg}"));
            OpOutput::fail(msg)
        }
    }
}

/// A ref/URL argument git would parse as an option (a leading `-`, e.g.
/// `--upload-pack=<cmd>`). Guarded at every public entry point that forwards an
/// untrusted ref, branch, or clone URL to git, so a value can never be promoted
/// to a flag (argument injection). See `branch.rs` for why a uniform `--`
/// end-of-options guard is not always usable.
pub(crate) fn is_option_like(value: &str) -> bool {
    value.starts_with('-')
}

/// Repo display name = directory basename (v1 `os.path.basename(repo_path)`).
pub(crate) fn repo_name(repo: &Path) -> String {
    repo.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::is_option_like;

    #[test]
    fn flags_leading_dash_as_option_like() {
        // Argument-injection guard: these would be parsed as git flags.
        assert!(is_option_like("--upload-pack=touch pwned"));
        assert!(is_option_like("-x"));
        // Legitimate refs / URLs must pass.
        assert!(!is_option_like("main"));
        assert!(!is_option_like("feature/x"));
        assert!(!is_option_like("https://github.com/a/b.git"));
    }
}
