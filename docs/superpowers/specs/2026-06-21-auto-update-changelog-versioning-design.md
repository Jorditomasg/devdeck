# Design: Auto-update, Changelog & Claude-owned Versioning

**Date:** 2026-06-21
**Status:** Approved (pending spec review)
**Scope:** DevDeck (this repo only)

## Problem

DevDeck currently ships as a SignPath-signed NSIS installer published to GitHub
Releases, but the running app has no way to know a newer version exists, no way
to update itself, and no user-facing record of what changed between versions.
There is also no versioning discipline: `0.9.0` is set in three files by hand
and no git tags exist.

We want three things, all owned/driven by Claude:

1. An in-app **"Update now"** button that appears when a newer version is
   detected, downloads and installs the update, and restarts.
2. An in-app **changelog** showing the full history of user-facing changes.
3. A **versioning workflow** where Claude maintains `CHANGELOG.md` and performs
   version bumps + tags, starting at **1.0.0**.

## Decisions (locked during brainstorming)

| Decision | Choice | Why |
|----------|--------|-----|
| Update mechanism | `tauri-plugin-updater` (auto download + install + restart) | The one-click experience requested; standard Tauri 2 path. |
| Changelog source | Single `CHANGELOG.md` (Keep a Changelog + SemVer) bundled as a Tauri resource | One source of truth Claude owns; works offline; feeds `latest.json` notes. |
| Automation level | Project-scoped CLAUDE.md rule + `/release` skill. **No hook.** | Low friction; release-time only, not per-change. |
| Changelog write trigger | On version bump only (release-time), not entry-by-entry | User preference: "que lo haga cuando haya cambio de versión". |
| Update logic placement | Rust commands/events (not raw JS plugin calls) | Honors the "ALL side effects in Rust" + typed IPC contract rules. |
| Starting version | `1.0.0` | User decision; `0.9.0` recorded as the pre-1.0 baseline. |

## Architecture

Four components with clear boundaries; the frontend stays pure UI over the
typed IPC contract.

```
CI (sign + manifest)  ──>  GitHub Release ( *-setup.exe  +  latest.json )
                                   ^                          |
                                   | endpoint                 v
        updater Rust (check/install)  <── reads ── tauri.conf.json (pubkey)
                 │  emits update://progress
                 v
        UI: settings-dialog "About / Updates"
                 ^
                 │ get_changelog (structured)
        changelog Rust (parse CHANGELOG.md resource)
```

### Component 1 — Versioning & CHANGELOG (Claude-owned)

- **Format:** Keep a Changelog + SemVer. Sections per version with
  `### Added / Changed / Fixed / Removed`, written in **English**, phrased for
  end users ("Auto-update from within the app", not "refactor updater module").
- **Single source of truth:** `CHANGELOG.md` at repo root.
- **Release ritual** (triggered when the user asks for a release, e.g.
  "saca la 1.1.0" / "release minor"):
  1. Review `git log <last-tag>..HEAD`; draft user-facing English entries.
  2. Bump the **three** version files in lockstep: `package.json`,
     `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
  3. Add `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
  4. Conventional commit + `git tag vx.y.z`. **The user pushes the tag** (push
     triggers CI). Claude does not push unless asked.
- **Contract documented** in the project `CLAUDE.md` so future sessions comply.

### Component 2 — Update infrastructure (CI + keys)

- Add `tauri-plugin-updater`. In `tauri.conf.json`:
  - `plugins.updater.pubkey`: embedded minisign **public** key.
  - `plugins.updater.endpoints`:
    `https://github.com/Jorditomasg/devdeck/releases/latest/download/latest.json`
    (permanent URL → always the newest release's manifest).
- **Key generation (one-time):** minisign keypair via the Tauri signer.
  - Private key → repo secret `TAURI_SIGNING_PRIVATE_KEY`
    (+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if set).
  - Public key → `tauri.conf.json`.
- **CI ordering — the critical detail.** The minisign signature MUST be computed
  over the **SignPath-signed** `.exe`, not the build output. In the
  `sign-and-release` job, after SignPath returns the signed installer:
  1. SignPath signs the `.exe` (existing step).
  2. `tauri signer sign` signs that signed `.exe` with the minisign key →
     produces the `signature`.
  3. Generate `latest.json` (version, pub date, asset download URL, signature,
     and **notes extracted from the new version's `CHANGELOG.md` section**).
  4. Publish to the Release: signed `.exe` **and** `latest.json`.
- This avoids the classic failure where the updater verifies the downloaded
  (SignPath-signed) binary against a signature taken over the unsigned one.
- Build job does **not** set the signing key (so `tauri build` does not emit a
  premature/wrong `.sig`).

### Component 3 — Update logic (Rust)

- New `#[tauri::command]`s (snake_case): `check_for_update`, `install_update`.
  - `check_for_update` → `{ available: bool, version, notes }` (envelope
    `{ kind, message }` on error).
  - `install_update` → downloads + installs, emits progress, triggers relaunch.
- New event `update://progress` → `{ downloaded, contentLength }`.
- Register the plugin in `lib.rs`; add `updater:default` to
  `capabilities/default.json`.
- Update `core/ipc/commands.ts` (`CMD`), `core/ipc/events.ts` (`EVT`), the
  contract doc `docs/migration/ipc-contract.md`, and the **count assertions** in
  `commands.spec.ts` / `events.spec.ts` together (non-negotiable rule).

### Component 4 — Changelog logic (Rust → UI)

- New `#[tauri::command] get_changelog` → reads the bundled `CHANGELOG.md`
  resource and parses the (regular) Keep a Changelog structure into:
  `[{ version, date, added[], changed[], fixed[], removed[] }]`.
- Parsing in Rust; **no markdown library** added to the zoneless/strict
  Angular frontend.
- Bundle `CHANGELOG.md` via `tauri.conf.json` `bundle.resources`.

### Component 5 — UI (settings-dialog, i18n)

- In `src/app/features/dialogs/settings/`, an **"About / Updates"** section:
  - Current version, **"Check for updates"** button.
  - On new version detected → banner with notes + **"Update now"** (progress bar
    fed by `update://progress`, then install + restart).
  - **"View changelog"** → renders the full structured history.
- Silent check **once on startup** + manual button.
- All strings via `t('...')`; new keys added to **both** `en.json` and
  `es.json` with identical structure.

## Data flow

1. App start → `check_for_update` (silent). If newer → store flag, surface in
   settings UI.
2. User opens settings → sees current version, update banner (if any), changelog
   link.
3. "Update now" → `install_update` → `update://progress` events → relaunch.
4. "View changelog" → `get_changelog` → structured render.

## Error handling

- All Rust commands return the standard `{ kind, message }` error envelope.
- Update check failures (offline, rate limit, manifest missing) are **non-fatal
  and silent on startup**; the manual button surfaces the error inline.
- Signature verification failure → update aborts with a clear message; never
  installs an unverified binary.
- Changelog parse failure → UI shows a graceful "changelog unavailable" state.

## Testing

- **Rust:** unit-test the Keep a Changelog parser (well-formed, missing
  sections, empty changelog, malformed headers). Update-command logic guarded by
  the plugin; cover the parse/envelope mapping.
- **Frontend (vitest):** `commands.spec.ts` / `events.spec.ts` count assertions
  updated; settings component renders update banner and changelog states from
  mocked IPC.
- **i18n:** existing recursive key-set compare between `en.json` / `es.json`
  must stay green.
- **CI:** first tagged release (`v1.0.0`) is the end-to-end verification that
  `latest.json` + signed `.exe` publish correctly and a prior build can update.

## Out of scope (YAGNI)

- Delta/differential updates.
- Update channels (beta/stable).
- Rollback UI.
- macOS/Linux updater artifacts (Windows NSIS only, matching current bundle).
- Hook-based enforcement of changelog entries.

## Risks & mitigations

- **Key loss:** losing `TAURI_SIGNING_PRIVATE_KEY` breaks the update chain for
  all installed clients. Mitigation: store the private key securely outside CI
  as well (password manager), document in the workflow file.
- **CI signing order regression:** if someone moves minisign signing back into
  the build job, updates silently fail verification. Mitigation: comment the
  ordering constraint inline in the workflow, note it in `CLAUDE.md`.
- **First-release bootstrap:** `latest.json` endpoint 404s until the first
  release publishes one. Mitigation: startup check treats 404 as "no update".
