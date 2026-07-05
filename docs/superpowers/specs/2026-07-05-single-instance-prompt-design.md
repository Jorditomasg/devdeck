# Single-instance prompt — styled in-app dialog

**Date:** 2026-07-05
**Status:** Approved

## Problem

When a second DevDeck instance is launched while one is already running, the
running instance shows a **native Windows `MessageDialog`** ("DevDeck is
already running. Open / Cancel"). It clashes with the app's visual language —
every other DevDeck dialog is a frameless, app-themed window
(`docs/migration/dialogs-as-windows.md`). We want this prompt to look like the
rest of the app.

## Constraint that shapes the design

DevDeck has **no in-app overlay modals**. Every dialog is its own OS window
(`dialog.service.ts`; `open()` throws). Those dialog windows are created
`parent`-ed to `main` (`commands/dialog.rs`). On Windows an *owned* window is
hidden together with its owner — and this prompt fires precisely when `main`
may be **minimized to the tray**. Therefore the second-instance prompt must be
opened **without a parent** (top-level) so it stays visible regardless of the
main window's state.

## Behavior (chosen)

Keep the current "don't steal focus" semantics, just re-skinned:

1. Second instance starts → the `single-instance` plugin fires its callback in
   the running instance.
2. Rust emits `app://single-instance` (argv/cwd) — as it already does — and
   **no longer shows a native dialog**.
3. The main webview (alive even while hidden in the tray) reacts to the signal
   and opens DevDeck's own styled confirm window, **detached (no parent)**.
4. "Yes" → `show_main_window` (existing command) restores + focuses the window.
   "No" → the app stays in the tray.

## Changes

- **`src-tauri/src/lib.rs`** — the single-instance callback keeps only the argv
  emit; the native-dialog block and the `already_running_strings` helper are
  removed (the two inlined locales move to the i18n JSON).
- **`dialog.service.ts`** — new `confirmSecondInstance()`: opens the `confirm`
  messagebox window with `parentLabel: undefined`.
- **`workspace-page.component.ts`** — an `effect` on `settings.singleInstance()`
  opens the prompt and, on confirm, calls `commands.showMainWindow()`.
- **`settings.store.ts`** — update the now-stale "UNCONSUMED by design" note on
  the `singleInstance` signal.
- **`en.json` / `es.json`** — `dialog.single_instance.{title,message}` (buttons
  reuse the existing `btn.yes` / `btn.no`).

## Not changing

App identifier, the single-instance plugin, the argv payload (still forwarded
for future use). No new IPC commands — `show_main_window` already exists.
