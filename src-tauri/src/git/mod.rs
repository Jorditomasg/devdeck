//! Git operations via the `git` CLI (not libgit2 — v1 semantics are CLI-shaped
//! and credentials/config come free).
//!
//! Replaces `core/git_manager.py` in full (inventory-backend.md §10):
//! - Badge query: `git --no-optional-locks status --porcelain -b` parsed into
//!   `{branch, behind, staged, unstaged, conflicts}` with v1's exact counting
//!   rules, including the double-count of partially staged files (§22.19).
//! - Branch listing + reflog-based recency ordering (§10.1).
//! - fetch / fetch_quiet / pull --ff-only / checkout (with
//!   `origin/<branch>` tracking fallback) / clone with stderr progress
//!   percentages / clean (add -A, reset --hard, clean -fd) (§10.3).
//! - Merge pipeline with `blocked_dirty` / `conflict` / `ok_push_failed`
//!   outcomes and revert points (§10.4-10.5).
//! - v1 timeout table preserved (§21.5); badge/fetch concurrency capped by
//!   the semaphores in `AppState` (3 / 2, inventory-gui.md §28).
//! - The 30 s per-repo badge poll loop lives HERE (tokio task), emitting
//!   `events::GIT_BADGE` — the frontend never polls.
//!
//! Layout: [`exec`] (the only process spawner), [`parse`] (pure,
//! unit-tested parsers), [`types`] (results/requests/errors), [`ops`]
//! (the v1 `git_manager.py` operation surface), [`poll`] (badge loop).

pub mod branch;
mod exec;
pub mod history;
mod session;
pub mod ops;
pub mod parse;
pub mod poll;
pub mod stash;
pub mod types;
pub mod worktree;

pub use ops::{
    capture_revert_point, checkout, clean_repo, clone, count_modified_files, fetch, fetch_quiet,
    get_branches, get_commit_sha, get_commits_behind, get_conflicted_files, get_current_branch,
    get_local_changes, get_ordered_branches, get_recent_checked_out_branches, get_remote_url,
    get_status_summary, has_branch, merge_branch, merge_in_progress, pull, revert_merge,
    DEFAULT_BRANCH_RECENCY_LIMIT,
};
pub use history::{
    get_authors, get_commit_body, get_commit_file_diff, get_commit_files, get_file_at_commit,
    get_log, get_range_file_diff, get_range_files, get_working_diff, list_files, list_tags, AuthorInfo,
    CommitFileStat, CommitInfo, FileAtCommit, FileDiff, LogFilter, LogPage,
};
pub use poll::{refresh_badge, spawn_badge_poller, BadgePoller, BADGE_REFRESH};
pub use stash::{stash_apply, stash_drop, stash_list, stash_pop, stash_push};
pub use worktree::{
    discard_file, get_changes, read_working_file, stage_file, unstage_file, write_working_file,
    ChangeEntry,
};
pub use branch::{
    create_branch, delete_branch, delete_remote_branch, publish_branch, rename_branch,
};
pub use types::{
    GitError, LogSink, MergeOutcome, MergeRequest, MergeStatus, OpOutput, OrderedBranches,
    ProgressSink, RevertMode, RevertOutcome, RevertPoint, RevertStatus, StashEntry, StatusSummary,
    TargetMode,
};
