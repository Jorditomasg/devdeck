# Design — Dialogs as native windows

Status: **proposed** (2026-06-21). Owner: Claude (per CLAUDE.md Claude-owned design).

## Goal & constraints (from the user)

- Every in-app modal becomes a **real OS window** (own webview), so it can be
  **moved / placed on another monitor**.
- Windows are **NOT resizable** — fixed size per dialog kind (`resizable(false)`).
- All ~13 dialogs in scope, **migrated by phases** behind a bridge so the build
  stays green at every step.

## Why this is non-trivial (the cost we accepted)

A dialog window is a **separate Angular app** in a separate webview. It cannot
inject the main window's signal stores (`ReposStore`, `ProfilesStore`,
`TranslationService` catalog). So three things must change for every dialog:

1. **Inputs** can no longer be in-process objects — they cross a process
   boundary as JSON.
2. **Results** (`openForResult`: confirm→bool, prompt→string|null, etc.) must
   return over IPC, not a resolved in-process Promise.
3. **Nested sub-dialogs** (`this.dialogs.confirm(...)`, `this.dialogs.prompt(...)`
   called from branch/stash/merge/profile-manager) must open **child windows**
   parented to the dialog, and await their result the same way.

## Contract

### Window identity & routing
- Label: `dlg-<kind>-<n>` (n from a per-process counter).
- URL: `index.html?dialog=<kind>&token=<token>`.
- `app.component` gains a render mode `isDialogWindow` → renders a new
  `app-dialog-window-host` that instantiates the right dialog component for
  `<kind>` and feeds it the fetched args.

### Transport (Rust `DialogRegistry`, keyed by `token`)
One generic mechanism serves top-level dialogs AND nested sub-dialogs:

| Command | Direction | Purpose |
|---|---|---|
| `open_dialog_window { kind, args, parentLabel? } -> token` | opener → Rust | allocate token, store `args` JSON, create the `dlg-*` window (parented + centered on `parentLabel` when given), `resizable(false)`, fixed size for `kind` |
| `get_dialog_args { token } -> argsJson` | dialog win → Rust | the window fetches its inputs on init |
| `resolve_dialog { token, result }` | dialog win → Rust | record result, emit `dialog://resolved { token, result }`, close the window |

Event: **`dialog://resolved`** `{ token, result }`. The opener (main window OR a
parent dialog window) listens for its own token and resolves the JS Promise.
The opener API (`DialogService`) keeps the SAME public signatures
(`confirm`, `prompt`, `openBranches`, …) — only the internals switch from
"push on the in-app stack" to "open_dialog_window + await dialog://resolved".

### Cancel / close (✕)
Rust `on_window_event` for `dlg-*` `CloseRequested`: if the token is still
unresolved, emit `dialog://resolved { token, result: null }` (the registered
fallback applies opener-side, mirroring today's ESC/✕ → cancel), then allow the
native close. Window manipulation stays **Rust-side only** (no `core:window:*`
perms in the webview — same rule that the terminal-close bug taught us).

### Store-derived inputs
The opener resolves store data **before** opening and passes it as args:
- `repoName` → also pass `repoPath` (resolved via `ReposStore`).
- Any list the dialog renders from a store (e.g. profiles) → pass as args or let
  the dialog re-fetch via an existing IPC command.

After a mutation, a dialog window refreshes the badge by calling the existing
`git_refresh_badge` command, which emits `git://badge`. **Assumption to verify
in Phase 1:** the main window's `ReposStore` already listens to `git://badge`,
so the badge updates cross-window with no new plumbing.

### Sizing
Fixed `inner_size` per kind, carried from today's `ui-dialog-shell` widths
(branch 680, stash 620, merge 600, settings …) with a sensible fixed height.
A `kind → (w,h)` table lives in the Rust `open_dialog_window` (single source).

## Phasing (each phase keeps the build green via the bridge)

`DialogService.open*` routes **per kind**: migrated kinds → `open_dialog_window`;
not-yet-migrated kinds → the existing in-app stack. So we convert one at a time.

- **Phase 0 — Design.** This document. ✅ done.
- **Phase 1 — Infra + reference slice.** ✅ done. Rust `DialogManager`
  (`state.rs`) + the 3 commands (`commands/dialog.rs`) + `dialog://resolved`
  event + `dlg-*` capability + `dlg-*` close handler (`lib.rs`) + `app.component`
  routing + `app-dialog-window-host` + `WindowDialogsApi` + `DIALOG_WINDOW_MODE`
  (windowed `ui-dialog-shell`) + the opener bridge. **messagebox**
  (info/warning/error/confirm) converted as the reference; `DialogService`
  routes it to a window. `ipc-contract.md`, `CMD`/`EVT`, and the count
  assertions updated together. Needs `npm run tauri dev` to verify at runtime
  (Rust not built here).
- **Phase 2 — Prompt.** ✅ done. `prompt` added to the window registry and
  `DialogService.prompt` routes to a `dlg-prompt-*` window; `WindowDialogsApi`
  already opens it as a child window. After Phase 1+2, every nested
  `confirm`/`prompt` works as a child window.
- **Phase 3 — Autonomous dialogs.** 🚧 in progress.
  - **Cross-window sync foundation ✅**: `config://changed` event emitted from
    the single `ConfigStore::save` choke point (optional emitter wired in
    `lib.rs`); every window's `SettingsStore` re-syncs (`onConfigChanged`).
    `list_repos` command + `ReposStore` hydration so dialog windows resolve
    `repoByName`.
  - **workspace-groups ✅** converted (proves live config-sync; uses only
    messagebox/picker sub-dialogs, which are already windows).
  - **Reclassified — NOT autonomous, deferred:**
    - `settings` opens the Java manager + changelog via `dialogs.open()` (custom
      components) → needs those as window kinds first (→ Phase 4-ish).
    - `config-editor` has an unsaved-changes guard that must intercept the
      close; a native window's OS ✕ bypasses it → needs a **window close-guard
      mechanism** (dialog-window-host intercepts the OS close via
      `onCloseRequested` with always-`preventDefault`, routing through the
      dialog's `(closed)` guard, then `resolve_dialog`).
    - `docker-compose`, `repo-config-manager`: read repos (now hydrated) and use
      messagebox/prompt only — convertible next; verify no close-guard.
    - `clone`: mutates the repo list (new repo) → needs a `repos://changed` or a
      rescan-on-resolve.
- **Phase 4 — Sub-dialog spawners:** branch, stash, merge-branch,
  profile-manager, confirm-close (their confirm/prompt are now child windows).
- **Phase 5 — Cleanup.** Remove the in-app stack (`dialog-host`, cascade in
  `ui-dialog-shell`, `DialogService` stack internals) once nothing routes to it;
  reconcile `ipc-contract.md` and this doc to "implemented".

## Risks / open questions
- **Modality:** parented + non-resizable + focused, but NOT blocking the main
  window (the user wants to move them to another monitor → non-blocking). Revisit
  if a specific dialog needs to block.
- **Per-window i18n cost:** each dialog window re-inits `TranslationService`
  (loads the catalog). Acceptable; cache via the bundled asset.
- **`git://badge` cross-window assumption** — verify in Phase 1.
- **Count assertions** (`commands.spec` = 79, events) change every phase that
  adds commands/events; Phase 1 adds 3 commands + 1 event.
