# Tray Quick-Control Panel — Design

**Date:** 2026-06-23
**Status:** Approved (implementing)

## Problem

The v2 tray icon only offers a native *Show / Hide* + *Quit* menu. The v1 app
(inventory-gui.md §25, `_build_tray_menu`) had a rich dynamic menu: start
selected, stop running, and a live list of running services. That was never
migrated. The user wants it back — but **custom UI, not the native Windows
menu** — as a fast surface to control the selected services without opening the
full app.

## Decision

A **frameless webview popup window** (`tray-panel`) anchored to the tray icon,
opened on left-click, auto-hidden on blur. It reuses the existing detached-window
pattern (log/dialog windows: `WebviewWindowBuilder` + `index.html?<param>=`,
closing/positioning Rust-side, no `core:window:*` perms in the webview).

Rejected: enriching the native menu (user vetoed the native style); reusing the
dialog host (`dlg-*` windows are centered modals, wrong for a tray-anchored
popup).

## What it shows

Header: `n/m running` + active profile name.
Top actions: **Stop all** / **Start all** — scoped to the *selected* services.
List: one row per **selected** repo. Selection lives in
`config.repo_state[name].selected` but is only persisted when a card is
toggled, so the rule is **"selected unless explicitly deselected"** (absent or
`true` ⇒ shown; only `selected: false` is hidden) — matching the v1
default-selected model. Row contents:

- status dot — green `running` · amber `starting` · red `error` · grey `stopped`
- service name
- clickable port (`http://localhost:<port>` via `OpenerService.openUrl`) when running
- actions: state-aware primary (**Start** when stopped / **Stop** when running) +
  **Restart** (running only) + **Logs** (always)

Footer: **Open DevDeck** / **Close DevDeck**.

Deliberately omitted (ponytail): repo-type icons, CPU/RAM, uptime, git/branch,
inline log preview, in-panel profile switcher, module sub-services (rows key by
`repo.name`; multi-module repos use the repo's primary service id only).

## Data flow

All client-side, reusing root stores (each webview gets its own instances,
hydrated by the existing `app.config.ts` initializer in every window):

- `ReposStore` (`list_repos`) → selected repo list
- `SettingsStore` (`get_app_config` → `repo_state`) → which are selected
- `ServicesStore` (`list_services` + `service://status-changed`) → live status + port

Actions reuse existing IPC: `start_service` / `stop_service` / `restart_service`
/ `open_log_window` / `app_exit`. Start-all / stop-all loop over the selected
ids client-side (no new bulk command; `stop_all_services` stops *all*, not just
selected).

## New backend surface (minimal)

- `lib.rs`: tray **left-click** opens/repositions/focuses the panel window
  (created lazily at the icon position; `decorations(false)`,
  `always_on_top(true)`, `skip_taskbar(true)`, `resizable(false)`); the native
  right-click menu stays as a fallback.
- `on_window_event`: label `tray-panel` → `Focused(false)` hides it; close acts
  like a plain window. Early-return branch like `dlg-*`/`log-*`.
- Two commands: `show_main_window` (show+focus main, hide panel — "Open DevDeck")
  and `request_quit_command` (reuse the tray-Quit confirm-running path — "Close
  DevDeck").
- `capabilities/default.json`: add `tray-panel` to `windows`.

## Frontend surface

- `app.component.ts`: `?panel` → `<tray-panel>` render mode.
- `features/workspace/tray-panel/`: `tray-panel.component.ts` (+ `.scss`) and a
  pure `tray-panel.logic.ts` (selected-rows + state→action mapping) with a spec.
- `commands.ts`: add `showMainWindow`, `requestQuit`; bump count assertions.
- i18n `tray.panel.*` keys in `en.json` + `es.json` (identical key sets).

## Open behavior

Tray interactions (user-specified):
- **Right-click** → show the panel (repositioned near the click).
- **Double left-click** → open DevDeck (restore the main window).
- **Single left-click** → nothing.

The panel window is **pre-created hidden at startup** so the first show is a
fully-loaded window (no blank flash, no focus race). A 700 ms grace guard after
each show makes the blur handler ignore the transient focus-loss while the popup
settles — otherwise it self-closes on open.

Because the panel is a separate webview the main window can't push to, it
**re-fetches repos + selection (and re-hydrates services) every time it gains
focus** (`onFocusChanged`) — i.e. every open is fresh. Service status/port stay
live through `ServicesStore` (event-fed in this window too).

`ponytail: anchors bottom-right near the click, clamped ≥0; multi-monitor edge
math deferred.`

## Tests

- Rust: panel label is Tauri-safe; (positioning is glue, not unit-tested).
- Frontend: `tray-panel.logic` — selected filtering + per-status action set.
