# Git Changes Window — Design

**Date:** 2026-07-03 · **Status:** Approved
**Extends:** `2026-07-02-git-suite-design.md` (this IS its phase 3 "stage view",
reshaped to the phase-3 no-tabs model, plus edit-in-place and discard).

## Goal

Clicking the 📝 changes badge on a repo card opens a detached window showing
the working-tree changes: file list (grouped staged / unstaged) on the left,
per-file diff or an EDITABLE file view on the right. Per-file safe actions:
stage, unstage, discard (confirmed), edit + save. No commit.

Also fixes two git-window papercuts: per-mode window titles/labels (opening
stashes no longer says — or focuses — "Historial Git") and palette-aware
button colors inside the git window.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Host | The existing git window, third mode `?git=<repo>&tab=changes` (mode fixed at open, like history/stashes) |
| Window label | Per mode: `git-<id>` (history), `git-stashes-<id>`, `git-changes-<id>` — all covered by the `git-*` capability/handler patterns. Opening one mode no longer focuses another |
| Native title | Composed by the OPENER: `«repo» — Git: <Historial|Stashes|Cambios>` via new i18n keys `git.title_history/title_stashes/title_changes`, replacing `git.window_title`/`git.stashes_title` (openers used `window_title` = "Historial Git" for EVERY mode — the reported bug) |
| File list | Two groups, VS Code style: staged / changes (unstaged + untracked). Status letter per row (M/A/D/R/U/C). NO ± counts (numstat skipped — add later if missed) |
| Right pane | Diff by default (`git_working_diff`, already shipped). "Ver fichero" → editable CodeMirror; Guardar button + Ctrl+S writes to disk. Untracked files jump straight to the editor (no diff exists) |
| Actions | Stage (`git add -- <p>`), unstage (`git restore --staged -- <p>`), discard (tracked: `git restore -- <p>`; untracked: `git clean -f -- <p>`) — discard confirmed via a messagebox child window parented to the git window. Stage on a conflicted file marks it resolved (git semantics) |
| Refresh | Every action (stage/unstage/discard/save) reloads the list, re-queries the current diff and calls `git_refresh_badge` so the card badge updates without waiting for the 30 s poll |
| Editor deps | `@codemirror/commands` added (history/undo + default keymap — an editor without Enter/undo is not an editor). Same CodeMirror family as the locked git-suite decision; imported directly by consumers, never via the `ui` barrel |
| Badge click | 📝 badge now opens this window (replaces the plain-text info dialog). The ⚠️ conflicts badge is untouched (phase-4 resolver) |
| Buttons | Git window + file-diff-panel `variant="neutral"` → `variant="log-action"` (palette-following accent family). `neutral` stays fixed app-wide |

## Backend (Rust) — new module `git/worktree.rs`, 6 new commands (101 → 107)

| Command | Underlying | Notes |
|---|---|---|
| `git_changes_list` | `git status --porcelain -z` | → `[{ path, oldPath?, staged, status }]`; one porcelain row can yield a staged AND an unstaged entry (`MM`). Pure parser, unit-tested (renames `R new\0old`, untracked `??`, conflicts `UU/AA/DD` → `C`) |
| `git_stage_file` | `git add -- <p>` | `OpOutput` fold, badge semaphore not needed (mutation; follows `ops.rs` pattern) |
| `git_unstage_file` | `git restore --staged -- <p>` | idem |
| `git_discard_file` | `git restore -- <p>` / `git clean -f -- <p>` (untracked flag from the frontend) | Destructive; the frontend confirms first. Going through git (not `fs::remove_file`) keeps WSL routing + `.gitignore` semantics |
| `git_read_working_file` | `std::fs` | Same `FileAtCommit` payload (content/binary/too_large/size), same 512 KiB cap, NUL byte ⇒ binary |
| `git_write_working_file` | `std::fs` | **Trust boundary**: shared guard `resolve_in_repo(repo, rel)` — rejects absolute/option-like paths, canonicalizes and requires the result stay under the canonicalized repo root (symlink escapes fail the prefix check). Read uses the same guard. Write requires the file to already exist (editing changed files only — never creates paths) |

Queries (`git_changes_list`) take the shared badge semaphore like every other
git read. All git subprocesses go through `exec.rs` (WSL routing, no shell).

## Frontend

- `git-window.component.ts`: `mode` gains `'changes'`; that mode renders a new
  container `changes-view.component.ts` (same folder) and skips all
  history/stash loading. `document.title` uses the same per-mode keys.
- `changes-view.component.ts`: owns the changes list + selection + actions +
  right pane state; talks IPC directly (it is a container; translates all
  text). Confirm uses `openDialogWindowForResult(…, 'messagebox',
  { kind: 'confirm' }, parentLabel = current window label)`; the label comes
  from a new `TauriBridge.currentWindowLabel()` (keeps `@tauri-apps/api`
  inside the bridge).
- `ui/code-edit/code-edit.component.ts`: editable CodeMirror host (direct
  import, not via the `ui` barrel). Inputs `content`/`fileName`; outputs
  `contentChanged(text)` + `saveRequested` (Mod-s). Rebuilds editor state ONLY
  when the incoming `content` differs from the live doc — saving (which echoes
  the doc back) never resets the cursor.
- Dirty tracking lives in the container: `dirty = draft !== loaded`; Guardar
  enabled only when dirty; save → `git_write_working_file` → reload diff +
  list + badge.
- `repo-card.component.ts`: `onShowChanges()` now opens the window
  (`tab: 'changes'`); the old info-dialog path and its i18n keys go away if
  unused elsewhere.
- IPC: `CMD` + wrappers + `commands.spec.ts` count 101 → 107 and arg-shape
  tests; `openWindow` view type gains `tab: 'changes'`;
  `docs/migration/ipc-contract.md` updated.
- i18n: new keys under `git.` (titles, groups, actions, confirm, save);
  `en.json`/`es.json` keep identical key structure.

## Errors & limits

- Same caps as the git suite: >512 KiB ⇒ `too_large`, NUL ⇒ `binary` (both
  render the existing notice instead of content; editing disabled).
- Write failures surface the `{ kind, message }` envelope in the view's error
  strip; the draft is kept (no data loss on failed save).
- Action failures (`OpOutput.ok = false`) show the message in the error strip
  and still reload the list (the tree may have partially changed).

## Testing

- Rust: porcelain -z parser (renames, MM double-entry, untracked, conflicts);
  `resolve_in_repo` guard (`..`, absolute, outside-symlink, missing file).
- TS: `commands.spec.ts` counts + new wrapper arg shapes; changes-view logic
  kept in `changes-view.logic.ts` where pure (grouping, status letters) with
  unit tests.
