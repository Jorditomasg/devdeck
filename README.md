# DevDeck — DevOps Manager

DevDeck (product name: **DevOps Manager**) is a desktop app for managing and launching your
local development services from a single window. Point it at a workspace folder and it detects
each repository's type (Spring Boot, Angular, React, Nx, Maven, Docker Compose, …), then gives
you per-repo **start / stop / configure** controls, git operations, Docker Compose management,
live logs, and shareable profiles.

Built with **Tauri 2 (Rust core) + Angular 22**: Rust owns every side effect (process
supervision, git, filesystem, Docker), and Angular is a pure renderer over a typed IPC
contract.

## Features

- **Service supervision** — start, stop and restart dev services in their own process groups,
  with reliable cleanup; detached, per-service live log windows.
- **Config-driven detection** — repository types are described by YAML; adding a framework is
  a new YAML file, not a code change.
- **Git operations** — branch badges, pull, merge (with revert points), stash management and
  branch management, all from the repo card.
- **Docker Compose** — bring services up/down and watch their status per repo.
- **Profiles** — snapshot a whole workspace setup (branches, env files, selections) and share
  or restore it.
- **Interactive terminals** — open a real PTY terminal scoped to any repository.
- **Bilingual UI** — English and Spanish.

## Prerequisites

- **Node.js** `^22.22.3 || ^24.15.0 || ^26.0.0` + npm
- **Rust** stable toolchain ([`rustup`](https://rustup.rs))
- **Windows**: Microsoft C++ Build Tools + WebView2 (preinstalled on Windows 10/11). The NSIS
  installer toolchain is fetched automatically by the Tauri bundler.
- **Linux**: `webkit2gtk-4.1`, `libappindicator3` (tray), `librsvg2` and build essentials —
  see the [Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/).

## Development

```bash
npm install              # once
npm run tauri dev        # full app: Angular dev server (:4200) + Rust core + native window
```

Other scripts:

```bash
npm start                # Angular dev server only (http://localhost:4200, no Rust backend)
npm run build            # Angular production build
npm run tauri build      # platform installer (NSIS on Windows)
```

## Tests

```bash
npm test                                              # frontend unit tests (vitest)
npm run build && cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests
```

## Build & release

Releases are built, signed (SignPath) and published by
[`.github/workflows/build-and-sign.yml`](.github/workflows/build-and-sign.yml).

Bump the version in **all three** files (the installer filename embeds the
`tauri.conf.json` version, not the tag):

1. `package.json`
2. `src-tauri/tauri.conf.json` (`version`)
3. `src-tauri/Cargo.toml`

Then push a tag to trigger the release:

```bash
git tag v0.9.0
git push origin v0.9.0
```

## Project structure

```
src/                  Angular app
  app/core/ipc/       typed invoke/event wrappers — the ONLY @tauri-apps/api import site
  app/core/state/     signal stores (repos, services, profiles, settings)
  app/core/i18n/      translation service + t pipe
  app/features/       container components: workspace screen + dialogs
  app/ui/             atomic presentational components (inputs/outputs only)
  assets/i18n/        en.json / es.json translation catalogs

src-tauri/src/        Rust core (each module documents itself in its //! header)
  domain/             pure types (no tauri/tokio)
  config/             app-config store, env-file writers, repo-types loader, v1 migrator
  detection/          repo-type YAML matching engine
  process/            spawn / stream / supervise / kill child processes
  git/                git CLI adapter (badges, branches, merge, stash, branch ops)
  java/               JDK discovery + JAVA_HOME/PATH injection
  profiles/           profile snapshot build / apply / import-export
  docker/             docker compose adapter
  terminal/           interactive PTY backend
  commands/           Tauri command handlers (validate, call module, map error)
  lib.rs              composition root: plugins, state, handler registration, tray

config/repo-types/    repo-type YAML definitions, bundled as resources
```

## Config locations

All persistence lives in OS-standard directories (never in the install dir):

| What | Windows | Linux |
|---|---|---|
| App config | `%APPDATA%\devops-manager\` | `~/.config/devops-manager/` |
| Repo-type overrides | `%APPDATA%\devops-manager\repo-types\` | `~/.config/devops-manager/repo-types/` |
| Profiles | `%APPDATA%\devops-manager\profiles\` | `~/.local/share/devops-manager/profiles/` |

Repo-type YAML files dropped in the override dir are merged over the bundled set by `type` id
(same id replaces a bundled definition; new files add types) — no code changes needed.

## Migrating from v1

DevDeck is the successor to the Python/customtkinter app at
[Jorditomasg/devops-manager](https://github.com/Jorditomasg/devops-manager). On first launch,
if no config exists yet, it automatically migrates v1 data
(`devops_manager_config.json` + `.devops-profiles/`) into the OS directories above. The
migration is **read-only** — your v1 files are left untouched.
