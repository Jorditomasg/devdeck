//! Git module types — results, requests and error model.
//!
//! v1 returned `(bool, str)` tuples and swallowed exceptions
//! (inventory-backend.md §5); the public operations here keep that spirit by
//! folding failures into [`OpOutput`] / outcome structs, while the internal
//! executor surfaces [`GitError`] so the merge pipeline can map a spawn or
//! timeout failure to its `error` status exactly like v1's `except` blocks.
//!
//! `LogSink` / `OpOutput` are the shared `crate::domain::op_output` types,
//! re-exported here so existing `git::types::*` imports keep working.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use crate::domain::op_output::{LogSink, OpOutput};
pub(crate) use crate::domain::op_output::emit;

/// Callback receiving clone progress percentages (inventory-backend.md §10.3,
/// `_emit_clone_progress`).
pub type ProgressSink = Arc<dyn Fn(u32) + Send + Sync>;

/// Errors from the git executor (spawn/timeout). Public ops fold these into
/// `OpOutput`; the merge pipeline maps them to `MergeStatus::Error`.
#[derive(Debug, Error)]
pub enum GitError {
    /// The `git` binary could not be spawned or its IO failed.
    #[error("failed to run git: {0}")]
    Spawn(String),
    /// The command exceeded its v1 timeout (inventory-backend.md §21.5).
    #[error("git command timed out after {0} s")]
    Timeout(u64),
}

/// Result of `get_status_summary` — the per-card badge query
/// (inventory-backend.md §10.2). Field semantics follow v1's exact tallying
/// rules, including the double-count of partially staged files (§22.19).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusSummary {
    pub branch: String,
    pub behind: u32,
    pub staged: u32,
    pub unstaged: u32,
    pub conflicts: u32,
}

/// One entry of `git stash list` (the stash-management dialog — no v1
/// equivalent). `index` is the 0-based position addressing `stash@{index}`;
/// `message` is the human description; `branch` is the branch the stash was
/// created on (best-effort — empty for a stash made off a detached HEAD).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub branch: String,
}

/// Branch list ordered by reflog recency (inventory-backend.md §10.1,
/// `order_branches_by_recency`). `recent_count` is the index where the
/// alphabetical section starts — the UI draws a separator there.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrderedBranches {
    pub branches: Vec<String>,
    pub recent_count: usize,
}

/// Where the merge lands (inventory-backend.md §10.4 `target_mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TargetMode {
    /// Merge into the branch currently checked out.
    #[default]
    Current,
    /// Checkout `target` first, then merge.
    Existing,
    /// Checkout `base`, create `new_branch` from it, then merge.
    New,
}

/// Parameters of the merge pipeline (inventory-backend.md §10.4 —
/// `merge_branch` keyword arguments, with v1's defaults).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    /// Source branch name (without `origin/`).
    pub source: String,
    /// `true` → fetch first and merge `origin/<source>`; `false` → merge the
    /// local `<source>` branch as-is.
    #[serde(default = "default_true")]
    pub source_remote: bool,
    #[serde(default)]
    pub target_mode: TargetMode,
    /// Required for `TargetMode::Existing`.
    #[serde(default)]
    pub target: Option<String>,
    /// Optional base branch for `TargetMode::New`.
    #[serde(default)]
    pub base: Option<String>,
    /// Required for `TargetMode::New`.
    #[serde(default)]
    pub new_branch: Option<String>,
    /// Fast-forward pull of the destination before merging (best-effort).
    #[serde(default = "default_true")]
    pub pull_target: bool,
    /// Push the destination after a clean merge (auto `--set-upstream`).
    #[serde(default)]
    pub push: bool,
    /// Glob patterns whose matching basenames are ignored by the dirty guard
    /// (`env_pull_ignore_patterns`).
    #[serde(default)]
    pub dirty_ignore: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// The five documented merge outcomes (inventory-backend.md §10.4).
/// Serialized values match v1's status strings exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeStatus {
    /// Merge (and push, when requested) completed.
    Ok,
    /// `git merge` left conflicts; the working tree is LEFT conflicted for
    /// manual resolution (never auto-aborted).
    Conflict,
    /// Uncommitted local changes — nothing was touched.
    BlockedDirty,
    /// Fetch/position/merge failure without conflicts.
    Error,
    /// Merge committed locally but the push failed (even with
    /// `--set-upstream` retry).
    OkPushFailed,
}

/// Result of [`crate::git::merge_branch`] — mirrors the v1 result dict.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub status: MergeStatus,
    pub message: String,
    /// Conflicted paths when `status == Conflict`.
    pub conflicts: Vec<String>,
    /// Dirty paths when `status == BlockedDirty`.
    pub dirty: Vec<String>,
}

impl MergeOutcome {
    pub(crate) fn error(message: impl Into<String>) -> Self {
        Self {
            status: MergeStatus::Error,
            message: message.into(),
            conflicts: Vec::new(),
            dirty: Vec::new(),
        }
    }
}

/// Revert-point mode (inventory-backend.md §10.5). Mirrors the merge's
/// `target_mode`: the v1 dialog snapshots `params['target_mode']` verbatim
/// (gui/dialogs/merge_branch.py:373-385), so `current` is a valid persisted
/// value even though `revert_merge` has no extra step for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RevertMode {
    Current,
    Existing,
    New,
}

/// Snapshot captured BEFORE a merge mutates anything, used by
/// [`crate::git::revert_merge`]. Field names keep the documented v1 dict keys
/// (inventory-backend.md §10.5) so v1-era payloads stay readable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevertPoint {
    pub mode: RevertMode,
    pub original_branch: String,
    /// `Existing` mode: destination branch name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dest: Option<String>,
    /// `Existing` mode: full SHA of the destination before the merge
    /// (also undoes the pre-merge ff pull).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dest_head_before: Option<String>,
    /// `New` mode: the branch created only for this merge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_branch: Option<String>,
}

/// Result of [`crate::git::revert_merge`] — v1 returned
/// `{'status': 'ok'}` or `{'status': 'error', 'message': …}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertOutcome {
    pub status: RevertStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RevertStatus {
    Ok,
    Error,
}
