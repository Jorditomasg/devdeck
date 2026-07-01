# Changelog

All notable changes to DevDeck are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.5] - 2026-07-01

### Security

- Hardened git operations so branch names and clone URLs that begin with a dash
  can no longer be misinterpreted as git command-line options.

## [2.0.4] - 2026-06-26

### Fixed
- Deleting or renaming a start configuration now clears it from the repo's
  selector when it was the active one, instead of leaving a stale entry until
  the next workspace rescan.

### Changed
- Reorder mode now collapses every card into a compact list and keeps cards
  collapsed while you rearrange them, so dragging is no longer interrupted by
  expanded panels.

### Fixed
- Start configuration options now refresh immediately after you close the
  configuration manager, instead of showing stale choices.

## [2.0.3] - 2026-06-24

### Changed
- DevDeck now installs per-user without requiring administrator privileges, and
  updates apply without elevation prompts. Note: if you have a previous
  system-wide installation, uninstall it once before updating to avoid a
  duplicate install.

## [2.0.2] - 2026-06-24

### Added
- Linux builds: portable AppImage and `.deb` package, with a native system
  tray menu.

### Fixed
- A running repository now stays highlighted even when it isn't selected, and
  unselected repositories fade more gently instead of looking disabled.
- While dragging to reorder, the dragged repository always shows as collapsed,
  even if its panel was expanded.

## [2.0.1] - 2026-06-24

### Added
- Live search box to filter the repository list by name.
- Manual drag-to-reorder for repositories (enabled via a toggle); your custom
  order is remembered between sessions.
- A banner that warns when services are still left running in another
  environment after you switch.

### Changed
- Action buttons (clone, pull, branches, stash, merge, clean, log actions and
  the colored dialog buttons) now adopt the colors of the active theme palette
  instead of always appearing blue or purple.
- Selected repositories are now visually accented while unselected ones are
  dimmed, making the active selection clearer.
- The repository list now refreshes automatically when the active environment's
  folders change.
- "Group" is now called "Environment" throughout the app (English and Spanish).
- The command profile manager dialog now opens at a larger, more usable size.

### Fixed
- Branch operation messages now appear in the correct order, interleaved with
  the live git output.
- Imported command profiles are now saved immediately on import instead of only
  after the next change.

## [2.0.0] - 2026-06-24

### Added
- Appearance settings: pick a color palette (Indigo, Slate, Emerald, Crimson,
  Rose or Light) and a background pattern (Isometric cubes, Grid, Dots, Corner
  zig-zag, Hexagons, Scales, Moroccan, or none). Your choice is remembered and
  applies instantly across every window.

### Changed
- The Command Profiles manager now uses a two-column layout — profile list on
  the left, a multi-line command editor on the right — matching the repository
  configuration manager.
- Git operation dialogs (branch, clone, merge, stash and profile import) now
  share a single, cleaner progress log panel.

### Fixed
- Detached log windows now get a proper Windows taskbar button and minimize to
  the taskbar instead of vanishing into the legacy desktop corner.
- Dialog windows can no longer be minimized or maximized, so fixed-size dialogs
  can't get lost off-screen.
- Opening a repository folder or the workspace path in the file explorer now
  works for every path.
- Repository card logs no longer show a duplicated `[git]` / `[docker]` prefix.

## [1.2.1] - 2026-06-23

### Changed
- Opening Settings now shows the available update and its version
  automatically, without having to click "Check for updates" first.
- Renamed the start-command selector on each repository card from "Profile" to
  "Launch", to set it apart from workspace profiles.

### Fixed
- Closing the main window now hides DevDeck to the tray and it can be reopened
  again from the tray (double-click or "Open DevDeck"); previously it became
  stuck in the tray and only "Close DevDeck" worked.

## [1.2.0] - 2026-06-23

### Added
- Command profiles per repository: save multiple named launch configurations
  for a service and switch between them, instead of editing a single custom
  command and start arguments each time. Name a new profile inline without a
  separate dialog.
- Redesigned system tray with a custom quick-control panel for starting and
  stopping services, replacing the plain native menu.

### Changed
- Refreshed icons across the whole app with crisp inline SVG icons in place of
  emoji, for a consistent look at every screen scale.
- Reordered the git action buttons on each repository card by how frequently
  and how safely they are used, so the common, safe actions come first.

### Fixed
- Profile changes (saving, deleting, switching the active profile) now sync
  immediately across all open windows.
- The app now self-heals a corrupted configuration file instead of failing to
  start.
- Service start and stop failures are now surfaced clearly instead of leaving a
  repository card stuck in a pending state.
- Dialog windows no longer open duplicates; the same dialog reuses its existing
  window.

## [1.1.0] - 2026-06-23

### Added
- Built-in detection for more project types: Go, Rust, Python, Laravel and
  CodeIgniter repositories are now recognised out of the box.
- Per-service start arguments: add extra arguments to a service's launch
  command without rewriting the whole command (for example Spring Batch job
  parameters or Python script arguments). Your arguments are saved with the
  service and captured in profiles.
- A pulsing badge on the settings gear when an app update is available.

### Changed
- Switching the language now applies instantly across every window and the
  tray — no restart needed.

### Fixed
- Docker Compose service buttons now reflect the actual running state, and the
  manage dialog stays locked to the compose file you picked.

## [1.0.2] - 2026-06-23

### Fixed
- Renaming or duplicating a saved repository configuration no longer fails.

## [1.0.1] - 2026-06-22

### Added
- Settings now lets you choose which terminal opens for a repo: pick a shell
  detected on your machine (PowerShell, CMD, WSL, Git Bash, your login shell)
  or enter a custom command. New terminals use your choice.
- Branch and Stash management got a cleaner layout: a paginated table with
  tooltips on every action and a dedicated Logs tab.

### Changed
- Every dialog now opens as its own window, so you can move it to another
  monitor and keep working in the main window.
- Repo cards are tidier: the icon before the repo name was removed (the type
  badge stays).

### Fixed
- Terminal windows now close correctly.
- Branch and Stash dialogs no longer open empty — the list shows immediately,
  and the text fields are styled properly.
- The standalone "Config" button no longer appears on repos that have no
  environment files to configure.

## [1.0.0] - 2026-06-21

### Added
- In-app automatic updates: DevDeck now detects new versions, shows what
  changed, and installs the update with a single click.
- Changelog viewer: browse the full history of changes from inside the app.

### Changed
- First stable release. Promotes the 0.9.0 preview to 1.0.0.
