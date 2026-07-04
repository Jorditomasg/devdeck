# Terminal "Run a Command" — Design

**Date:** 2026-07-05
**Status:** Approved

## Summary

Let the user launch a repo's configured start commands (detected `run_command` + command profiles) inside a detached PTY terminal window, fire & forget. The existing terminal button on the repo card becomes a menu: open a clean shell, or open a terminal that runs one of the repo's commands.

## Decisions (user-approved)

- **Source of commands:** the repo's already-defined start commands — detected `run_command` plus every command profile. No separate configurable command list (out of scope).
- **Supervision:** none. The terminal owns the process: DevDeck does not mark the service as running, offers no stop, captures no logs. Fully independent from the supervised start flow (`process.rs`).
- **UI:** the existing terminal icon button on the repo-card header opens a menu instead of a bare shell. No new button.
- **Naming:** these are presented as **commands**, not "arranques/launches" — the ▶ start button keeps that meaning.

## Backend (Rust)

- `open_terminal_window` (`src-tauri/src/commands/terminal.rs`) gains an optional `command: Option<String>` arg (camelCase `command` on the wire).
- After the PTY session spawns, write `command + "\r"` to PTY stdin (typeahead: the tty buffers it and the shell executes it once ready).
  - Why typeahead instead of spawning the command as the PTY process: the command stays visible in the terminal, and Ctrl+C drops the user into a usable interactive shell instead of closing the window.
- No other backend changes: no supervision, no new states, no kill path.

## Frontend (Angular)

- `commands.terminal.openWindow(...)` (`src/app/core/ipc/commands.ts`) gains the optional `command` param.
- Repo card (`repo-card.component.ts` / `card-header.component.ts`): terminal button click opens a menu (reuse the app-wide context-menu component):
  1. **Terminal** — clean shell (current behavior).
  2. Separator + "Commands" section: detected `run_command` (if any), then each command profile sorted by name.
- Selecting a command opens the terminal with that command; window title `<repo> — <command name>`.
- Profiles load lazily today (on card expand); the menu fetches them on open if not yet loaded.
- The header context-menu entry "Open terminal here" stays as-is (clean shell).

## i18n

- `tooltip.open_terminal` → "Terminal / run a command" / "Terminal / ejecutar un comando".
- New keys for the menu (e.g. clean-shell item, commands section label) added to BOTH `en.json` and `es.json` with identical key structure.

## IPC contract

- Command count unchanged (only a new optional arg on `open_terminal_window`). Update `docs/migration/ipc-contract.md`; count assertions in `commands.spec.ts` / `events.spec.ts` unaffected.

## Out of scope (deliberate)

- Arbitrary user-configurable commands beyond the start commands (this menu is the natural place to hang them later).
- Tracking the terminal process state in DevDeck; stopping it from DevDeck.
