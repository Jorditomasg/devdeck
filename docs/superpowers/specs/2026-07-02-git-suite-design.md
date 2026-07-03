# DevDeck Git Suite — Design

**Date:** 2026-07-02 · **Status:** Approved

## Goal

Give DevDeck a professional git review surface per repo: commit history with
advanced filters, commit graph with author avatars, per-commit diffs, full file
view at any commit, working-tree (stage) view, and a merge-conflict resolver.
Read-first, with a small set of safe write actions.

## Decisions (locked)

| Topic | Decision |
|---|---|
| UI host | Detached window `git-<repoId>` following the existing `log-*` pattern |
| Scope of actions | Read + safe actions only: checkout commit/branch, create branch from commit, stage/unstage file. NO reset, revert, cherry-pick, force-push |
| Avatars | Gravatar (`md5(email)` → `?d=404&s=64`), fallback to initials on a deterministic color (hash → hue). In-memory cache per email. No tokens, no hosting-specific APIs |
| Highlighting/editing | CodeMirror 6 — the ONLY new frontend dependency. Serves diff viewer, file-at-commit, and conflict editor. Language by file extension (TS, Java, Rust, HTML, CSS, JSON, YAML, XML) |
| Commit graph | Own lane-assignment algorithm rendered as SVG. Read-only, recomputed per page, ~200 lines of pure TS with unit tests on `(sha, parents)[] → lanes`. No graph library (ecosystem is abandoned) |
| Conflict resolver | Hunk-based: parse `<<<<<<< / ======= / >>>>>>>` (incl. diff3), per-hunk ours/theirs/both + manual CodeMirror edit, save validates no leftover markers, then `git add`. Triggered from the merge flow (`MergeOutcome` with conflicts in merge-branch dialog) and the conflicts badge. 3-way editor deferred |
| Lint | Never bundle linters. After resolving, offer to run the repo's own lint/check command from its command profile |

## Backend (Rust, `src-tauri/src/git/`)

New modules `history.rs` and `conflicts.rs`. All commands shell out via
`exec.rs` (WSL routing comes free) and **every read goes through the shared
cap-3 semaphore** used by the badge poller.

New IPC commands (~10):

| Command | Underlying git | Notes |
|---|---|---|
| `git_log` | `git log --format=<custom>` | Filters applied by git: `--author`, `--since/--until`, `--grep`, `-- <path>`, branch. Paginated: cursor sha + `-n 50`. Returns sha, parents, author name/email, date, subject, refs |
| `git_commit_files` | `git show --numstat --format=` | File list + add/del counts. Cheap; always fetched before any diff |
| `git_commit_file_diff` | `git diff <sha>^ <sha> -- <file>` | ONE file per call. Size cap ~500 KB and binary detection → `{ tooLarge }` / `{ binary }` flags instead of content |
| `git_file_at_commit` | `git show <sha>:<path>` | Full file at commit, same caps |
| `git_working_diff` | `git diff [--cached] -- <file>` | Stage view |
| `git_stage_file` / `git_unstage_file` | `git add` / `git restore --staged` | Safe actions |
| `git_checkout_commit`, `git_branch_from_commit` | reuse `ops.rs` / `branch.rs` | Safe actions |
| `git_conflict_hunks`, `git_resolve_file` | marker parsing + write + `git add` | Phase 4 |

Contract discipline: update `docs/migration/ipc-contract.md`, `CMD` in
`core/ipc/commands.ts`, and the count assertions in `commands.spec.ts`
together, per repo rules.

## Frontend

- **Window**: webview `git-<repoId>` loading `?git=<repoId>`; entry in
  `dialog-window-registry`; `windows` capability extended with `"git-*"`;
  `on_window_event` main-only guard already lets it close normally.
- **Layout**: left column = filter bar + commit list with SVG graph gutter;
  right panel = commit detail (metadata, avatar, file list → per-file diff on
  click → "open full file at this commit").
- **Stage section**: same window, second tab. `git status` grouped
  (staged / unstaged / untracked / conflicted) + working-tree diff per file
  using the SAME diff viewer. Stage/unstage per file.
- **Branch integration**: branch dialog gains "view history" per branch →
  opens `git-<repoId>` with the branch filter preselected. No duplicated UI.
- **Layering**: IPC wrappers + store in `core/`, presentational pieces in
  `ui/`, container in `features/`. Containers translate all text (`t()`),
  `en.json`/`es.json` keep identical key structure.

## Limits & errors

- Diff or file over cap → `{ tooLarge: true }`; UI offers opening in system editor.
- Binary files detected via `--numstat` `-` markers → "binary file" placeholder.
- Log never fetches more than 50 commits per page; filters run in git, not JS.
- Error envelope `{ kind, message }` as everywhere else.

## Delivery phases (each merges independently, fully functional)

1. **History + diff**: git window, paginated/filtered log, per-file diff, file at commit.
2. **Graph + avatars**: SVG lanes, Gravatar/initials.
3. **Branch/stage integration**: branch-dialog entry point, stage tab with stage/unstage.
4. **Conflicts + lint**: hunk resolver wired to merge flow and conflicts badge, lint via command profiles.

## Phase 2 addendum (2026-07-02, user feedback after phase 1)

- **Graph scope is contextual**: repo-card entry = whole-repo flow (`--all`);
  branch-dialog entry = that branch preselected. Branch dropdown carries an
  "All branches" option. `git log` always runs `--topo-order` (lane graph).
- **Lane graph**: own algorithm in `git-window/graph.ts` (first parent joins a
  LOWER lane early; higher lanes converge at the fork dot), SVG cell per
  fixed-height row (`graph-cell.component.ts`).
- **Detail is full-window**: selecting a commit replaces the list
  (breadcrumb + back), files left / viewer right.
- **Shared panel**: `file-diff-panel.component.ts` is the single
  files+code surface — commit detail, stash contents, phase-4 conflicts.
- **Stashes tab**: same window, stash list left; contents ride the ordinary
  commit queries with `sha = stash@{n}` (a stash IS a commit; first-parent
  diff ≡ `stash show`). Entry: "Files" button per entry in the stash dialog
  (`open_git_window { tab: "stashes", stash: n }`); already-open windows are
  only focused (accepted limitation).
- **Filters use app components**: `ui-searchable-select` for branch and
  author (author list from the new `git_authors` = `shortlog -sne --all`),
  app-styled text/date inputs.
- **Opaque surfaces**: every content surface paints `--color-card`; only the
  frame gutter shows the body pattern (matches the other detached windows).
- **Branch dialog**: widened to 900 px (action buttons wrapped) and gained a
  per-branch History button.

## Testing

- Rust: parser tests for the custom `git log` format, numstat parsing, conflict-marker parsing (incl. diff3, nested-ish edge cases), cap/binary detection.
- TS: unit tests for the lane algorithm, avatar fallback logic, filter → git-args mapping; count assertions in `commands.spec.ts`.
