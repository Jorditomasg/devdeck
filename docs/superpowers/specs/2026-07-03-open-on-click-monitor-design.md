# Open secondary windows on the click monitor

**Date:** 2026-07-03
**Status:** approved

## Problem

On multi-monitor setups, secondary windows (detached log, git, terminal,
modal dialogs) open on the primary monitor (OS default placement, or
`.center()` for dialogs) regardless of which monitor the user clicked the
opening button on. The user works on monitor B, the window appears on
monitor A.

## Decision

Center every runtime-created secondary window on the monitor **under the
cursor** at creation time. The cursor is by definition where the click that
triggered the command just happened, so this needs zero IPC contract or
frontend changes — Rust only.

Rejected alternative: pass the caller `WebviewWindow` into each command and
use its `current_monitor()`. Same result, but touches four command
signatures for no gain.

## Scope (user-approved: ALL secondary windows)

| Window | File | Today | Change |
|--------|------|-------|--------|
| `log-*` | `commands/app.rs` | OS default | center on cursor monitor before show |
| `git-*` | `commands/app.rs` | OS default | same |
| `term-*` | `commands/terminal.rs` | OS default, built visible | build hidden → center → show |
| `dlg-*` | `commands/dialog.rs` | `.center()` (primary) | keep `.center()` as fallback, build hidden → re-center on cursor monitor → show |

Out of scope: the tray panel (positioned relative to the tray icon) and the
main window (session-restored position).

## Mechanism

One helper in `commands/app.rs`:

1. `app.cursor_position()` → global physical cursor position (Tauri ≥2.0).
2. `app.monitor_from_point(x, y)` → the monitor under it (Tauri ≥2.1; we pin 2.11).
3. Center the window's `outer_size()` inside the monitor's physical work
   area via `set_position(PhysicalPosition)`, clamped to the monitor origin.
4. Any failure (no cursor, no monitor, headless) → silently keep the
   existing placement. Best-effort, never an error.

Called while the window is still hidden (all four sites use the existing
hidden-then-show pattern; terminal and dialog gain it) so there is no
visible jump.

Known accepted imprecision: on mixed-DPI setups Windows rescales the window
after the move, so it may end up slightly off-center. Not worth a second
re-center pass.

## Testing

The centering arithmetic is extracted as a pure function
(`centered_origin`) with a unit test in the existing `#[cfg(test)]` module
of `app.rs`. The cursor/monitor plumbing is thin Tauri API glue — verified
manually on the real multi-monitor setup.
