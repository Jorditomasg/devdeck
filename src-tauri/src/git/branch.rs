//! Git branch-management operations — the branch dialog surface. v1 only
//! listed + checked out branches; create/delete/rename/publish are v2
//! additions. Mutations fold into [`OpOutput`] like the rest of the surface.

use std::path::Path;

use super::exec::{run_logged_op, T_BRANCH_OP, T_LONG};
use super::types::{LogSink, OpOutput};

/// `git checkout -b <name> [base]` when `checkout`, else `git branch <name>
/// [base]`. A blank/`None` base omits the base argument (branch off HEAD).
pub async fn create_branch(
    repo: &Path,
    name: &str,
    base: Option<&str>,
    checkout: bool,
    log: Option<&LogSink>,
) -> OpOutput {
    let mut args: Vec<&str> = if checkout {
        vec!["checkout", "-b", name]
    } else {
        vec!["branch", name]
    };
    if let Some(base) = base.map(str::trim).filter(|b| !b.is_empty()) {
        args.push(base);
    }
    run_logged_op(repo, &args, T_BRANCH_OP, log).await
}

/// `git branch -d <name>` (or `-D` when `force` — drops the merged-check).
pub async fn delete_branch(repo: &Path, name: &str, force: bool, log: Option<&LogSink>) -> OpOutput {
    let flag = if force { "-D" } else { "-d" };
    run_logged_op(repo, &["branch", flag, name], T_BRANCH_OP, log).await
}

/// `git push origin --delete <name>` — removes the branch on the remote.
pub async fn delete_remote_branch(repo: &Path, name: &str, log: Option<&LogSink>) -> OpOutput {
    run_logged_op(repo, &["push", "origin", "--delete", name], T_LONG, log).await
}

/// `git branch -m [from] <to>`. A blank/`None` `from` renames the current
/// branch.
pub async fn rename_branch(
    repo: &Path,
    from: Option<&str>,
    to: &str,
    log: Option<&LogSink>,
) -> OpOutput {
    let mut args: Vec<&str> = vec!["branch", "-m"];
    if let Some(from) = from.map(str::trim).filter(|f| !f.is_empty()) {
        args.push(from);
    }
    args.push(to);
    run_logged_op(repo, &args, T_BRANCH_OP, log).await
}

/// `git push -u origin <name>` — publish + set upstream tracking.
pub async fn publish_branch(repo: &Path, name: &str, log: Option<&LogSink>) -> OpOutput {
    run_logged_op(repo, &["push", "-u", "origin", name], T_LONG, log).await
}
