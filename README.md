# DevDeck — DevOps Manager v2

DevDeck (product name: **DevOps Manager**) is the **Tauri 2 (Rust core) + Angular 22
(zoneless, signals)** rewrite of the Python/customtkinter app at
[Jorditomasg/devops-manager](https://github.com/Jorditomasg/devops-manager). It scans a
workspace, detects repository types from YAML definitions, and provides start/stop/configure
controls, git operations, Docker Compose management, and shareable profiles — same product,
new shell: Rust owns every side effect (processes, git, filesystem), Angular is a pure
renderer over a typed IPC contract. The Python version is now **v1 / maintenance-only**; see
the [migration guide](docs/migration/migration-guide.md).

The migration contract lives in [`docs/migration/`](docs/migration/):

- [`architecture-v2.md`](docs/migration/architecture-v2.md) — approved architecture (read first)
- [`ipc-contract.md`](docs/migration/ipc-contract.md) — authoritative command/event contract
- [`ci-v2.md`](docs/migration/ci-v2.md) — release pipeline
- [`STATUS.md`](docs/migration/STATUS.md) — engineering status and first-build checklist
- `inventory-backend.md` / `inventory-config-ci.md` / `inventory-gui.md` — exhaustive v1 behavior

## Prerequisites

- **Node.js** `^22.22.3 || ^24.15.0 || ^26.0.0` + npm (Angular 22 requirement,
  verified against <https://angular.dev/reference/versions>)
- **Rust** stable toolchain ([`rustup`](https://rustup.rs)) — MSRV follows the `tauri 2.11` crate
- **Windows**: Microsoft C++ Build Tools + WebView2 (preinstalled on Win 10/11).
  NSIS is downloaded automatically by the Tauri bundler.
- **Linux**: `webkit2gtk-4.1`, `libappindicator3` (tray), `librsvg2`, build essentials —
  see the [Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/).

### WSL note

The repository may live on a Windows drive (`/mnt/c/...`) and be edited from WSL, but
**run the dev loop natively on Windows** (PowerShell/CMD): the app must spawn Windows
processes (`mvn`, `npm`, `docker`, `taskkill`) and show a native window. Building the
Windows target from WSL is not supported by Tauri. WSL is fine for editing, linting and
pure-Rust unit tests.

## Dev workflow

```bash
cd v2
npm install              # once
npm run tauri dev        # full app: Angular dev server (:4200) + Rust core + native window
```

Other scripts from `package.json`:

```bash
npm start                # Angular dev server only (http://localhost:4200, no Rust)
npm run build            # Angular production build → dist/devops-manager/browser
npm run tauri build      # NSIS installer (Windows) via bundle.targets
```

## Tests

```bash
# Rust unit tests — build the frontend ONCE first
# (tauri-build validates that frontendDist exists)
npm run build
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend type check
npx tsc -p tsconfig.app.json --noEmit

# Frontend unit tests (vitest, node environment — specs are TestBed-free)
npm test
```

Frontend specs (`src/**/*.spec.ts`) are written **vitest-style** (TestBed-free, import from
`vitest`); the runner is wired via `vitest.config.ts` (`environment: 'node'` — no DOM use in
specs) and the `test` script.

TypeScript is pinned `~6.0.0` — the Angular 22 peer range is `>=6.0.0 <6.1.0`
(verified against <https://angular.dev/reference/versions>); do NOT downgrade to 5.9.x,
that is the Angular 21 range.

## Build & release

Releases are built, signed (SignPath) and published by
[`.github/workflows/v2-build-and-sign.yml`](../.github/workflows/v2-build-and-sign.yml) —
full details in [`docs/migration/ci-v2.md`](docs/migration/ci-v2.md).

Before tagging `v2.x.y`, bump the version in **all three** files (there is no auto-stamping;
the installer filename embeds the `tauri.conf.json` version, not the tag):

1. `package.json`
2. `src-tauri/tauri.conf.json` (`version`)
3. `src-tauri/Cargo.toml`

```bash
git tag v2.0.1
git push origin v2.0.1
```

## Project structure

```
src/                  Angular app
  app/core/ipc/       typed invoke/event wrappers — the ONLY @tauri-apps/api import site
  app/core/state/     signal stores (repos, services, profiles, settings)
  app/core/i18n/      translation service (flat dot-keys, en fallback) + t pipe
  app/features/       container components: workspace screen (topbar, global panel,
                      repo cards, statusbar) + dialogs (clone, settings, profile, merge,
                      docker, groups, config editor, …)
  app/ui/             atomic presentational components (inputs/outputs only, no store/ipc)
  styles/             styles.scss + _tokens.scss / _base.scss / _mixins.scss (design tokens)
  assets/i18n/        en.json / es.json translation catalogs

src-tauri/src/        Rust core (each module documents itself in its //! header)
  domain/             pure types: RepoInfo, RunningService, ServiceStatus, … (no tauri/tokio)
  config/             app-config JSON store, env-file writers, repo-types loader, v1 migrator
  detection/          repo-type YAML matching engine (the single unified detector)
  process/            spawn/stream/supervise/kill — the only generic child-process module
  git/                git CLI adapter (badge poll, branches, merge pipeline + revert)
  java/               JDK discovery + JAVA_HOME/PATH env injection
  profiles/           profile snapshot build/apply/import-export
  docker/             docker compose adapter (parse/up/down/status poll)
  commands/           Tauri command handlers — thin: validate, call module, map AppError
  events.rs           event name constants + payload structs (IPC source of truth)
  state.rs            AppState (managed by tauri::Builder)
  lib.rs              composition root: plugins, state, handler registration, tray, migration

config/repo-types/    repo-type YAML definitions, bundled as Tauri resources
```

## Config locations

All persistence lives in OS-standard directories (never in the install dir):

| What | Path | Windows | Linux |
|---|---|---|---|
| App config (`config.json`) | `<config_dir>/devops-manager/` | `%APPDATA%\devops-manager\` | `~/.config/devops-manager/` |
| Repo-type overrides | `<config_dir>/devops-manager/repo-types/` | `%APPDATA%\devops-manager\repo-types\` | `~/.config/devops-manager/repo-types/` |
| Profiles | `<data_dir>/devops-manager/profiles/` | `%APPDATA%\devops-manager\profiles\` | `~/.local/share/devops-manager/profiles/` |
| Logs | tauri-plugin-log default dir | `%LOCALAPPDATA%\es.orizon.devops-manager\logs\` | `~/.local/share/es.orizon.devops-manager/logs/` |

Repo-type YAML files dropped in the override dir are merged over the bundled set by `type` id
(same id replaces the bundled definition; new files add types) — no code changes needed.

## v1 data migration

On first launch, if no v2 `config.json` exists, the Rust core automatically migrates v1 data
(`devops_manager_config.json` + `.devops-profiles/`) into the OS directories above. The
migration is **read-only** — v1 files are left untouched. Normalizations include folding the
Spanish sentinel values v1 persisted as magic strings (`"- Sin Seleccionar -"` → key dropped,
`"Sistema (Por Defecto)"` → `null`); the reader keeps accepting both sentinels forever, so
profiles exported from v1 import cleanly at any time. The migration can also be re-pointed at
an explicit folder via the `migrate_from_v1 { v1Root }` command. Details:
[`architecture-v2.md` §6](docs/migration/architecture-v2.md).

## Pinned versions (verified 2026-06-10)

| Package | Version | Source |
|---|---|---|
| Angular (`@angular/*`) | `^22.0.0` (core 22.0.1 at pin time) | npm registry |
| TypeScript | `~6.0.0` (Angular 22 peer range `>=6.0 <6.1`) | npm registry |
| `@tauri-apps/api` / `@tauri-apps/cli` | `^2.11.0` | npm registry |
| `tauri` crate | `2.11` (features: `tray-icon`, `image-ico`, `image-png`) | crates.io |
| `tauri-build` | `2.6` | crates.io |
| `tauri-plugin-single-instance` | `2.4` | crates.io |
| `tauri-plugin-dialog` | `2.7` | crates.io |
| `tauri-plugin-opener` | `2.5` | crates.io |
| `tauri-plugin-log` | `2.8` | crates.io |
| `serde_yaml_ng` | `0.10` | crates.io |

Notes:

- **zone.js is intentionally absent** — the app is zoneless
  (`provideZonelessChangeDetection()`, no `polyfills` entry in `angular.json`).
- **`serde_yaml_ng`** replaces the archived `serde_yaml`. The `serde_yml` fork was
  rejected (maintenance-quality concerns); `serde_yaml_ng` is API-compatible.
- **Icons**: `src-tauri/icons/` only has `icon.ico` (v1 `icon_red.ico`) and
  `icon-green.ico` (tray "running" state). Generate the full multi-size PNG/ICNS set
  before the first build: `npm run tauri icon src-tauri/icons/icon.ico`.
- No build has ever been run against these pins — see
  [STATUS.md](docs/migration/STATUS.md) for what remains unverified.
