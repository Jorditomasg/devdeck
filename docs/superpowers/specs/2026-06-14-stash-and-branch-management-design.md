# Design — Git Stash & Branch Management

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Area:** DevDeck git feature surface (Tauri 2 Rust core + Angular 22 frontend)

## Context

The last git feature integrated was **merge** (`git_merge` / `git_revert_merge`, the
`MergeBranchDialogComponent`). This change adds two new git feature surfaces following the
**exact same vertical-slice pattern**:

1. **Stash management** — add to stash, list, apply, pop, drop. Net-new (no `git_stash_*` exists).
2. **Branch management** — create, delete (local + remote), rename, publish. Builds on the
   existing primitives (`git_branches`, `git_current_branch`, `git_checkout`, `git_has_branch`).
3. **Stash-in-merge integration** — when a merge is blocked by uncommitted changes, offer to
   stash them (with an optional name) and retry; the stash is left for manual recovery.

Architecture is non-negotiable (CLAUDE.md): **Rust owns all side effects**, Angular is pure UI
over a typed IPC contract; wire names live once in `core/ipc/commands.ts`; mutating git ops fold
failures into `OpOutput { ok, message }` (only infrastructure failures reject with `kind: "git"`).

## Decisions (from brainstorming)

- **UI surface:** two separate dialogs (`StashDialog`, `BranchDialog`), each a `DialogBase`, one
  repo-card menu entry each. Faithful to "one dialog = one concern" (like merge).
- **"Take from stash":** offer **both** apply (keeps the entry) and pop (applies + drops).
- **Branch ops to add:** create, delete local, delete remote, rename, publish/track.
- **Stash-after-merge:** leave manual — the stash stays in the list; the user recovers it from
  `StashDialog`. The merge never re-touches the working tree automatically.
- **Include untracked when stashing:** default **ON** (`-u`).
- **Rename UX:** via a mini-prompt dialog (not inline editing).

## 1. Rust layer (`src-tauri/`)

### Module organization

Add two focused modules instead of bloating `git/ops.rs` (already >700 lines, the faithful port
of v1 `git_manager.py`). These features have no v1 equivalent, so they get their own bounded units:

- `src-tauri/src/git/stash.rs` — stash operations
- `src-tauri/src/git/branch.rs` — branch mutation operations
- `src-tauri/src/git/parse.rs` — add `parse_stash_list` (pure, unit-tested)
- `src-tauri/src/git/types.rs` — add `StashEntry`
- `src-tauri/src/git/mod.rs` — declare modules + re-export new ops/types

All ops shell out through the existing `super::exec::run_git` with `T_BRANCH_OP` timeout. No new
semaphore (these are one-off user actions, like `checkout`/`merge`).

### Types (`types.rs`, `#[serde(rename_all = "camelCase")]`)

```rust
pub struct StashEntry {
    pub index: usize,    // 0-based; addresses stash@{index}
    pub message: String, // the stash description
    pub branch: String,  // branch the stash was created on (best-effort)
}
```

Everything else reuses `OpOutput`.

### Commands (`commands/git.rs`, numbered #23+)

Signature pattern identical to existing mutations:
`async fn …(app: AppHandle, repo_path: String, …) -> CmdResult<…>`, logging via
`op_log_sink(app, path_basename(&repo), LogStream::Git)`. Query commands omit `app`.

| # | Command | Args | Returns | git mapping |
|---|---|---|---|---|
| - | `git_stash_list` | `{ repoPath }` | `StashEntry[]` | `stash list --format=…` → `parse_stash_list` |
| - | `git_stash_push` | `{ repoPath, message?, includeUntracked }` | `OpOutput` | `stash push [-u] [-m <message>]` |
| - | `git_stash_apply` | `{ repoPath, index }` | `OpOutput` | `stash apply stash@{index}` |
| - | `git_stash_pop` | `{ repoPath, index }` | `OpOutput` | `stash pop stash@{index}` |
| - | `git_stash_drop` | `{ repoPath, index }` | `OpOutput` | `stash drop stash@{index}` |
| - | `git_create_branch` | `{ repoPath, name, base?, checkout }` | `OpOutput` | `checkout -b name [base]` if checkout else `branch name [base]` |
| - | `git_delete_branch` | `{ repoPath, name, force }` | `OpOutput` | `branch -d` / `branch -D` when force |
| - | `git_delete_remote_branch` | `{ repoPath, name }` | `OpOutput` | `push origin --delete name` |
| - | `git_rename_branch` | `{ repoPath, from?, to }` | `OpOutput` | `branch -m [from] to` |
| - | `git_publish_branch` | `{ repoPath, name }` | `OpOutput` | `push -u origin name` |

Register all in `lib.rs` `generate_handler!`. Index-addressed stash ops construct `stash@{index}`
from the `index` arg; the frontend re-lists after every mutation so indices stay fresh.

## 2. IPC contract (`core/ipc/`)

- `commands.ts`: 10 new `CMD` entries (camelCase key → snake_case wire) + typed wrappers in the
  `git` object (one-liners over `bridge.invoke`).
- `tauri.types.ts`: `StashEntry` interface + arg shapes mirroring the Rust serde casing.
- `commands.spec.ts`: bump the command-count assertion + add payload-passthrough tests for the
  new wrappers.
- `docs/migration/ipc-contract.md` §2.4: append the 10 rows.
- **No new events.** Progress flows through `service://log-line` (`stream: "git"`); the UI calls
  `repos.refreshBadge(repoPath)` after each mutation (v1 on-complete refresh).

## 3. Frontend dialogs (`features/dialogs/`)

Both extend `DialogBase`, use signals for state, `SearchableSelectComponent` for branch pickers,
and a live `<pre>` log mirroring git-stream lines (same construction as the merge dialog). Pure
logic (branch-name validation, request building) lives in a sibling `*.logic.ts` with unit specs.
`dialog.service.ts` gains `openStash(repoName)` and `openBranches(repoName)`. The repo-card adds
two menu entries that emit events wired to those service methods.

### StashDialog (`features/dialogs/stash/`)

- **Add section:** optional name input + "include untracked" checkbox (default **checked**) +
  "Add to stash" button → `git_stash_push`.
- **Entries list** (from `git_stash_list`): each row shows the message + branch and offers
  **Apply**, **Pop**, **Drop** (drop is confirmed). Apply/Pop refresh the badge.
- Re-lists after every mutation. Live log + outcome notices reuse the merge dialog's pattern.

### BranchDialog (`features/dialogs/branch/`)

- **Create section:** name input + base picker (`SearchableSelectComponent`, fed by
  `git_branches`) + "checkout after create" checkbox → `git_create_branch`.
- **Branch list:** per branch — **Checkout**, **Rename** (mini-prompt for the new name),
  **Publish** (`push -u`), **Delete local** (confirmed; on "not fully merged" failure offer a
  forced `-D` retry), **Delete remote** (confirmed). The current branch is marked and cannot be
  deleted.
- Re-lists after every mutation; refreshes the badge.

## 4. Stash-in-merge integration

In `MergeBranchDialogComponent`, when the outcome is `blocked_dirty`: below the dirty-file list,
render an optional name input + a **"Stash changes and retry"** button. On click it calls
`git_stash_push(repoPath, message, includeUntracked = true)`; on success it re-invokes
`runMerge()`. The stash is **left in the list** (manual recovery from `StashDialog`). New i18n
keys live under `dialog.merge.*`.

## 5. i18n

New blocks `dialog.stash.*` and `dialog.branch.*` in both `src/assets/i18n/en.json` and `es.json`
(identical key structure — CI-checkable), plus the merge-integration keys under `dialog.merge.*`.

## 6. Testing

- **Rust:** unit tests for `parse_stash_list` in `parse.rs`; shell-out ops covered consistently
  with the rest of the module.
- **Frontend:** specs for the pure logic (branch-name validation, request building) + updated
  command-count assertions in `commands.spec.ts`.

## File summary

- **Rust:** new `git/stash.rs`, `git/branch.rs`; edits to `git/types.rs`, `git/parse.rs`,
  `git/mod.rs`, `commands/git.rs`, `lib.rs`.
- **IPC:** `core/ipc/commands.ts`, `core/ipc/tauri.types.ts`, `core/ipc/commands.spec.ts`,
  `docs/migration/ipc-contract.md`.
- **Frontend:** `features/dialogs/stash/` (component + logic + specs),
  `features/dialogs/branch/` (component + logic + specs), `dialog.service.ts`, repo-card menu,
  `MergeBranchDialogComponent` (stash-in-merge).
- **i18n:** `en.json`, `es.json`.

## Non-goals (YAGNI)

- No stash diff/preview viewer (just message + branch).
- No interactive rebase / branch graph visualization.
- No auto-restore of the merge stash.
- No partial/path-scoped stashing.
