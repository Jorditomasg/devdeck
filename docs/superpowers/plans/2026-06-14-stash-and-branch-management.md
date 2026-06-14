# Git Stash & Branch Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add git stash management (add/list/apply/pop/drop) and branch management (create/delete-local/delete-remote/rename/publish) as two new repo-card dialogs, plus a "stash & retry" path when a merge is blocked by uncommitted changes.

**Architecture:** Follows the existing merge vertical slice exactly — Rust owns all side effects (CLI shell-outs folded into `OpOutput`), Angular is pure UI over the typed IPC contract. New Rust modules `git/stash.rs` + `git/branch.rs` keep the >700-line `git/ops.rs` untouched. 10 new IPC commands, two new `DialogBase` dialogs, one new generic prompt dialog.

**Tech Stack:** Rust (tokio, serde, tauri 2), Angular 22 (zoneless, signals, standalone), vitest (frontend specs), cargo test (Rust parser tests).

---

## Project conventions (MUST follow — from CLAUDE.md)

- **Conventional commits, NO `Co-Authored-By` / AI attribution.** Commit only the files in each task.
- **Never run production builds** to verify (`npm run build`, `tauri build`). Verify via tests only.
- **Wire names live once** in `core/ipc/commands.ts` (`CMD`). Rust command fns are snake_case; arg keys are camelCase on the wire (Tauri v2 converts automatically — Rust params stay snake_case).
- **i18n**: `en.json` and `es.json` MUST keep identical key structure.
- **No ESM cycles**: run `npx madge --circular --extensions ts src/app` after the dialog/service edits.
- **Rust test caveat**: `cargo test --manifest-path src-tauri/Cargo.toml` may require `npm run build` once so `generate_context!` finds the frontend dist. This is the one allowed build (test prerequisite, not a verification build).

## File structure

**Rust (new):**
- `src-tauri/src/git/stash.rs` — stash ops (list/push/apply/pop/drop).
- `src-tauri/src/git/branch.rs` — branch ops (create/delete/delete-remote/rename/publish).

**Rust (modified):**
- `src-tauri/src/git/types.rs` — add `StashEntry`.
- `src-tauri/src/git/parse.rs` — add `parse_stash_list` (+ helpers) + unit tests.
- `src-tauri/src/git/exec.rs` — add shared `run_logged_op` helper.
- `src-tauri/src/git/mod.rs` — declare modules, re-export new ops/types.
- `src-tauri/src/commands/git.rs` — 10 new `#[tauri::command]` fns (#62–#71).
- `src-tauri/src/lib.rs` — register the 10 commands.

**Frontend (new):**
- `src/app/features/dialogs/prompt/prompt-dialog.component.ts` — generic text prompt.
- `src/app/features/dialogs/stash/stash.logic.ts` (+ `.spec.ts`).
- `src/app/features/dialogs/stash/stash-dialog.component.ts`.
- `src/app/features/dialogs/branch/branch.logic.ts` (+ `.spec.ts`).
- `src/app/features/dialogs/branch/branch-dialog.component.ts`.

**Frontend (modified):**
- `src/app/core/ipc/tauri.types.ts` — `StashEntry`.
- `src/app/core/ipc/commands.ts` — `CMD` entries + `git` wrappers.
- `src/app/core/ipc/commands.spec.ts` — count 61 → 71 + payload tests.
- `src/app/features/dialogs/dialog.service.ts` — `openStash`, `openBranches`, `prompt`.
- `src/app/features/workspace/repo-card/card-expand.component.ts` — Stash/Branches buttons + outputs + `CardExpandText` fields.
- `src/app/features/workspace/repo-card/repo-card.component.ts` — `onStash`/`onBranches` handlers + `expandText`.
- `src/app/features/dialogs/merge-branch/merge-branch-dialog.component.ts` — stash-and-retry on `blocked_dirty`.
- `src/assets/i18n/en.json`, `src/assets/i18n/es.json` — `dialog.stash.*`, `dialog.branch.*`, `dialog.prompt.*`, merge stash keys, `btn.stash`/`btn.branches`, `tooltip.stash_btn`/`tooltip.branches_btn`.
- `docs/migration/ipc-contract.md` — §2.4 append #62–#71.

---

## Task 1: `StashEntry` type + `parse_stash_list` parser

**Files:**
- Modify: `src-tauri/src/git/types.rs` (after `StatusSummary`, ~line 47)
- Modify: `src-tauri/src/git/parse.rs` (add fns + import + tests)

- [ ] **Step 1: Add the `StashEntry` type**

In `src-tauri/src/git/types.rs`, after the `StatusSummary` struct (line 47), add:

```rust
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
```

- [ ] **Step 2: Write the failing parser test**

In `src-tauri/src/git/parse.rs`, inside the `#[cfg(test)] mod tests` block (after the reflog tests, ~line 299), add:

```rust
    // ---- stash list ----------------------------------------------------

    #[test]
    fn stash_list_parses_index_branch_and_message() {
        // Format: "%gd\x1f%gs" → selector \x1f reflog-subject.
        let output = "\
stash@{0}\u{1f}On feature/login: tweak validation
stash@{1}\u{1f}WIP on main: 1a2b3c add endpoint
stash@{2}\u{1f}On develop: nightly checkpoint
";
        assert_eq!(
            parse_stash_list(output),
            vec![
                StashEntry { index: 0, message: "tweak validation".into(), branch: "feature/login".into() },
                StashEntry { index: 1, message: "1a2b3c add endpoint".into(), branch: "main".into() },
                StashEntry { index: 2, message: "nightly checkpoint".into(), branch: "develop".into() },
            ]
        );
    }

    #[test]
    fn stash_list_handles_empty_and_malformed_lines() {
        assert_eq!(parse_stash_list(""), Vec::new());
        // A line without the unit separator is skipped.
        assert_eq!(parse_stash_list("garbage with no separator\n"), Vec::new());
    }
```

Add `StashEntry` to the parse.rs import at the top (line 11):

```rust
use super::types::{StashEntry, StatusSummary};
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml stash_list -- --nocapture`
Expected: FAIL — `cannot find function parse_stash_list`.

- [ ] **Step 4: Implement `parse_stash_list`**

In `src-tauri/src/git/parse.rs`, after `parse_reflog_checkouts` (line 69), add:

```rust
/// Parse `git stash list --format=%gd%x1f%gs` output into [`StashEntry`]s.
/// `%gd` is the selector (`stash@{N}`); `%gs` is the reflog subject, one of:
///   `WIP on <branch>: <sha> <subject>`  (auto / plain `git stash`)
///   `On <branch>: <message>`            (`git stash push -m <message>`)
/// The two fields are joined by the unit separator `\x1f` so the message can
/// safely contain spaces and colons. Lines without the separator are skipped.
pub fn parse_stash_list(output: &str) -> Vec<StashEntry> {
    output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let (selector, subject) = line.split_once('\u{1f}')?;
            let (branch, message) = parse_stash_subject(subject);
            Some(StashEntry { index: parse_stash_index(selector), message, branch })
        })
        .collect()
}

/// Extract `N` from a `stash@{N}` selector; 0 on any malformed input.
fn parse_stash_index(selector: &str) -> usize {
    selector
        .split_once('{')
        .and_then(|(_, rest)| rest.split_once('}'))
        .and_then(|(num, _)| num.trim().parse().ok())
        .unwrap_or(0)
}

/// Split a stash reflog subject into `(branch, message)`. The branch is the
/// token after the `WIP on `/`On ` prefix; the message is the text after the
/// first `: `. A subject with no `: ` keeps the whole string as the message.
fn parse_stash_subject(subject: &str) -> (String, String) {
    let (head, message) = match subject.split_once(": ") {
        Some((h, m)) => (h, m.to_string()),
        None => (subject, subject.to_string()),
    };
    let branch = head
        .trim_start_matches("WIP on ")
        .trim_start_matches("On ")
        .trim()
        .to_string();
    (branch, message)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml stash_list`
Expected: PASS (both stash tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/git/types.rs src-tauri/src/git/parse.rs
git commit -m "feat(git): add StashEntry type and stash-list parser"
```

---

## Task 2: Shared `run_logged_op` helper in `exec.rs`

**Files:**
- Modify: `src-tauri/src/git/exec.rs` (after `run_git`, ~line 77)

- [ ] **Step 1: Add the shared op runner**

In `src-tauri/src/git/exec.rs`, after the `run_git` fn (line 77), add:

```rust
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
```

- [ ] **Step 2: Verify it compiles (run the existing git tests)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib git::`
Expected: PASS (no behavior change; the helper is unused until Task 3 — a `dead_code` warning is acceptable here and disappears in Task 3).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/git/exec.rs
git commit -m "feat(git): add shared run_logged_op helper for op surfaces"
```

---

## Task 3: `git/stash.rs` operations

**Files:**
- Create: `src-tauri/src/git/stash.rs`
- Modify: `src-tauri/src/git/mod.rs`

- [ ] **Step 1: Create `src-tauri/src/git/stash.rs`**

```rust
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
```

- [ ] **Step 2: Declare + re-export the module in `mod.rs`**

In `src-tauri/src/git/mod.rs`, add `pub mod stash;` after `pub mod poll;` (line 26):

```rust
pub mod poll;
pub mod stash;
pub mod types;
```

Add a re-export block after the `pub use poll::{...}` line (line 36):

```rust
pub use stash::{stash_apply, stash_drop, stash_list, stash_pop, stash_push};
```

Add `StashEntry` to the `pub use types::{...}` list (line 37):

```rust
pub use types::{
    GitError, LogSink, MergeOutcome, MergeRequest, MergeStatus, OpOutput, OrderedBranches,
    ProgressSink, RevertMode, RevertOutcome, RevertPoint, RevertStatus, StashEntry, StatusSummary,
    TargetMode,
};
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib git::stash`
Expected: PASS (compiles; no stash op unit tests — these are CLI shell-outs, covered like the rest of `ops.rs`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/git/stash.rs src-tauri/src/git/mod.rs
git commit -m "feat(git): add stash operations (list/push/apply/pop/drop)"
```

---

## Task 4: `git/branch.rs` operations

**Files:**
- Create: `src-tauri/src/git/branch.rs`
- Modify: `src-tauri/src/git/mod.rs`

- [ ] **Step 1: Create `src-tauri/src/git/branch.rs`**

```rust
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
```

- [ ] **Step 2: Declare + re-export in `mod.rs`**

In `src-tauri/src/git/mod.rs`, add `pub mod branch;` at the top of the module list (before `mod exec;`, line 23):

```rust
pub mod branch;
mod exec;
```

Add the re-export after the stash re-export (from Task 3):

```rust
pub use branch::{
    create_branch, delete_branch, delete_remote_branch, publish_branch, rename_branch,
};
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib git::branch`
Expected: PASS (compiles).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/git/branch.rs src-tauri/src/git/mod.rs
git commit -m "feat(git): add branch ops (create/delete/delete-remote/rename/publish)"
```

---

## Task 5: Tauri commands + registration

**Files:**
- Modify: `src-tauri/src/commands/git.rs` (import + 10 fns after line 191)
- Modify: `src-tauri/src/lib.rs` (handler list, after line 159)

- [ ] **Step 1: Extend the git import in `commands/git.rs`**

In `src-tauri/src/commands/git.rs`, update the `use crate::git::{...}` block (lines 19–22) to add `StashEntry`:

```rust
use crate::git::{
    self, MergeOutcome, MergeRequest, OpOutput, OrderedBranches, RevertOutcome, RevertPoint,
    StashEntry, StatusSummary, DEFAULT_BRANCH_RECENCY_LIMIT,
};
```

- [ ] **Step 2: Add the 10 commands**

At the end of `src-tauri/src/commands/git.rs` (after `git_refresh_badge`, line 191), append:

```rust
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
```

- [ ] **Step 3: Register the commands in `lib.rs`**

In `src-tauri/src/lib.rs`, in the `generate_handler!` macro, after `commands::git::git_refresh_badge,` (line 159) add:

```rust
            commands::git::git_refresh_badge,
            // §2.4 git — stash management
            commands::git::git_stash_list,
            commands::git::git_stash_push,
            commands::git::git_stash_apply,
            commands::git::git_stash_pop,
            commands::git::git_stash_drop,
            // §2.4 git — branch management
            commands::git::git_create_branch,
            commands::git::git_delete_branch,
            commands::git::git_delete_remote_branch,
            commands::git::git_rename_branch,
            commands::git::git_publish_branch,
```

- [ ] **Step 4: Verify the whole crate compiles + tests pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS (all existing tests + the stash parser tests). The earlier `run_logged_op` dead_code warning is gone (now used).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs
git commit -m "feat(git): register stash and branch IPC commands"
```

---

## Task 6: IPC contract — types, wrappers, specs, docs

**Files:**
- Modify: `src/app/core/ipc/tauri.types.ts` (after `OrderedBranches`, line 184)
- Modify: `src/app/core/ipc/commands.ts` (import, `CMD`, `git` wrappers)
- Modify: `src/app/core/ipc/commands.spec.ts` (count + payload tests)
- Modify: `docs/migration/ipc-contract.md` (§2.4 append)

- [ ] **Step 1: Add `StashEntry` to `tauri.types.ts`**

In `src/app/core/ipc/tauri.types.ts`, after the `OrderedBranches` interface (line 184), add:

```typescript
/** One `git stash list` entry (stash dialog). `index` addresses `stash@{index}`. */
export interface StashEntry {
  readonly index: number;
  readonly message: string;
  readonly branch: string;
}
```

- [ ] **Step 2: Add `CMD` entries + import in `commands.ts`**

In `src/app/core/ipc/commands.ts`, add `StashEntry` to the type import (line 30 area, keep alphabetical-ish with the others):

```typescript
  ServiceSnapshot,
  StashEntry,
  WorkspaceGroup,
```

In the `CMD` object, after `gitRefreshBadge: 'git_refresh_badge',` (line 71) add:

```typescript
  gitRefreshBadge: 'git_refresh_badge',
  // git stash
  gitStashList: 'git_stash_list',
  gitStashPush: 'git_stash_push',
  gitStashApply: 'git_stash_apply',
  gitStashPop: 'git_stash_pop',
  gitStashDrop: 'git_stash_drop',
  // git branch management
  gitCreateBranch: 'git_create_branch',
  gitDeleteBranch: 'git_delete_branch',
  gitDeleteRemoteBranch: 'git_delete_remote_branch',
  gitRenameBranch: 'git_rename_branch',
  gitPublishBranch: 'git_publish_branch',
```

- [ ] **Step 3: Add the typed wrappers**

In the `readonly git = { ... }` object, after `refreshBadge` (line 284), before the closing `};`, add:

```typescript
    refreshBadge: (repoPath: string): Promise<void> =>
      this.bridge.invoke<void>(CMD.gitRefreshBadge, { repoPath }),

    // -- stash management --
    stashList: (repoPath: string): Promise<StashEntry[]> =>
      this.bridge.invoke<StashEntry[]>(CMD.gitStashList, { repoPath }),

    /** `message: null` omits `-m`; untracked files are included when asked. */
    stashPush: (
      repoPath: string,
      message: string | null,
      includeUntracked: boolean,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStashPush, {
        repoPath,
        message,
        includeUntracked,
      }),

    /** Applies and KEEPS the entry. */
    stashApply: (repoPath: string, index: number): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStashApply, { repoPath, index }),

    /** Applies and DROPS the entry. */
    stashPop: (repoPath: string, index: number): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStashPop, { repoPath, index }),

    stashDrop: (repoPath: string, index: number): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitStashDrop, { repoPath, index }),

    // -- branch management --
    /** `base: null` branches off HEAD; `checkout` switches to the new branch. */
    createBranch: (
      repoPath: string,
      name: string,
      base: string | null,
      checkout: boolean,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitCreateBranch, {
        repoPath,
        name,
        base,
        checkout,
      }),

    /** `force` uses `-D` (skips the merged check). */
    deleteBranch: (
      repoPath: string,
      name: string,
      force: boolean,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitDeleteBranch, { repoPath, name, force }),

    deleteRemoteBranch: (repoPath: string, name: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitDeleteRemoteBranch, { repoPath, name }),

    /** `from: null` renames the current branch. */
    renameBranch: (
      repoPath: string,
      from: string | null,
      to: string,
    ): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitRenameBranch, { repoPath, from, to }),

    publishBranch: (repoPath: string, name: string): Promise<OpOutput> =>
      this.bridge.invoke<OpOutput>(CMD.gitPublishBranch, { repoPath, name }),
```

- [ ] **Step 4: Update the count assertion + add payload tests**

In `src/app/core/ipc/commands.spec.ts`, change the count test (lines 8–18):

```typescript
  it('contains the 71 contract commands, all snake_case and unique', () => {
    // 61 prior + 10 git stash/branch management commands (ipc-contract.md §2.4
    // #62–#71): stash list/push/apply/pop/drop + create/delete/delete-remote/
    // rename/publish branch.
    const names = Object.values(CMD);
    expect(names.length).toBe(71);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
```

After the existing `merge wrappers carry the request/revert payloads verbatim` test (line 70), add:

```typescript
  it('stash wrappers carry the payloads verbatim', async () => {
    const bridge = new FakeTauriBridge();
    const api = new IpcCommands(bridge);

    await api.git.stashList('/ws/api');
    await api.git.stashPush('/ws/api', 'pre-merge', true);
    await api.git.stashPush('/ws/api', null, false);
    await api.git.stashApply('/ws/api', 0);
    await api.git.stashPop('/ws/api', 1);
    await api.git.stashDrop('/ws/api', 2);

    expect(bridge.invokesOf(CMD.gitStashList)[0]?.args).toEqual({ repoPath: '/ws/api' });
    expect(bridge.invokesOf(CMD.gitStashPush)[0]?.args).toEqual({
      repoPath: '/ws/api',
      message: 'pre-merge',
      includeUntracked: true,
    });
    expect(bridge.invokesOf(CMD.gitStashPush)[1]?.args).toEqual({
      repoPath: '/ws/api',
      message: null,
      includeUntracked: false,
    });
    expect(bridge.invokesOf(CMD.gitStashApply)[0]?.args).toEqual({ repoPath: '/ws/api', index: 0 });
    expect(bridge.invokesOf(CMD.gitStashPop)[0]?.args).toEqual({ repoPath: '/ws/api', index: 1 });
    expect(bridge.invokesOf(CMD.gitStashDrop)[0]?.args).toEqual({ repoPath: '/ws/api', index: 2 });
  });

  it('branch-management wrappers carry the payloads verbatim', async () => {
    const bridge = new FakeTauriBridge();
    const api = new IpcCommands(bridge);

    await api.git.createBranch('/ws/api', 'feature/x', 'main', true);
    await api.git.deleteBranch('/ws/api', 'old', false);
    await api.git.deleteRemoteBranch('/ws/api', 'old');
    await api.git.renameBranch('/ws/api', null, 'renamed');
    await api.git.publishBranch('/ws/api', 'feature/x');

    expect(bridge.invokesOf(CMD.gitCreateBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      name: 'feature/x',
      base: 'main',
      checkout: true,
    });
    expect(bridge.invokesOf(CMD.gitDeleteBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      name: 'old',
      force: false,
    });
    expect(bridge.invokesOf(CMD.gitDeleteRemoteBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      name: 'old',
    });
    expect(bridge.invokesOf(CMD.gitRenameBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      from: null,
      to: 'renamed',
    });
    expect(bridge.invokesOf(CMD.gitPublishBranch)[0]?.args).toEqual({
      repoPath: '/ws/api',
      name: 'feature/x',
    });
  });
```

- [ ] **Step 5: Run the spec to verify it passes**

Run: `npm test -- commands.spec`
Expected: PASS (count = 71; all payload tests green).

- [ ] **Step 6: Document in `ipc-contract.md`**

In `docs/migration/ipc-contract.md`, in the §2.4 Git table, after the `git_refresh_badge`/`#22` row append (numbering is append-only — these continue after docker #61):

```markdown
| 62 | `git_stash_list` | `{ repoPath: string }` | `StashEntry[]` | `git::stash_list` — `git stash list` parsed (newest = index 0) |
| 63 | `git_stash_push` | `{ repoPath: string, message?: string, includeUntracked: boolean }` | `OpOutput` | `git::stash_push` — `git stash push [-u] [-m]` |
| 64 | `git_stash_apply` | `{ repoPath: string, index: number }` | `OpOutput` | `git::stash_apply` — applies, keeps the entry |
| 65 | `git_stash_pop` | `{ repoPath: string, index: number }` | `OpOutput` | `git::stash_pop` — applies + drops |
| 66 | `git_stash_drop` | `{ repoPath: string, index: number }` | `OpOutput` | `git::stash_drop` |
| 67 | `git_create_branch` | `{ repoPath: string, name: string, base?: string, checkout: boolean }` | `OpOutput` | `git::create_branch` — `checkout -b` / `branch` |
| 68 | `git_delete_branch` | `{ repoPath: string, name: string, force: boolean }` | `OpOutput` | `git::delete_branch` — `branch -d`/`-D` |
| 69 | `git_delete_remote_branch` | `{ repoPath: string, name: string }` | `OpOutput` | `git::delete_remote_branch` — `push origin --delete` |
| 70 | `git_rename_branch` | `{ repoPath: string, from?: string, to: string }` | `OpOutput` | `git::rename_branch` — `branch -m` |
| 71 | `git_publish_branch` | `{ repoPath: string, name: string }` | `OpOutput` | `git::publish_branch` — `push -u origin` |

> Add a `StashEntry` row to the §1.2 type list: `{ index: number, message: string, branch: string }` (camelCase wire).
```

- [ ] **Step 7: Commit**

```bash
git add src/app/core/ipc/tauri.types.ts src/app/core/ipc/commands.ts src/app/core/ipc/commands.spec.ts docs/migration/ipc-contract.md
git commit -m "feat(ipc): wire stash and branch-management commands"
```

---

## Task 7: Generic prompt dialog

**Files:**
- Create: `src/app/features/dialogs/prompt/prompt-dialog.component.ts`
- Modify: `src/app/features/dialogs/dialog.service.ts`

- [ ] **Step 1: Create the prompt dialog component**

Create `src/app/features/dialogs/prompt/prompt-dialog.component.ts`:

```typescript
/**
 * Generic single-line text prompt — the v2 replacement for a `simpledialog`
 * ask-string. Resolves the entered text on OK, or `null` on Cancel/ESC/✕
 * (the registered fallback). Used by the branch dialog for rename.
 */
import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { ButtonComponent, DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';

@Component({
  selector: 'app-prompt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  template: `
    <ui-dialog-shell
      [dialogTitle]="title()"
      width="420px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      <div class="prompt">
        <p class="prompt__message">{{ message() }}</p>
        <input
          #field
          class="prompt__input"
          type="text"
          [value]="value()"
          [placeholder]="placeholder()"
          (input)="value.set(field.value)"
          (keydown.enter)="confirm()"
        />
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">
          {{ 'btn.cancel' | t }}
        </ui-button>
        <ui-button variant="blue" [disabled]="value().trim() === ''" (clicked)="confirm()">
          {{ 'btn.accept' | t }}
        </ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class PromptDialogComponent extends DialogBase {
  readonly title = input('');
  readonly message = input('');
  readonly placeholder = input('');
  readonly initialValue = input('');

  protected readonly value = signal('');

  constructor() {
    super();
    queueMicrotask(() => this.value.set(this.initialValue()));
  }

  protected confirm(): void {
    const text = this.value().trim();
    if (text === '') {
      return;
    }
    this.closeSelf(text);
  }
}
```

- [ ] **Step 2: Add `prompt()` to `DialogService`**

In `src/app/features/dialogs/dialog.service.ts`, add the import after the `MessageboxComponent` import (line 36):

```typescript
import { PromptDialogComponent } from './prompt/prompt-dialog.component';
```

After the `confirm()` method (line 187), add:

```typescript
  /**
   * Single-line text prompt. Resolves the entered (trimmed) text, or `null`
   * when cancelled (ESC / ✕ / Cancel — the fallback).
   */
  prompt(
    title: string,
    message: string,
    opts: { initialValue?: string; placeholder?: string } = {},
  ): Promise<string | null> {
    return this.openForResult<string | null>(
      PromptDialogComponent,
      {
        title,
        message,
        initialValue: opts.initialValue ?? '',
        placeholder: opts.placeholder ?? '',
      },
      null,
    );
  }
```

- [ ] **Step 3: Verify no ESM cycle + build-free typecheck via tests**

Run: `npx madge --circular --extensions ts src/app`
Expected: no new circular dependency reported.

Run: `npm test -- commands.spec`
Expected: PASS (sanity — confirms the workspace still compiles for vitest).

- [ ] **Step 4: Commit**

```bash
git add src/app/features/dialogs/prompt/prompt-dialog.component.ts src/app/features/dialogs/dialog.service.ts
git commit -m "feat(dialogs): add generic prompt dialog"
```

---

## Task 8: Stash dialog logic

**Files:**
- Create: `src/app/features/dialogs/stash/stash.logic.ts`
- Create: `src/app/features/dialogs/stash/stash.logic.spec.ts`

- [ ] **Step 1: Write the failing spec**

Create `src/app/features/dialogs/stash/stash.logic.spec.ts`:

```typescript
/** TestBed-free specs (vitest-style). */
import { describe, expect, it } from 'vitest';

import type { StashEntry } from '../../../core/ipc/tauri.types';
import { stashEntryLabel } from './stash.logic';

const entry = (extra?: Partial<StashEntry>): StashEntry => ({
  index: 0,
  branch: 'main',
  message: 'WIP',
  ...extra,
});

describe('stashEntryLabel', () => {
  it('renders index, branch and message', () => {
    expect(stashEntryLabel(entry({ index: 2, branch: 'develop', message: 'nightly' }))).toBe(
      'stash@{2} · develop — nightly',
    );
  });

  it('omits the branch separator when the branch is empty', () => {
    expect(stashEntryLabel(entry({ index: 0, branch: '', message: 'detached work' }))).toBe(
      'stash@{0} — detached work',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- stash.logic`
Expected: FAIL — cannot resolve `./stash.logic`.

- [ ] **Step 3: Implement `stash.logic.ts`**

Create `src/app/features/dialogs/stash/stash.logic.ts`:

```typescript
/** Pure stash-dialog helpers (label rendering). */
import type { StashEntry } from '../../../core/ipc/tauri.types';

/** Human row label: `stash@{N} · <branch> — <message>` (branch part dropped
 * when empty, e.g. a stash made off a detached HEAD). */
export function stashEntryLabel(entry: StashEntry): string {
  const ref = `stash@{${entry.index}}`;
  const head = entry.branch ? `${ref} · ${entry.branch}` : ref;
  return `${head} — ${entry.message}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- stash.logic`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/dialogs/stash/stash.logic.ts src/app/features/dialogs/stash/stash.logic.spec.ts
git commit -m "feat(stash): add stash dialog label logic"
```

---

## Task 9: Stash dialog component + service + i18n

**Files:**
- Create: `src/app/features/dialogs/stash/stash-dialog.component.ts`
- Modify: `src/app/features/dialogs/dialog.service.ts`
- Modify: `src/assets/i18n/en.json`, `src/assets/i18n/es.json`

- [ ] **Step 1: Add i18n keys**

In `src/assets/i18n/en.json`, add a `stash` block inside the `dialog` object (alongside `merge`):

```json
    "stash": {
      "title": "Stash — {name}",
      "add_section": "Add to stash",
      "name_placeholder": "optional name",
      "include_untracked": "Include untracked files",
      "btn_add": "Add to stash",
      "btn_adding": "Stashing...",
      "entries_section": "Stashes",
      "empty": "No stashes.",
      "btn_apply": "Apply",
      "btn_pop": "Pop",
      "btn_drop": "Drop",
      "drop_confirm_title": "Drop stash",
      "drop_confirm_msg": "This permanently discards {ref}. Continue?",
      "done_added": "✓ Changes stashed.",
      "done_applied": "✓ Stash applied.",
      "done_popped": "✓ Stash popped.",
      "done_dropped": "✓ Stash dropped.",
      "failed": "✗ {msg}",
      "log_label": "📋 Progress"
    },
    "prompt": {
      "rename_title": "Rename branch",
      "rename_msg": "New name for \"{name}\":"
    },
```

In `src/assets/i18n/es.json`, add the SAME keys translated:

```json
    "stash": {
      "title": "Stash — {name}",
      "add_section": "Añadir al stash",
      "name_placeholder": "nombre opcional",
      "include_untracked": "Incluir ficheros sin seguimiento",
      "btn_add": "Añadir al stash",
      "btn_adding": "Guardando...",
      "entries_section": "Stashes",
      "empty": "No hay stashes.",
      "btn_apply": "Aplicar",
      "btn_pop": "Pop",
      "btn_drop": "Eliminar",
      "drop_confirm_title": "Eliminar stash",
      "drop_confirm_msg": "Esto descarta {ref} de forma permanente. ¿Continuar?",
      "done_added": "✓ Cambios guardados en el stash.",
      "done_applied": "✓ Stash aplicado.",
      "done_popped": "✓ Stash recuperado (pop).",
      "done_dropped": "✓ Stash eliminado.",
      "failed": "✗ {msg}",
      "log_label": "📋 Progreso"
    },
    "prompt": {
      "rename_title": "Renombrar rama",
      "rename_msg": "Nuevo nombre para \"{name}\":"
    },
```

- [ ] **Step 2: Create the stash dialog component**

Create `src/app/features/dialogs/stash/stash-dialog.component.ts`:

```typescript
/**
 * Stash-management dialog — add (with optional name + untracked), list, and
 * per-entry Apply / Pop / Drop. Mutations refresh the git badge and re-list;
 * progress streams via `service://log-line` (`stream: "git"`).
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { OpOutput, StashEntry } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ButtonComponent, DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';
import { stashEntryLabel } from './stash.logic';

@Component({
  selector: 'app-stash-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, TPipe],
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.stash.title' | t: { name: repoName() }"
      width="560px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      <div class="stash">
        <section class="stash__section">
          <h3 class="stash__section-title">{{ 'dialog.stash.add_section' | t }}</h3>
          <div class="stash__row">
            <input
              #nameInput
              class="stash__input"
              type="text"
              [placeholder]="'dialog.stash.name_placeholder' | t"
              [value]="name()"
              [disabled]="busy()"
              (input)="name.set(nameInput.value)"
            />
            <label class="stash__check">
              <input
                type="checkbox"
                [checked]="includeUntracked()"
                [disabled]="busy()"
                (change)="includeUntracked.set(!includeUntracked())"
              />
              {{ 'dialog.stash.include_untracked' | t }}
            </label>
            <ui-button variant="blue" [loading]="busy()" (clicked)="add()">
              {{ (busy() ? 'dialog.stash.btn_adding' : 'dialog.stash.btn_add') | t }}
            </ui-button>
          </div>
        </section>

        <section class="stash__section">
          <h3 class="stash__section-title">{{ 'dialog.stash.entries_section' | t }}</h3>
          @if (entries().length === 0) {
            <p class="stash__empty">{{ 'dialog.stash.empty' | t }}</p>
          } @else {
            @for (entry of entries(); track entry.index) {
              <div class="stash__entry">
                <span class="stash__entry-label">{{ label(entry) }}</span>
                <ui-button size="sm" variant="success" [disabled]="busy()" (clicked)="apply(entry)">
                  {{ 'dialog.stash.btn_apply' | t }}
                </ui-button>
                <ui-button size="sm" variant="blue" [disabled]="busy()" (clicked)="pop(entry)">
                  {{ 'dialog.stash.btn_pop' | t }}
                </ui-button>
                <ui-button size="sm" variant="danger-deep" [disabled]="busy()" (clicked)="drop(entry)">
                  {{ 'dialog.stash.btn_drop' | t }}
                </ui-button>
              </div>
            }
          }
        </section>

        <p class="stash__log-label">{{ 'dialog.stash.log_label' | t }}</p>
        <pre class="stash__log">{{ logText() }}</pre>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">{{ 'btn.close' | t }}</ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class StashDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly i18n = inject(TranslationService);

  protected readonly name = signal('');
  protected readonly includeUntracked = signal(true); // default ON (design)
  protected readonly entries = signal<readonly StashEntry[]>([]);
  protected readonly busy = signal(false);
  private readonly logLines = signal<readonly string[]>([]);

  protected readonly logText = computed(() => this.logLines().join('\n'));

  constructor() {
    super();
    void this.reload();
  }

  protected label(entry: StashEntry): string {
    return stashEntryLabel(entry);
  }

  protected async add(): Promise<void> {
    const message = this.name().trim() || null;
    await this.run(
      () => this.commands.git.stashPush(this.repoPath(), message, this.includeUntracked()),
      'dialog.stash.done_added',
    );
    this.name.set('');
  }

  protected async apply(entry: StashEntry): Promise<void> {
    await this.run(
      () => this.commands.git.stashApply(this.repoPath(), entry.index),
      'dialog.stash.done_applied',
    );
  }

  protected async pop(entry: StashEntry): Promise<void> {
    await this.run(
      () => this.commands.git.stashPop(this.repoPath(), entry.index),
      'dialog.stash.done_popped',
    );
  }

  protected async drop(entry: StashEntry): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.stash.drop_confirm_title'),
      this.i18n.t('dialog.stash.drop_confirm_msg', { ref: `stash@{${entry.index}}` }),
    );
    if (!confirmed) {
      return;
    }
    await this.run(
      () => this.commands.git.stashDrop(this.repoPath(), entry.index),
      'dialog.stash.done_dropped',
    );
  }

  /** Run a mutation, log its outcome, refresh the badge, and re-list. */
  private async run(op: () => Promise<OpOutput>, okKey: string): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      const result = await op();
      this.appendLog(
        result.ok
          ? this.i18n.t(okKey)
          : this.i18n.t('dialog.stash.failed', { msg: result.message }),
      );
      void this.repos.refreshBadge(this.repoPath());
      await this.reload();
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.stash.failed', { msg: describe(err) }));
    } finally {
      this.busy.set(false);
    }
  }

  private async reload(): Promise<void> {
    const list = await this.commands.git.stashList(this.repoPath()).catch(() => [] as StashEntry[]);
    this.entries.set(list);
  }

  private repoPath(): string {
    return this.repos.repoByName(this.repoName())?.path ?? '';
  }

  private appendLog(line: string): void {
    this.logLines.update((lines) => [...lines, line]);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
```

- [ ] **Step 3: Wire `openStash` in `DialogService`**

In `src/app/features/dialogs/dialog.service.ts`, add the import after the merge import (line 32):

```typescript
import { StashDialogComponent } from './stash/stash-dialog.component';
```

After `openMergeBranch` (line 116), add:

```typescript
  /** Stash-management dialog (add/list/apply/pop/drop). */
  openStash(repoName: string): void {
    this.open(StashDialogComponent, { repoName });
  }
```

- [ ] **Step 4: Verify**

Run: `npx madge --circular --extensions ts src/app` → no new cycle.
Run: `npm test -- stash.logic` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/dialogs/stash/stash-dialog.component.ts src/app/features/dialogs/dialog.service.ts src/assets/i18n/en.json src/assets/i18n/es.json
git commit -m "feat(stash): add stash dialog and openStash"
```

---

## Task 10: Branch dialog logic

**Files:**
- Create: `src/app/features/dialogs/branch/branch.logic.ts`
- Create: `src/app/features/dialogs/branch/branch.logic.spec.ts`

- [ ] **Step 1: Write the failing spec**

Create `src/app/features/dialogs/branch/branch.logic.spec.ts`:

```typescript
/** TestBed-free specs (vitest-style). */
import { describe, expect, it } from 'vitest';

import { validateBranchName } from './branch.logic';

describe('validateBranchName (git check-ref-format subset)', () => {
  it('accepts a normal branch name', () => {
    expect(validateBranchName('feature/login')).toBeNull();
    expect(validateBranchName('release-1.2')).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(validateBranchName('   ')).toBe('dialog.branch.error_empty');
  });

  it('rejects names with spaces or forbidden characters', () => {
    for (const bad of ['has space', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a..b']) {
      expect(validateBranchName(bad)).toBe('dialog.branch.error_invalid');
    }
  });

  it('rejects edge placements (leading -, trailing / or .lock, trailing dot)', () => {
    for (const bad of ['-lead', 'trail/', 'feature.lock', 'ends.']) {
      expect(validateBranchName(bad)).toBe('dialog.branch.error_invalid');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- branch.logic`
Expected: FAIL — cannot resolve `./branch.logic`.

- [ ] **Step 3: Implement `branch.logic.ts`**

Create `src/app/features/dialogs/branch/branch.logic.ts`:

```typescript
/** Pure branch-dialog logic: name validation (a git check-ref-format subset). */

/** Characters git forbids in a ref name component. */
const FORBIDDEN = /[ ~^:?*[\\ -]/;

/**
 * Validate a proposed branch name. Returns the i18n key of the first problem,
 * or `null` when acceptable. Covers the common `git check-ref-format` rules:
 * non-empty; no spaces / `~^:?*[` / backslash / control chars; no `..`; no
 * leading `-`; no trailing `/`, `.` or `.lock`.
 */
export function validateBranchName(name: string): string | null {
  const value = name.trim();
  if (value === '') {
    return 'dialog.branch.error_empty';
  }
  if (
    FORBIDDEN.test(value) ||
    value.includes('..') ||
    value.startsWith('-') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    return 'dialog.branch.error_invalid';
  }
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- branch.logic`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/dialogs/branch/branch.logic.ts src/app/features/dialogs/branch/branch.logic.spec.ts
git commit -m "feat(branch): add branch-name validation logic"
```

---

## Task 11: Branch dialog component + service + i18n

**Files:**
- Create: `src/app/features/dialogs/branch/branch-dialog.component.ts`
- Modify: `src/app/features/dialogs/dialog.service.ts`
- Modify: `src/assets/i18n/en.json`, `src/assets/i18n/es.json`

- [ ] **Step 1: Add i18n keys**

In `src/assets/i18n/en.json`, add a `branch` block inside `dialog` (alongside `stash`):

```json
    "branch": {
      "title": "Branches — {name}",
      "create_section": "Create branch",
      "name_placeholder": "new branch name",
      "base_label": "Base:",
      "checkout_after": "Switch to it after creating",
      "btn_create": "Create",
      "list_section": "Branches",
      "current_tag": "current",
      "btn_checkout": "Checkout",
      "btn_rename": "Rename",
      "btn_publish": "Publish",
      "btn_delete_local": "Delete",
      "btn_delete_remote": "Delete remote",
      "delete_confirm_title": "Delete branch",
      "delete_confirm_msg": "Delete local branch \"{name}\"?",
      "delete_force_title": "Branch not fully merged",
      "delete_force_msg": "\"{name}\" is not fully merged. Force-delete it (-D)? Unmerged commits will be lost.",
      "delete_remote_confirm_title": "Delete remote branch",
      "delete_remote_confirm_msg": "Delete \"{name}\" on origin? This affects the remote for everyone.",
      "error_empty": "Enter a branch name.",
      "error_invalid": "Invalid branch name.",
      "done_created": "✓ Branch created.",
      "done_renamed": "✓ Branch renamed.",
      "done_published": "✓ Branch published.",
      "done_deleted": "✓ Branch deleted.",
      "failed": "✗ {msg}",
      "log_label": "📋 Progress"
    },
```

In `src/assets/i18n/es.json`, the SAME keys translated:

```json
    "branch": {
      "title": "Ramas — {name}",
      "create_section": "Crear rama",
      "name_placeholder": "nombre de la rama nueva",
      "base_label": "Base:",
      "checkout_after": "Cambiar a ella tras crearla",
      "btn_create": "Crear",
      "list_section": "Ramas",
      "current_tag": "actual",
      "btn_checkout": "Checkout",
      "btn_rename": "Renombrar",
      "btn_publish": "Publicar",
      "btn_delete_local": "Borrar",
      "btn_delete_remote": "Borrar remota",
      "delete_confirm_title": "Borrar rama",
      "delete_confirm_msg": "¿Borrar la rama local \"{name}\"?",
      "delete_force_title": "Rama no mergeada",
      "delete_force_msg": "\"{name}\" no está totalmente mergeada. ¿Forzar el borrado (-D)? Se perderán los commits no mergeados.",
      "delete_remote_confirm_title": "Borrar rama remota",
      "delete_remote_confirm_msg": "¿Borrar \"{name}\" en origin? Esto afecta al remoto para todos.",
      "error_empty": "Escribí el nombre de la rama.",
      "error_invalid": "Nombre de rama inválido.",
      "done_created": "✓ Rama creada.",
      "done_renamed": "✓ Rama renombrada.",
      "done_published": "✓ Rama publicada.",
      "done_deleted": "✓ Rama borrada.",
      "failed": "✗ {msg}",
      "log_label": "📋 Progreso"
    },
```

- [ ] **Step 2: Create the branch dialog component**

Create `src/app/features/dialogs/branch/branch-dialog.component.ts`:

```typescript
/**
 * Branch-management dialog — create (off a base, optional checkout), and per
 * branch checkout / rename (prompt) / publish / delete-local (force fallback
 * when not merged) / delete-remote (confirmed). Mutations refresh the badge
 * and re-list; progress streams via `service://log-line` (`stream: "git"`).
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import type { OpOutput } from '../../../core/ipc/tauri.types';
import { ReposStore } from '../../../core/state/repos.store';
import { ButtonComponent, DialogShellComponent, SearchableSelectComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';
import { validateBranchName } from './branch.logic';

@Component({
  selector: 'app-branch-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, DialogShellComponent, SearchableSelectComponent, TPipe],
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.branch.title' | t: { name: repoName() }"
      width="600px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      <div class="branch">
        <section class="branch__section">
          <h3 class="branch__section-title">{{ 'dialog.branch.create_section' | t }}</h3>
          <div class="branch__row">
            <input
              #nameInput
              class="branch__input"
              type="text"
              [placeholder]="'dialog.branch.name_placeholder' | t"
              [value]="newName()"
              [disabled]="busy()"
              (input)="newName.set(nameInput.value)"
            />
            <span class="branch__sublabel">{{ 'dialog.branch.base_label' | t }}</span>
            <ui-searchable-select
              class="branch__combo"
              [options]="branches()"
              [recentCount]="recentCount()"
              [value]="base()"
              [disabled]="busy()"
              [searchPlaceholder]="'placeholder.search' | t"
              [noResultsText]="'placeholder.no_results' | t"
              (selectionChange)="base.set($event)"
            />
            <label class="branch__check">
              <input
                type="checkbox"
                [checked]="checkoutAfter()"
                [disabled]="busy()"
                (change)="checkoutAfter.set(!checkoutAfter())"
              />
              {{ 'dialog.branch.checkout_after' | t }}
            </label>
            <ui-button variant="blue" [loading]="busy()" (clicked)="create()">
              {{ 'dialog.branch.btn_create' | t }}
            </ui-button>
          </div>
          @if (createError()) {
            <p class="branch__error">{{ createError() }}</p>
          }
        </section>

        <section class="branch__section">
          <h3 class="branch__section-title">{{ 'dialog.branch.list_section' | t }}</h3>
          @for (b of branches(); track b) {
            <div class="branch__entry">
              <span class="branch__entry-label">
                {{ b }}
                @if (b === current()) {
                  <span class="branch__current">({{ 'dialog.branch.current_tag' | t }})</span>
                }
              </span>
              <ui-button size="sm" variant="success" [disabled]="busy() || b === current()" (clicked)="checkout(b)">
                {{ 'dialog.branch.btn_checkout' | t }}
              </ui-button>
              <ui-button size="sm" variant="neutral" [disabled]="busy()" (clicked)="rename(b)">
                {{ 'dialog.branch.btn_rename' | t }}
              </ui-button>
              <ui-button size="sm" variant="blue" [disabled]="busy()" (clicked)="publish(b)">
                {{ 'dialog.branch.btn_publish' | t }}
              </ui-button>
              <ui-button size="sm" variant="purple" [disabled]="busy()" (clicked)="deleteRemote(b)">
                {{ 'dialog.branch.btn_delete_remote' | t }}
              </ui-button>
              <ui-button size="sm" variant="danger-deep" [disabled]="busy() || b === current()" (clicked)="deleteLocal(b)">
                {{ 'dialog.branch.btn_delete_local' | t }}
              </ui-button>
            </div>
          }
        </section>

        <p class="branch__log-label">{{ 'dialog.branch.log_label' | t }}</p>
        <pre class="branch__log">{{ logText() }}</pre>
      </div>

      <div uiDialogFooter>
        <ui-button variant="neutral" (clicked)="closeSelf()">{{ 'btn.close' | t }}</ui-button>
      </div>
    </ui-dialog-shell>
  `,
})
export class BranchDialogComponent extends DialogBase {
  readonly repoName = input.required<string>();

  private readonly commands = inject(IpcCommands);
  private readonly repos = inject(ReposStore);
  private readonly i18n = inject(TranslationService);

  protected readonly branches = signal<readonly string[]>([]);
  protected readonly recentCount = signal(0);
  protected readonly current = signal('');
  protected readonly newName = signal('');
  protected readonly base = signal('');
  protected readonly checkoutAfter = signal(true);
  protected readonly busy = signal(false);
  protected readonly createError = signal('');
  private readonly logLines = signal<readonly string[]>([]);

  protected readonly logText = computed(() => this.logLines().join('\n'));

  constructor() {
    super();
    void this.reload();
  }

  protected async create(): Promise<void> {
    const errorKey = validateBranchName(this.newName());
    if (errorKey) {
      this.createError.set(this.i18n.t(errorKey));
      return;
    }
    this.createError.set('');
    const name = this.newName().trim();
    const base = this.base().trim() || null;
    await this.run(
      () => this.commands.git.createBranch(this.repoPath(), name, base, this.checkoutAfter()),
      'dialog.branch.done_created',
    );
    this.newName.set('');
  }

  protected async checkout(branch: string): Promise<void> {
    await this.run(
      () => this.commands.git.checkout(this.repoPath(), branch),
      'dialog.branch.done_created', // checkout reuses OpOutput; generic ✓ below
      true,
    );
  }

  protected async rename(branch: string): Promise<void> {
    const next = await this.dialogs.prompt(
      this.i18n.t('dialog.prompt.rename_title'),
      this.i18n.t('dialog.prompt.rename_msg', { name: branch }),
      { initialValue: branch },
    );
    if (next === null) {
      return;
    }
    const errorKey = validateBranchName(next);
    if (errorKey) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: this.i18n.t(errorKey) }));
      return;
    }
    await this.run(
      () => this.commands.git.renameBranch(this.repoPath(), branch, next.trim()),
      'dialog.branch.done_renamed',
    );
  }

  protected async publish(branch: string): Promise<void> {
    await this.run(
      () => this.commands.git.publishBranch(this.repoPath(), branch),
      'dialog.branch.done_published',
    );
  }

  protected async deleteRemote(branch: string): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_remote_confirm_title'),
      this.i18n.t('dialog.branch.delete_remote_confirm_msg', { name: branch }),
    );
    if (!confirmed) {
      return;
    }
    await this.run(
      () => this.commands.git.deleteRemoteBranch(this.repoPath(), branch),
      'dialog.branch.done_deleted',
    );
  }

  protected async deleteLocal(branch: string): Promise<void> {
    const confirmed = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_confirm_title'),
      this.i18n.t('dialog.branch.delete_confirm_msg', { name: branch }),
    );
    if (!confirmed) {
      return;
    }
    const result = await this.runRaw(() =>
      this.commands.git.deleteBranch(this.repoPath(), branch, false),
    );
    if (result?.ok) {
      this.appendLog(this.i18n.t('dialog.branch.done_deleted'));
      await this.afterMutation();
      return;
    }
    // Not fully merged → offer the forced -D path.
    const force = await this.dialogs.confirm(
      this.i18n.t('dialog.branch.delete_force_title'),
      this.i18n.t('dialog.branch.delete_force_msg', { name: branch }),
    );
    if (!force) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: result?.message ?? '' }));
      return;
    }
    await this.run(
      () => this.commands.git.deleteBranch(this.repoPath(), branch, true),
      'dialog.branch.done_deleted',
    );
  }

  /** Run a mutation, log its outcome, refresh the badge, and re-list. */
  private async run(
    op: () => Promise<OpOutput>,
    okKey: string,
    _checkout = false,
  ): Promise<void> {
    const result = await this.runRaw(op);
    if (result === null) {
      return;
    }
    this.appendLog(
      result.ok
        ? this.i18n.t(okKey)
        : this.i18n.t('dialog.branch.failed', { msg: result.message }),
    );
    await this.afterMutation();
  }

  /** Execute a mutation with the busy guard; returns the OpOutput or null. */
  private async runRaw(op: () => Promise<OpOutput>): Promise<OpOutput | null> {
    if (this.busy()) {
      return null;
    }
    this.busy.set(true);
    try {
      return await op();
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.branch.failed', { msg: describe(err) }));
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  private async afterMutation(): Promise<void> {
    void this.repos.refreshBadge(this.repoPath());
    await this.reload();
  }

  private async reload(): Promise<void> {
    const repoPath = this.repoPath();
    const [ordered, current] = await Promise.all([
      this.commands.git.branches(repoPath).catch(() => ({ branches: [], recentCount: 0 })),
      this.commands.git.currentBranch(repoPath).catch(() => ''),
    ]);
    this.branches.set(ordered.branches);
    this.recentCount.set(ordered.recentCount);
    this.current.set(current);
    if (this.base() === '') {
      this.base.set(current);
    }
  }

  private repoPath(): string {
    return this.repos.repoByName(this.repoName())?.path ?? '';
  }

  private appendLog(line: string): void {
    this.logLines.update((lines) => [...lines, line]);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
```

> Note: `checkout` reuses the existing `git.checkout` wrapper and logs the generic created/✓ line via the shared `run`; its `okKey` is cosmetic. If a distinct "switched" message is wanted later, add `dialog.branch.done_checked_out` — not needed for this scope.

- [ ] **Step 3: Wire `openBranches` in `DialogService`**

In `src/app/features/dialogs/dialog.service.ts`, add the import after the branch-related imports (near line 22, keep alphabetical with the clone/config imports):

```typescript
import { BranchDialogComponent } from './branch/branch-dialog.component';
```

After `openStash` (added in Task 9), add:

```typescript
  /** Branch-management dialog (create/checkout/rename/publish/delete). */
  openBranches(repoName: string): void {
    this.open(BranchDialogComponent, { repoName });
  }
```

- [ ] **Step 4: Verify**

Run: `npx madge --circular --extensions ts src/app` → no new cycle.
Run: `npm test -- branch.logic` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/dialogs/branch/branch-dialog.component.ts src/app/features/dialogs/dialog.service.ts src/assets/i18n/en.json src/assets/i18n/es.json
git commit -m "feat(branch): add branch-management dialog and openBranches"
```

---

## Task 12: Repo-card wiring (Stash + Branches buttons)

**Files:**
- Modify: `src/app/features/workspace/repo-card/card-expand.component.ts`
- Modify: `src/app/features/workspace/repo-card/repo-card.component.ts`
- Modify: `src/assets/i18n/en.json`, `src/assets/i18n/es.json`

- [ ] **Step 1: Add i18n button + tooltip keys**

In `src/assets/i18n/en.json`, in the `btn` object add (near `merge`/`clean`):

```json
    "stash": "📦 Stash",
    "branches": "⎇ Branches",
```

In the `tooltip` object add (near `merge_btn`):

```json
    "stash_btn": "Manage the stash: add, apply, pop or drop changes",
    "branches_btn": "Manage branches: create, rename, publish or delete",
```

In `src/assets/i18n/es.json`, `btn`:

```json
    "stash": "📦 Stash",
    "branches": "⎇ Ramas",
```

`tooltip`:

```json
    "stash_btn": "Gestionar el stash: añadir, aplicar, pop o eliminar cambios",
    "branches_btn": "Gestionar ramas: crear, renombrar, publicar o borrar",
```

- [ ] **Step 2: Add fields + outputs to `card-expand.component.ts`**

In `CardExpandText` (after `cleanTip`, line 98), add:

```typescript
  readonly cleanText: string;
  readonly cleanTip: string;
  readonly stashText: string;
  readonly stashTip: string;
  readonly branchesText: string;
  readonly branchesTip: string;
```

In the template, after the Clean button (line 157–159), add two buttons:

```html
      <ui-button variant="purple" [uiTooltip]="text().cleanTip" (clicked)="clean.emit()">
        {{ text().cleanText }}
      </ui-button>
      <ui-button variant="purple-alt" [uiTooltip]="text().stashTip" (clicked)="stash.emit()">
        {{ text().stashText }}
      </ui-button>
      <ui-button variant="purple-alt" [uiTooltip]="text().branchesTip" (clicked)="branches.emit()">
        {{ text().branchesText }}
      </ui-button>
```

In the outputs block (after `readonly clean = output<void>();`, line 289), add:

```typescript
  readonly clean = output<void>();
  readonly stash = output<void>();
  readonly branches = output<void>();
```

- [ ] **Step 3: Wire the container template + handlers + text**

In `src/app/features/workspace/repo-card/repo-card.component.ts`, in the `<app-card-expand>` bindings (after `(clean)="onClean()"`, line 114), add:

```html
            (clean)="onClean()"
            (stash)="onStash()"
            (branches)="onBranches()"
```

In the `expandText` computed (after `cleanTip`, line 285), add:

```typescript
    cleanText: this.i18n.t('btn.clean'),
    cleanTip: this.i18n.t('tooltip.clean_btn'),
    stashText: this.i18n.t('btn.stash'),
    stashTip: this.i18n.t('tooltip.stash_btn'),
    branchesText: this.i18n.t('btn.branches'),
    branchesTip: this.i18n.t('tooltip.branches_btn'),
```

After `onClean()` (line 561), add the handlers:

```typescript
  protected onStash(): void {
    this.dialogs.openStash(this.repo().name);
  }

  protected onBranches(): void {
    this.dialogs.openBranches(this.repo().name);
  }
```

- [ ] **Step 4: Verify**

Run: `npm test -- commands.spec stash.logic branch.logic`
Expected: PASS (sanity compile + logic).
Run: `npx madge --circular --extensions ts src/app` → no new cycle.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/workspace/repo-card/card-expand.component.ts src/app/features/workspace/repo-card/repo-card.component.ts src/assets/i18n/en.json src/assets/i18n/es.json
git commit -m "feat(workspace): add Stash and Branches buttons to repo card"
```

---

## Task 13: Stash-and-retry in the merge dialog

**Files:**
- Modify: `src/app/features/dialogs/merge-branch/merge-branch-dialog.component.ts`
- Modify: `src/assets/i18n/en.json`, `src/assets/i18n/es.json`

- [ ] **Step 1: Add i18n keys**

In `src/assets/i18n/en.json`, inside the existing `dialog.merge` block, add:

```json
    "stash_name_placeholder": "optional stash name",
    "stash_and_retry": "Stash changes & retry",
    "stashing": "📦 Stashing local changes...",
    "stashed": "✓ Changes stashed — retrying the merge.",
    "stash_failed": "✗ Could not stash: {msg}",
```

In `src/assets/i18n/es.json`, inside `dialog.merge`:

```json
    "stash_name_placeholder": "nombre del stash (opcional)",
    "stash_and_retry": "Stashear cambios y reintentar",
    "stashing": "📦 Guardando cambios locales en el stash...",
    "stashed": "✓ Cambios guardados — reintentando el merge.",
    "stash_failed": "✗ No se pudo stashear: {msg}",
```

- [ ] **Step 2: Add the stash-name signal + handler**

In `src/app/features/dialogs/merge-branch/merge-branch-dialog.component.ts`, after the `extraLog` signal (line 301), add:

```typescript
  /** Optional name for the stash created from the blocked-dirty retry path. */
  protected readonly stashName = signal('');
```

After the `runMerge` method (line 447), add:

```typescript
  /**
   * Blocked-dirty escape hatch: stash the uncommitted changes (optional name,
   * untracked included) and re-run the merge. The stash is LEFT for manual
   * recovery from the Stash dialog (design decision — no auto-pop).
   */
  protected async stashAndRetry(): Promise<void> {
    if (this.merging()) {
      return;
    }
    const repoPath = this.repoPath();
    this.appendLog(this.i18n.t('dialog.merge.stashing'));
    try {
      const result = await this.commands.git.stashPush(
        repoPath,
        this.stashName().trim() || null,
        true,
      );
      if (!result.ok) {
        this.appendLog(this.i18n.t('dialog.merge.stash_failed', { msg: result.message }));
        return;
      }
      this.appendLog(this.i18n.t('dialog.merge.stashed'));
      void this.repos.refreshBadge(repoPath);
      this.stashName.set('');
      await this.runMerge();
    } catch (err: unknown) {
      this.appendLog(this.i18n.t('dialog.merge.stash_failed', { msg: describe(err) }));
    }
  }
```

- [ ] **Step 3: Show the stash control under a blocked_dirty outcome**

In the template, inside the outcome banner block, after the `@if (view.files.length > 0) { ... }` list (line 217), and before the banner's closing `</div>` (line 218), add:

```html
            @if (view.tone === 'blocked') {
              <div class="merge__stash-retry">
                <input
                  #stashNameInput
                  class="merge__input"
                  type="text"
                  [placeholder]="'dialog.merge.stash_name_placeholder' | t"
                  [value]="stashName()"
                  [disabled]="merging()"
                  (input)="stashName.set(stashNameInput.value)"
                />
                <ui-button variant="blue" [loading]="merging()" (clicked)="stashAndRetry()">
                  {{ 'dialog.merge.stash_and_retry' | t }}
                </ui-button>
              </div>
            }
```

- [ ] **Step 4: Verify**

Run: `npm test -- commands.spec`
Expected: PASS (workspace still compiles for vitest; `stashPush` wrapper exists from Task 6).
Run: `npx madge --circular --extensions ts src/app` → no new cycle.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/dialogs/merge-branch/merge-branch-dialog.component.ts src/assets/i18n/en.json src/assets/i18n/es.json
git commit -m "feat(merge): offer stash-and-retry when a merge is blocked by dirty tree"
```

---

## Final verification

- [ ] **Rust**: `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all green (incl. `stash_list` parser tests).
- [ ] **Frontend**: `npm test` → all specs green (count = 71; stash/branch logic + payload tests).
- [ ] **No cycles**: `npx madge --circular --extensions ts src/app` → clean.
- [ ] **i18n parity**: `en.json` and `es.json` have identical key trees (eyeball the new `dialog.stash`, `dialog.branch`, `dialog.prompt`, `dialog.merge.stash_*`, `btn.stash/branches`, `tooltip.stash_btn/branches_btn`).
- [ ] **Manual smoke (optional, requires `npm run tauri dev`)**: expand a repo → Stash button adds/lists/applies/pops/drops; Branches button creates/renames/publishes/deletes; a merge against a dirty tree offers "Stash changes & retry".

---

## Self-review notes

- **Spec coverage**: stash add/list/apply/pop/drop (Tasks 3,5,9) ✓; branch create/delete-local/delete-remote/rename/publish (Tasks 4,5,11) ✓; two separate dialogs (Tasks 9,11) ✓; both apply AND pop (Task 9) ✓; stash-in-merge with optional name, manual recovery (Task 13) ✓; untracked default ON (Task 9 signal, Task 13 hardcoded true) ✓; rename via prompt (Tasks 7,11) ✓; no new events, badge refresh after mutations ✓.
- **Type consistency**: `StashEntry { index, message, branch }` identical Rust↔TS; wrapper arg keys (`includeUntracked`, `repoPath`, `index`, `name`, `base`, `force`, `from`, `to`) match the Rust command params (camelCase wire ↔ snake_case Rust, auto-converted by Tauri).
- **Append-only command numbering** (#62–#71) avoids renumbering the whole contract doc.
