# DevDeck

**Your whole local dev environment, in one window.**

DevDeck is a desktop app that turns a folder full of repositories into a control panel. Point
it at your workspace and it figures out what each repo is (Spring Boot, Angular, React, Nx,
Maven, Docker Compose, …) and gives you a card for each one with **start / stop / configure**
buttons, live git status, Docker Compose controls, log windows, and shareable profiles — no
more juggling a dozen terminals.

## What you get

- **Service supervision** — start, stop and restart dev services with a live status indicator.
  Each service runs in its own process group with reliable cleanup, so nothing is left
  dangling when you stop it.
- **Detached log windows** — open a live log window per service and drag it to a second
  monitor.
- **Git at a glance** — branch badges and status on every card; pull, merge (with revert
  points), stash and switch branches without leaving the app.
- **Docker Compose** — bring a repo's compose services up or down and watch their status.
- **Interactive terminals** — open a real PTY terminal scoped to any repository.
- **Profiles** — snapshot your whole setup (selected branches, env files, which services are
  running) and restore or share it later.
- **Config-driven detection** — repository types are described by YAML. Adding support for a
  new framework is a new YAML file, not a new build. Recognised out of the box:
  Spring Boot, Angular, React, Nx workspace, Maven library, Go, Rust, Python,
  Laravel, CodeIgniter, and Docker Compose infra.
- **Bilingual UI** — English and Spanish.

## Install

You don't need to build anything — just download the installer and run it.

1. **Download** the latest `DevDeck_<version>_x64-setup.exe` from the
   [Releases page](https://github.com/Jorditomasg/devdeck/releases).
2. **Run it.** The installer isn't code-signed, so Windows SmartScreen may warn about an
   "unknown publisher" — click **More info → Run anyway** to continue.
3. **Launch DevDeck** and, on first run, **pick your workspace folder** — the directory that
   holds your project repositories.

DevDeck updates itself: when a new version is released, the app detects it and installs the
update from within DevDeck — no need to re-download manually.

DevDeck scans the folder and shows one **card per repository**. From each card you can start,
stop and restart the service, open a live log window, run git operations, bring Docker Compose
services up or down, and open a terminal scoped to that repo. Save a **profile** to snapshot
your whole setup and restore it later.

## Config locations

All persistence lives in OS-standard directories — never in the install dir, so uninstalling
or reinstalling never touches your data.

| What | Windows | Linux |
|---|---|---|
| App config (`config.json`) | `%APPDATA%\devdeck\` | `~/.config/devdeck/` |
| Repo-type overrides | `%APPDATA%\devdeck\repo-types\` | `~/.config/devdeck/repo-types/` |
| Profiles | `%APPDATA%\devdeck\profiles\` | `~/.local/share/devdeck/profiles/` |

Drop a repo-type YAML file into the **overrides** dir to add or replace a detection rule: the
files there are merged over the bundled set by `type` id (same id replaces a bundled
definition, a new id adds a type) — no code changes, no rebuild.
