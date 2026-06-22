# Changelog

All notable changes to DevDeck are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
