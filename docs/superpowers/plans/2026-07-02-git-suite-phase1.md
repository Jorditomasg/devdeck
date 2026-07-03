# Git Suite Phase 1 — History + Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detached `git-<repoId>` window with paginated/filtered commit history, per-file diffs, and full file view at any commit.

**Architecture:** New pure-query Rust module `git/history.rs` (shell-outs via `exec.rs`, so WSL routing is inherited) exposed as 6 new IPC commands gated by the shared cap-3 `badge_semaphore`; frontend follows the `log-*` detached-window pattern with a container component that calls `IpcCommands` directly (log-window precedent — no new store).

**Tech Stack:** Rust/tokio (existing), Angular 22 signals (existing), CodeMirror 6 (NEW dependency — the only one; read-only file view now, conflict editor in phase 4).

**Spec:** `docs/superpowers/specs/2026-07-02-git-suite-design.md`

## Global Constraints

- Every new git read acquires `state.badge_semaphore` (cap 3) — same rule as the badge poller.
- Diff/file bodies over 512 KiB never cross IPC: `{ tooLarge: true }`; binary bodies: `{ binary: true }`.
- `git log` page size 50, filters applied by git, `--skip` cursor.
- Contract discipline: `docs/migration/ipc-contract.md` + `CMD` in `commands.ts` + count assertion in `commands.spec.ts` (90 → 96) updated together.
- `capabilities/default.json` `windows` gains `"git-*"`.
- All user-visible strings via `t()`; `en.json`/`es.json` identical key structure (new `git.*` section).
- `ui/` components import NOTHING from `core/` (no stores, IPC, i18n).
- Merge commits diff against FIRST parent: `git diff-tree -r --root -m --first-parent` (verified empirically; handles root commits too).
- No new Rust dependencies. Frontend adds only `@codemirror/*` + `@lezer/highlight`.

---

### Task 1: Rust history module ✅ (done first — pure, self-tested)

**Files:**
- Create: `src-tauri/src/git/history.rs`
- Modify: `src-tauri/src/git/mod.rs` (add `pub mod history;` + re-exports)

**Interfaces (Produces):**
- `pub async fn get_log(repo: &Path, filter: &LogFilter) -> Result<LogPage, String>`
- `pub async fn get_commit_files(repo: &Path, sha: &str) -> Result<Vec<CommitFileStat>, String>`
- `pub async fn get_commit_file_diff(repo: &Path, sha: &str, path: &str) -> Result<FileDiff, String>`
- `pub async fn get_working_diff(repo: &Path, path: &str, staged: bool) -> Result<FileDiff, String>`
- `pub async fn get_file_at_commit(repo: &Path, sha: &str, path: &str) -> Result<FileAtCommit, String>`
- Types (all `#[serde(rename_all = "camelCase")]`): `CommitInfo { sha, parents, authorName, authorEmail, date, subject, refs }`, `LogPage { commits, hasMore }`, `LogFilter { branch?, author?, since?, until?, grep?, path?, skip }`, `CommitFileStat { path, oldPath?, additions, deletions, binary }`, `FileDiff { content?, binary, tooLarge }`, `FileAtCommit { content?, binary, tooLarge, size }`

- [x] Log format `%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e` (subject LAST so stray `\x1f` can't shift fields), `-n 51` look-ahead for `hasMore`.
- [x] `is_option_like` guard on every positional rev; paths after `--`.
- [x] `cat-file -s` size guard BEFORE reading blobs; `\0` ⇒ binary.
- [x] Unit tests: log records (full/root/multi/separator-in-subject), numstat (header skip, binary, brace + plain renames, empty brace side), header strip, binary/oversize folds.

### Task 2: Rust commands + window + registration

**Files:**
- Modify: `src-tauri/src/commands/git.rs` (5 query commands)
- Modify: `src-tauri/src/commands/app.rs` (`open_git_window` mirroring `open_log_window`, label `window_label("git", &repo_id)`, URL `index.html?git=<repoId>`, size 1150×760)
- Modify: `src-tauri/src/lib.rs` (register 6 commands in `generate_handler!`)
- Modify: `src-tauri/capabilities/default.json` (`"git-*"` in `windows`)

**Interfaces (Produces — wire names):** `open_git_window { repoId, title }`, `git_log { repoPath, filter } -> LogPage`, `git_commit_files { repoPath, sha } -> CommitFileStat[]`, `git_commit_file_diff { repoPath, sha, path } -> FileDiff`, `git_file_at_commit { repoPath, sha, path } -> FileAtCommit`, `git_working_diff { repoPath, path, staged } -> FileDiff` (registered now, UI arrives in phase 3). Errors: `Err(String)` from history maps to `AppError { kind: "git", message }`.

- [ ] Each query command: `let _permit = acquire(&state.badge_semaphore).await?;` then delegate.
- [ ] Commit.

### Task 3: Frontend IPC wrappers + window bootstrap

**Files:**
- Modify: `src/app/core/ipc/tauri.types.ts` (6 new types, mirror Rust camelCase)
- Modify: `src/app/core/ipc/commands.ts` (`CMD` entries + `openGitWindow()` top-level + `git.log/commitFiles/commitFileDiff/fileAtCommit/workingDiff` wrappers)
- Modify: `src/app/core/ipc/commands.spec.ts` (count 90 → 96 + arg-mapping tests)
- Modify: `src/app/app.config.ts` (`isMainWindow` gains `!search.has('git')`)
- Modify: `src/app/app.component.ts` (`isGitWindow` + `@else if` branch + import)
- Modify: `docs/migration/ipc-contract.md` (§2.4 extension table + §2.1 `open_git_window`)

**Interfaces (Produces):** `IpcCommands.openGitWindow(repoId: string, title: string)`, `IpcCommands.git.log(repoPath, filter: GitLogFilter): Promise<GitLogPage>`, etc. Type names TS-side: `GitCommitInfo, GitLogPage, GitLogFilter, GitCommitFileStat, GitFileDiff, GitFileAtCommit`.

- [ ] Run `npm test` — count assertion green.
- [ ] Commit.

### Task 4: CodeMirror dependency + ui/ atoms

**Files:**
- Modify: `package.json` (+ `npm install`): `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/highlight`, `@codemirror/lang-javascript`, `-java`, `-rust`, `-html`, `-css`, `-json`, `-yaml`, `-xml`, `-markdown`, `-python`
- Create: `src/app/ui/code-view/code-view.component.ts` (read-only CodeMirror host: `content` + `fileName` inputs, language by extension, `lineNumbers()`, `defaultHighlightStyle`)
- Create: `src/app/ui/code-view/language-by-extension.ts` (+ `.spec.ts`) — pure map ext → CM `LanguageSupport` factory
- Create: `src/app/ui/diff-view/diff-view.component.ts` (+ `diff-lines.ts` + `.spec.ts`) — parse unified diff into typed rows (`header | hunk | add | del | context`), render `<pre>` rows with classes; no CodeMirror inside diffs (phase-1 scope: ±coloring)
- Create: `src/app/ui/avatar/avatar.component.ts` (+ `avatar.logic.ts` + `.spec.ts`) — `email`/`name` inputs, Gravatar URL via SHA-256 (`crypto.subtle`) `?d=404&s=64`, `(error)` → deterministic-hue initials fallback
- Modify: `src/app/ui/index.ts` (barrel exports)

**Interfaces (Produces):** `<ui-code-view [content] [fileName]>`, `<ui-diff-view [diff]>`, `<ui-avatar [email] [name]>`; `parseDiffLines(diff: string): DiffLine[]`; `initialsOf(name)`, `hueOf(email)`, `gravatarUrl(email): Promise<string>`.

- [ ] `ui/` stays core-free. Tests for the three pure logic files. Commit.

### Task 5: git-window feature + entry point + i18n

**Files:**
- Create: `src/app/features/workspace/git-window/git-window.component.ts` (+ `.scss`, + `git-window.logic.ts` + spec) — container: reads `?git=`, hydrates repo via `detection.listRepos()`, filter bar (branch select from `git.branches`, author, text, since, until, path), commit list w/ avatars + ref chips, "load more" (skip += 50), detail panel: file stats list → per-file diff on demand → "open full file at commit" via `ui-code-view`
- Modify: `src/app/app.component.ts` import (from Task 3)
- Modify: `src/app/features/workspace/repo-card/repo-card.component.ts` (git-history button beside existing log button → `openGitWindow(repo.name, …)`)
- Modify: `src/assets/i18n/en.json` + `es.json` (new `git.*` section, identical structure)

**Interfaces (Consumes):** everything from Tasks 3-4. `git-window.logic.ts` produces `filterToLogArgs(state): GitLogFilter` (pure, tested).

- [ ] All strings via `t()`/`| t`. Commit.

### Task 6: Verification

- [ ] `npm test` — all green.
- [ ] `npx madge --circular --extensions ts src/app` — no new cycles.
- [ ] `cargo check` if the environment allows (no app build — repo rule); otherwise Rust verification rides on the unit tests at next `cargo test` run.
- [ ] Hand the user the commit commands (repo rule: Claude never commits).
