# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**DevDeck** is a Tauri 2 desktop app for managing and launching multiple development services (Spring Boot, Angular, React, Nx, Maven, Docker Compose) from a single interface. It scans a workspace directory, detects repository types via config-driven YAML rules, and provides start/stop/configure controls per repo, with git badges, profiles, docker compose management and detached log windows. Since v3 it also ships a per-repo **git window**: a labeled branch-lane commit graph with filters and per-file diffs, a compare view, and a stash file viewer (design doc `docs/superpowers/specs/2026-07-02-git-suite-design.md`).

DevDeck is a standalone app with no legacy/migration obligations — do NOT add compatibility code for its Python predecessor (devops-manager); that chapter is closed. Historical design docs live in `docs/migration/`; the IPC contract (`docs/migration/ipc-contract.md`) is the one document there that remains normative.

## Stack

- **Rust core** (`src-tauri/`): ALL side effects — process supervision (tokio), repo detection, git (CLI shell-outs), java discovery, profiles, docker compose, config persistence in OS dirs, tray, single-instance.
- **Angular 22 frontend** (`src/`): zoneless, signals, standalone components, strict TS. Pure UI over a typed IPC contract — no business logic.
- **IPC**: 101 commands + 7 events, documented in `docs/migration/ipc-contract.md` (the authoritative count assertion lives in `src/app/core/ipc/commands.spec.ts`). The Rust command names are snake_case; arg keys camelCase on the wire. Error envelope: `{ kind, message }`.

## Commands

```bash
npm install              # once; commit lockfiles if they change
npm start                # Angular dev server (port 4200)
npm run tauri dev        # full app in dev mode (native Windows recommended)
npm run build            # Angular production build
npm test                 # frontend specs (vitest)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests (needs npm run build first)
npm run tauri build      # NSIS installer (src-tauri/target/release/bundle/nsis/)
```

Cross-compiling the Windows exe from WSL works via `cargo-xwin` (see the engram memory `migration/build-recipe` or `docs/migration/STATUS.md`).

## Architecture rules (non-negotiable)

- **Layering**: `src/app/core/` (typed IPC wrappers, signal stores, i18n runtime) → `src/app/ui/` (pure presentational atoms/molecules, zero store/IPC imports) → `src/app/features/` (containers that inject stores and translate ALL text). Containers translate; presentational components receive plain inputs/outputs.
- **No ESM cycles**: `dialog-base.ts` must NEVER import `dialog.service.ts` (it injects the `DIALOGS` token from `dialog-stack.ts`; the alias lives in `app.config.ts`). A static cycle here shipped a blank-window crash once ("class extends value undefined"). Run `npx madge --circular --extensions ts src/app` before structural changes.
- **Wire names live in one place**: `core/ipc/commands.ts` (`CMD`) and `core/ipc/events.ts` (`EVT`) mirror `src-tauri/src/events.rs` and the `#[tauri::command]` fns registered in `lib.rs`. Update contract doc + both sides + the count assertions in `commands.spec.ts`/`events.spec.ts` together.
- **Window handlers are main-only**: `on_window_event` in `lib.rs` early-returns for non-`"main"` labels — detached log/terminal/git windows (`log-*`, `term-*`, `git-*`) must close/minimize normally. `frontend_ready` no-ops for non-main windows.
- **i18n**: every user-visible string via `t('key')` / `| t` pipe; keys in `src/assets/i18n/{en,es}.json` — the two files MUST keep identical key structure (CI-able check: recursive key-set compare).
- **Timing constants** (do not lower): git badge poll 30 s with concurrency cap 3 (ONE semaphore shared between poller and on-demand queries), docker poll 15 s, profile dirty debounce 300 ms, log caps 500/service + 1000 global.
- **Repo detection is config-driven**: adding a framework = adding a YAML under `config/repo-types/` (bundled as Tauri resource; user overrides in the OS config dir). No code changes.

## Key implementation notes

- Processes spawn in their OWN process group (Unix `process_group(0)`, Windows `CREATE_NO_WINDOW` + job-style `taskkill /F /T`); stop escalates stop_cmd → SIGTERM (10 s) → SIGKILL (5 s). This escalation is deliberate (kills whole process trees reliably) — do not "simplify" it.
- Config lives in the OS config dir (`dirs::config_dir()/devdeck/`), profiles in `dirs::data_dir()/devdeck/profiles/`.
- Detached log windows: `open_log_window` creates a `log-<id>` webview loading `?log=<serviceId>`; backlog comes from the Rust `LogCache` (fed by the event emitter), live lines from `service://log-line`. Capability `windows` includes `"log-*"`.
- Git window (v3): `open_git_window` creates `git-<repoId>` loading `?git=<repoId>` (+ optional `branch`/`tab`/`stash` view params). Backend queries live in `src-tauri/src/git/history.rs` (8-field log format incl. `%S` source; first-parent diffs — NEVER `diff-tree -m`, multi-parent commits duplicate sections); every read shares the badge semaphore. Frontend graph: `git-window/graph.ts` (lane algorithm, branch-identity labels/colors, linear mode when author/text/path/date filters fragment topology). CodeMirror is imported DIRECTLY by its consumers, never re-exported from the `ui` barrel (initial-bundle budget).
- `Cargo.lock` pins `time 0.3.47` — 0.3.48 breaks `cookie 0.18.1` (E0119). Do not blindly `cargo update`.
- Git auto-routes per repo path (Windows only): a repo under `\\wsl.localhost\<distro>\...` (or `\\wsl$`) runs git INSIDE the distro via `wsl.exe -d <distro> --cd <path> --exec git` (`git/exec.rs`); `--exec` is mandatory (no shell → no injection). Everything else uses Windows git unchanged. Start/stop of services does NOT route through WSL — that is a separate future feature with its own kill path.

## Git workflow

- **Work directly on `master`. Do NOT create feature branches.** Commit straight
  to master (the harness default of "branch first on the default branch" does
  NOT apply to this repo). This overrides any generic branch-first guidance.

## Versioning & changelog (Claude-owned)

DevDeck versioning is driven by Claude, not by hand. Rules:

- **Single source of truth:** `CHANGELOG.md` at the repo root, in
  [Keep a Changelog](https://keepachangelog.com) format. SemVer. The current
  baseline is `1.0.0`.
- **When to write entries:** only at release time (when the user asks for a
  version bump), NOT per commit. Do not maintain an `[Unreleased]` section
  between releases.
- **Entries are user-facing and in English.** Describe the change from the
  user's point of view ("Auto-update from within the app"), never the
  implementation ("refactor updater module"). Group under
  `### Added / Changed / Fixed / Removed`.
- **Release ritual** (run when the user says e.g. "release 1.1.0" / "minor"):
  1. `git log <last-tag>..HEAD` → draft the user-facing entries.
  2. Bump the THREE version files in lockstep: `package.json`,
     `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
  3. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
  4. Conventional commit, then `git tag vx.y.z`. Do NOT push the tag — the user
     pushes it; the tag push triggers the signed-release CI.
- The `/release` skill automates this ritual.

## Releasing

Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then push a `v*` tag. CI builds the NSIS installer, signs it via SignPath and publishes a GitHub Release (`.github/workflows/build-and-sign.yml`). One-time SignPath setup is documented in the workflow file and `docs/migration/ci-v2.md`.
