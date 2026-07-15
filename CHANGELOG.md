# Changelog

All notable changes to DevDeck are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.4.0] - 2026-07-15

### Added

- Log windows now have a jump-to-bottom button to quickly return to the latest
  lines after scrolling, plus a per-window "always on top" toggle so you can
  keep a specific log window pinned above other apps.
- Bulk stash and branch management in the git window: multi-select stashes or
  branches and delete them in a single action.
- Filter files within a commit's detail view, pre-filled from the active path
  filter.

### Changed

- Faster git status and badge reads for repositories inside WSL, using a
  persistent per-distro shell session for near-native speed.

### Fixed

- Branch lines in the git graph that converge into a shared commit now keep
  their own distinct colors instead of blending together.
- The repo card branch badge now updates when the branch is switched outside
  DevDeck.

## [3.3.1] - 2026-07-07

### Fixed

- Services from WSL repositories now start correctly instead of immediately
  reporting that the process exited. Starting, stopping and log streaming for
  repos under `\\wsl.localhost\...` now work as intended.

## [3.3.0] - 2026-07-07

### Added

- Run services from repositories that live inside WSL: when a repo is opened
  from a `\\wsl.localhost\...` path, DevDeck now starts, installs, stops and
  runs its Docker Compose commands directly inside the Linux distribution,
  using the distro's own toolchain — and stops reliably kill the whole Linux
  process tree.
- Copy the current terminal selection with Ctrl+C.

### Changed

- The repository card's terminal menu now shows just the profile name, with the
  full command available as a tooltip.

## [3.2.1] - 2026-07-06

### Fixed

- Switching environments now updates the profile selector correctly: it loads
  that environment's last-used profile, or clears to "no profile" when none was
  remembered, instead of leaving the previous environment's profile selected.
- Switching environments in quick succession no longer risks ending up on the
  wrong environment's repositories and profile.

## [3.2.0] - 2026-07-05

### Added

- Environment drift protection: when a repo's environment file changes on disk
  after you've selected values from it, DevDeck now automatically clears that
  selection, so stale environment values are never applied.
- Settings dialog: application behavior and preferences now open in a dedicated
  dialog.
- Profiles: a native save dialog lets you choose exactly where to export, and
  import lets you pick the directory to clone into.
- Profiles: preview the per-repo changes a quick-save will make before saving,
  and when an import would overwrite existing settings, review a per-repo
  before→after diff first.

### Changed

- Launching DevDeck while it is already running now shows a styled in-app
  prompt instead of a native OS dialog.
- Docker Compose logs open in their own detached window; the full-history
  toggle moved into that window and the redundant auto-refresh toggle was
  removed.
- Refreshed default appearance: slate palette with no background pattern,
  neutral profile and expand buttons, and reordered, framed repo status and git
  badges. New installer icon.

### Fixed

- Enlarged the profile import dialog so its change preview fills the available
  space.
- Updated the application identifier to the new format.

## [3.1.0] - 2026-07-05

### Added

- Launch DevDeck automatically on OS login, toggled from Settings (Windows and
  Linux).
- Terminal button on each repo: open a clean shell in the repo, or pick a
  detected start command from a menu to run it in a fresh terminal.
- Live, detachable Docker Compose logs with per-service selection, so you can
  follow one service or the whole stack in its own window.
- Selective profile export: choose exactly which repos and which setting
  categories to export via a matrix, with an inline destination path picker.
- Working-tree changes view in the git window: see and diff your uncommitted
  changes alongside the commit history.
- App-wide right-click context menus and searchable tables throughout the
  dialogs (profiles, java manager, and more).
- Profile save confirmation now lists exactly which per-repo fields will be
  overwritten before you commit the change.

### Changed

- Tray icon now reflects app state at a glance with a tri-state "dd" monogram:
  idle, running, and error.
- Secondary windows (logs, terminals, git) now open on the monitor under the
  cursor instead of always on the primary display.
- The top bar shows the active profile name and only surfaces the quick-save
  button when there are unsaved changes.
- Repo cards received a design-coherence pass: badge separators, refined status
  tones, and cleaner environment-option handling.

### Fixed

- Git badges now appear instantly at startup instead of after the first poll.

## [3.0.0] - 2026-07-04

### Added

- Git history window per repository: a commit graph that draws every branch
  and merge as colored lanes — each line labeled with its branch name
  (derived from refs and merge messages, shown per commit and as a tooltip
  on the graph) — with filters for branch, author, message text, file path
  (searchable dropdown) and date range, plus paginated loading for large
  histories.
- Commit detail view: the files changed by a commit with per-file diffs, the
  full file contents as of that commit with syntax highlighting, the complete
  commit message, relative dates, a Copy SHA button and a "View on web" link
  that opens the commit on GitHub, GitLab, Bitbucket or any self-hosted forge.
- Compare view: pick any two branches (local or remote) to see the incoming
  commits between them and the full file-by-file diff — ideal for reviewing
  what a pull would bring in.
- Stash file viewer: every stash entry now has a "Files" button that opens
  its changed files with diffs, side by side, in its own window.
- Branch dialog: a per-branch "History" button that opens the graph scoped to
  that branch; branch and tag chips in the history are clickable and filter
  to that ref.
- "File history" jump: from any file in a commit's detail, see the full
  history of that file.
- Author avatars (Gravatar, with initials fallback) across all git views.

### Changed

- Branch management dialog is wider and its content now fills the window, so
  the per-branch action buttons fit on one row.
- Dangerous-environment marks refresh on repo cards immediately when toggled
  (no rescan needed), highlight only the selector box (not the dropdown
  list), and are now saved with the Save button instead of applying
  instantly.
- The History button on repo cards moved next to Merge.

### Removed

- The Flyway seeds button (and its backing command) — superseded by running
  seeds through the repo's own command profiles.

### Fixed

- Applying or importing profiles on Spring repositories that use
  `.properties` config files no longer fails with a write error (the content
  was being validated as YAML).
- Stash bookkeeping commits no longer appear in the commit history as if
  they were your own commits, and stash file lists no longer show every file
  duplicated.
- Selecting a branch that only exists on the remote no longer errors with
  "unknown revision" — it falls back to `origin/<branch>` automatically.
- Config-write error dialogs now include the underlying cause instead of a
  generic message.

## [2.1.0] - 2026-07-02

### Added

- Repos located inside WSL (added via `\\wsl.localhost\<distro>\...` or
  `\\wsl$\...` paths) now run all git operations — status badges, pull, fetch,
  branches, stash, clone — natively inside the distro. This makes git far
  faster for WSL repos and avoids antivirus scanning overhead. Repos on
  regular Windows drives are unaffected; no configuration needed — the repo
  path decides.

## [2.0.5] - 2026-07-01

### Fixed

- Hardened git operations so branch names and clone URLs that begin with a dash
  can no longer be misinterpreted as git command-line options.

## [2.0.4] - 2026-06-26

### Changed
- Reorder mode now collapses every card into a compact list and keeps cards
  collapsed while you rearrange them, so dragging is no longer interrupted by
  expanded panels.

### Fixed
- Deleting or renaming a start configuration now clears it from the repo's
  selector when it was the active one, instead of leaving a stale entry until
  the next workspace rescan.
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
