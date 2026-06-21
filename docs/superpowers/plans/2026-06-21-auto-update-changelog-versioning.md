# Auto-update, Changelog & Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an in-app auto-updater (check + one-click install), an in-app changelog view, and a Claude-owned versioning workflow starting at 1.0.0.

**Architecture:** A single root `CHANGELOG.md` (Keep a Changelog + SemVer) is the source of truth, bundled as a Tauri resource. Rust owns all side effects — a pure changelog parser, plus `tauri-plugin-updater` wrapped in three typed commands (`check_for_update`, `install_update`, `get_changelog`) and one event (`update://progress`). The Angular frontend stays pure UI over the typed IPC contract. CI signs the SignPath-signed installer with the updater's minisign key and publishes `latest.json`.

**Tech Stack:** Tauri 2.11, `tauri-plugin-updater` 2.x, Rust (tokio, serde), Angular 22 (zoneless, signals), vitest, GitHub Actions + SignPath.

**Branch policy:** Work directly on `master` (user instruction). No feature branch.

---

## File Structure

**Created:**
- `CHANGELOG.md` — root, Keep a Changelog source of truth.
- `src-tauri/src/changelog/mod.rs` — pure Keep-a-Changelog parser (no IO, unit-tested).
- `src-tauri/src/commands/updates.rs` — `check_for_update`, `install_update`, `get_changelog` (thin command layer, §2.9).
- `src/app/core/state/updates.store.ts` — signal store: update availability, progress, changelog cache.
- `src/app/core/state/updates.store.spec.ts` — store specs.
- `src/app/features/dialogs/changelog/changelog-dialog.component.ts` — full changelog view.
- `.claude/skills/release/SKILL.md` — the `/release` versioning skill.

**Modified:**
- `src-tauri/Cargo.toml` — add `tauri-plugin-updater`.
- `src-tauri/tauri.conf.json` — `plugins.updater`, `bundle.createUpdaterArtifacts`, bundle `CHANGELOG.md` resource.
- `src-tauri/src/lib.rs` — `pub mod changelog;`, register updater plugin, register 3 commands.
- `src-tauri/src/commands/mod.rs` — `pub mod updates;` + doc.
- `src-tauri/src/events.rs` — `UPDATE_PROGRESS` constant.
- `src/app/core/ipc/commands.ts` — 3 `CMD` entries + `updates` wrapper group.
- `src/app/core/ipc/events.ts` — `EVT.updateProgress` + `onUpdateProgress`.
- `src/app/core/ipc/tauri.types.ts` — `UpdateInfo`, `ChangelogRelease`, `UpdateProgressEvent`.
- `src/app/core/ipc/commands.spec.ts` — count 76 → 79.
- `src/app/core/ipc/events.spec.ts` — count 7 → 8.
- `src/app/features/dialogs/settings/settings-dialog.component.ts` — "About / Updates" section.
- `src/assets/i18n/en.json` + `src/assets/i18n/es.json` — new keys (identical structure).
- `.github/workflows/build-and-sign.yml` — minisign signing + `latest.json` publish.
- `CLAUDE.md` — versioning/changelog rule.
- `docs/migration/ipc-contract.md` — §2.9 + event.

---

## Task 1: Create the CHANGELOG.md baseline

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: Write the file**

```markdown
# Changelog

All notable changes to DevDeck are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-21

### Added
- In-app automatic updates: DevDeck now detects new versions, shows what
  changed, and installs the update with a single click.
- Changelog viewer: browse the full history of changes from inside the app.

### Changed
- First stable release. Promotes the 0.9.0 preview to 1.0.0.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG.md with 1.0.0 baseline"
```

---

## Task 2: Add the versioning rule to CLAUDE.md and the /release skill

**Files:**
- Modify: `CLAUDE.md` (append a new section before "## Releasing")
- Create: `.claude/skills/release/SKILL.md`

- [ ] **Step 1: Add the rule block to `CLAUDE.md`**

Insert this section immediately above the existing `## Releasing` heading:

```markdown
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
```

- [ ] **Step 2: Create the `/release` skill**

```markdown
---
name: release
description: Cut a DevDeck release — bump the three version files, write the user-facing English CHANGELOG entry, commit and tag. Trigger when the user asks to release a version, bump the version, or "saca la x.y.z".
---

# Release DevDeck

Run this when the user asks for a release (e.g. "release 1.1.0", "minor bump").

## Steps

1. **Determine the new version.** If the user gave an explicit version, use it.
   Otherwise infer the bump (major/minor/patch) from the changes and confirm
   with the user before proceeding. Read the current version from
   `package.json`.

2. **Gather changes.** Run `git describe --tags --abbrev=0` to find the last
   tag (if none, use the first commit). Run `git log <last-tag>..HEAD --oneline`
   and read the diff highlights. Translate them into USER-FACING English bullet
   points grouped under `### Added / Changed / Fixed / Removed`. Drop purely
   internal changes (refactors, test-only, CI) unless they affect users.

3. **Bump the three version files** to the new version, in lockstep:
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`

4. **Update `CHANGELOG.md`.** Insert a new section at the top of the version
   list: `## [x.y.z] - YYYY-MM-DD` (today's date) with the grouped bullets.

5. **Commit** with a conventional message:
   `git commit -am "chore(release): vx.y.z"`.

6. **Tag**: `git tag vx.y.z`. STOP. Tell the user to push the tag
   (`git push origin vx.y.z`) when ready — the push triggers the signed-release
   pipeline. Do NOT push automatically.

## Rules
- English, user-facing changelog entries only.
- Never skip a version file — a mismatch breaks the build and the updater.
- Date format `YYYY-MM-DD`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .claude/skills/release/SKILL.md
git commit -m "docs: add Claude-owned versioning rule and /release skill"
```

---

## Task 3: Generate the updater keypair and configure Tauri

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Generate the minisign keypair (manual, no password for CI simplicity)**

Run (writes the private key OUTSIDE the repo):

```bash
npx tauri signer generate -w "$HOME/.tauri/devdeck.key" -p ""
```

Expected: prints a **public key** (base64) and writes `~/.tauri/devdeck.key`
(private) + `~/.tauri/devdeck.key.pub`.

> ⚠ **HUMAN STEPS — do not automate, do not commit the private key:**
> 1. Copy the contents of `~/.tauri/devdeck.key` into a new GitHub Actions repo
>    secret named `TAURI_SIGNING_PRIVATE_KEY`.
> 2. Store the private key in a password manager as backup. Losing it makes it
>    impossible to ship updates to installed clients.
> 3. Keep the public key string for Step 3.

- [ ] **Step 2: Add the updater plugin to `src-tauri/Cargo.toml`**

Add this line to `[dependencies]`, right after the `tauri-plugin-log` line:

```toml
tauri-plugin-updater = "2.9"
```

- [ ] **Step 3: Configure the updater in `src-tauri/tauri.conf.json`**

Set `bundle.createUpdaterArtifacts` to `true` and add the `CHANGELOG.md`
resource. Replace the `bundle` block's `resources` and add the flag:

```json
  "bundle": {
    "active": true,
    "createUpdaterArtifacts": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"],
    "publisher": "Jorditomasg",
    "resources": {
      "../config/repo-types/": "config/repo-types/",
      "../CHANGELOG.md": "CHANGELOG.md"
    },
    "windows": {
      "nsis": {
        "installMode": "perMachine"
      }
    }
  },
```

Then add a top-level `plugins` block (sibling of `bundle`), pasting the public
key from Step 1:

```json
  "plugins": {
    "updater": {
      "pubkey": "PASTE_PUBLIC_KEY_FROM_STEP_1",
      "endpoints": [
        "https://github.com/Jorditomasg/devdeck/releases/latest/download/latest.json"
      ]
    }
  }
```

> Note on CI ordering: `createUpdaterArtifacts: true` makes `tauri build` emit a
> `.sig` over the UNSIGNED installer. We deliberately ignore that one — CI
> re-signs the SignPath-signed installer (Task 8). The flag stays on so the
> NSIS bundle is updater-shaped and Tauri does not warn.

- [ ] **Step 4: Verify config parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "feat(updater): configure tauri-plugin-updater and bundle CHANGELOG"
```

---

## Task 4: Pure changelog parser (Rust, TDD)

**Files:**
- Create: `src-tauri/src/changelog/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod changelog;`)
- Test: inline `#[cfg(test)]` in `changelog/mod.rs`

- [ ] **Step 1: Write the module with failing tests**

Create `src-tauri/src/changelog/mod.rs`:

```rust
//! Pure parser for the root `CHANGELOG.md` (Keep a Changelog format).
//!
//! Side-effect-free: takes the file text, returns structured releases. The
//! file IO lives in `commands::updates::get_changelog`. The format is regular
//! enough that a hand parser beats pulling a markdown crate into the build.

use serde::Serialize;

/// One released (or unreleased) version block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogRelease {
    /// `"1.0.0"` or `"Unreleased"`.
    pub version: String,
    /// `"2026-06-21"`, or `None` for an Unreleased block / dateless heading.
    pub date: Option<String>,
    pub added: Vec<String>,
    pub changed: Vec<String>,
    pub fixed: Vec<String>,
    pub removed: Vec<String>,
}

impl ChangelogRelease {
    fn new(version: String, date: Option<String>) -> Self {
        Self {
            version,
            date,
            added: Vec::new(),
            changed: Vec::new(),
            fixed: Vec::new(),
            removed: Vec::new(),
        }
    }
}

#[derive(Clone, Copy)]
enum Section {
    Added,
    Changed,
    Fixed,
    Removed,
    Other,
}

/// Parse Keep-a-Changelog text into release blocks, newest first (document
/// order preserved). Headings that are not `## [version] - date` are ignored;
/// list items before the first version heading are dropped.
pub fn parse(text: &str) -> Vec<ChangelogRelease> {
    let mut releases: Vec<ChangelogRelease> = Vec::new();
    let mut section = Section::Other;

    for raw in text.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some((version, date)) = parse_version_heading(rest) {
                releases.push(ChangelogRelease::new(version, date));
                section = Section::Other;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("### ") {
            section = match rest.trim().to_ascii_lowercase().as_str() {
                "added" => Section::Added,
                "changed" => Section::Changed,
                "fixed" => Section::Fixed,
                "removed" => Section::Removed,
                _ => Section::Other,
            };
            continue;
        }
        let item = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "));
        if let (Some(item), Some(current)) = (item, releases.last_mut()) {
            let text = item.trim().to_owned();
            if text.is_empty() {
                continue;
            }
            match section {
                Section::Added => current.added.push(text),
                Section::Changed => current.changed.push(text),
                Section::Fixed => current.fixed.push(text),
                Section::Removed => current.removed.push(text),
                Section::Other => {}
            }
        }
    }
    releases
}

/// Parse the text after `## ` into `(version, date)`.
/// Accepts `[1.0.0] - 2026-06-21`, `[Unreleased]`, `1.0.0 - 2026-06-21`.
fn parse_version_heading(rest: &str) -> Option<(String, Option<String>)> {
    let rest = rest.trim();
    let (version_part, date_part) = match rest.split_once(" - ") {
        Some((v, d)) => (v.trim(), Some(d.trim().to_owned())),
        None => (rest, None),
    };
    let version = version_part
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim();
    if version.is_empty() {
        return None;
    }
    Some((version.to_owned(), date_part.filter(|d| !d.is_empty())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# Changelog

## [1.1.0] - 2026-07-01
### Added
- Dark mode
- Export profiles
### Fixed
- Crash on empty workspace

## [1.0.0] - 2026-06-21
### Added
- Auto-update from within the app
### Changed
- First stable release
";

    #[test]
    fn parses_versions_dates_and_sections() {
        let releases = parse(SAMPLE);
        assert_eq!(releases.len(), 2);

        assert_eq!(releases[0].version, "1.1.0");
        assert_eq!(releases[0].date.as_deref(), Some("2026-07-01"));
        assert_eq!(releases[0].added, vec!["Dark mode", "Export profiles"]);
        assert_eq!(releases[0].fixed, vec!["Crash on empty workspace"]);
        assert!(releases[0].changed.is_empty());

        assert_eq!(releases[1].version, "1.0.0");
        assert_eq!(releases[1].changed, vec!["First stable release"]);
    }

    #[test]
    fn handles_unreleased_and_dateless_headings() {
        let releases = parse("## [Unreleased]\n### Added\n- WIP feature\n");
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].version, "Unreleased");
        assert_eq!(releases[0].date, None);
        assert_eq!(releases[0].added, vec!["WIP feature"]);
    }

    #[test]
    fn ignores_items_before_first_version_and_empty_input() {
        assert!(parse("").is_empty());
        assert!(parse("# Changelog\n- stray bullet\n").is_empty());
    }

    #[test]
    fn ignores_unknown_sections() {
        let releases = parse("## [1.0.0]\n### Security\n- patched CVE\n");
        assert_eq!(releases.len(), 1);
        assert!(releases[0].added.is_empty());
        assert!(releases[0].changed.is_empty());
    }
}
```

- [ ] **Step 2: Register the module in `src-tauri/src/lib.rs`**

In the `pub mod` block (lines 24-35), add alphabetically after `pub mod app;`
(there is no `app` mod at top level — the modules are `commands, config,
detection, docker, domain, events, git, java, process, profiles, state,
terminal`). Add `changelog` after `pub mod commands;`:

```rust
pub mod commands;
pub mod changelog;
pub mod config;
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml changelog`
Expected: 4 tests pass (`parses_versions_dates_and_sections`,
`handles_unreleased_and_dateless_headings`,
`ignores_items_before_first_version_and_empty_input`,
`ignores_unknown_sections`).

> If `cargo test` fails because the Angular dist is missing (tauri-build's
> build.rs requires `frontendDist`), run `npm run build` first.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/changelog/mod.rs src-tauri/src/lib.rs
git commit -m "feat(changelog): add pure Keep-a-Changelog parser"
```

---

## Task 5: Updater + changelog commands (Rust)

**Files:**
- Create: `src-tauri/src/commands/updates.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/events.rs` (add `UPDATE_PROGRESS`)
- Modify: `src-tauri/src/lib.rs` (register plugin + 3 commands)

- [ ] **Step 1: Add the event constant to `src-tauri/src/events.rs`**

After the `APP_CLOSE_REQUESTED` constant (line 57), add:

```rust

/// Update download progress while `install_update` runs. Payload:
/// `{ downloaded: u64, contentLength: u64 | null }` (camelCase). Emitted from
/// the updater command's `download_and_install` chunk callback.
pub const UPDATE_PROGRESS: &str = "update://progress";
```

- [ ] **Step 2: Create `src-tauri/src/commands/updates.rs`**

```rust
//! Updates & about commands (ipc-contract.md §2.9).
//!
//! Wraps `tauri-plugin-updater` so the frontend never touches the plugin
//! directly (architecture-v2.md §3.1: side effects in Rust, frontend is pure
//! UI over the typed contract), plus `get_changelog` which reads the bundled
//! `CHANGELOG.md` resource and returns the parsed structure.

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

use super::error::{AppError, CmdResult};
use crate::changelog::{self, ChangelogRelease};
use crate::events::{EventEmitter, UPDATE_PROGRESS};

/// Result of an update check (`available: false` ⇒ other fields `None`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

impl UpdateInfo {
    fn none() -> Self {
        Self { available: false, version: None, notes: None, date: None }
    }
}

fn updater_err(err: impl std::fmt::Display) -> AppError {
    AppError { kind: "updater".into(), message: err.to_string() }
}

/// §2.9 #77 `check_for_update` — query the configured endpoint for a newer
/// version. The frontend calls this silently on startup (swallowing errors —
/// offline / first-release 404) and on the manual "Check for updates" button.
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> CmdResult<UpdateInfo> {
    let updater = app.updater().map_err(updater_err)?;
    match updater.check().await.map_err(updater_err)? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }),
        None => Ok(UpdateInfo::none()),
    }
}

/// §2.9 #78 `install_update` — download + install the available update,
/// emitting `update://progress`, then restart. Re-checks to obtain the update
/// handle (the `check` result is not held across commands).
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> CmdResult<()> {
    let updater = app.updater().map_err(updater_err)?;
    let Some(update) = updater.check().await.map_err(updater_err)? else {
        return Err(AppError {
            kind: "updater".into(),
            message: "no update available".into(),
        });
    };

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                EventEmitter::emit(
                    &progress_app,
                    UPDATE_PROGRESS,
                    serde_json::json!({
                        "downloaded": downloaded,
                        "contentLength": content_length,
                    }),
                );
            },
            || {},
        )
        .await
        .map_err(updater_err)?;

    // Diverges (`-> !`): the process is replaced by the freshly installed one.
    app.restart();
}

/// §2.9 #79 `get_changelog` — read the bundled `CHANGELOG.md` resource and
/// return the parsed release history (newest first).
#[tauri::command]
pub async fn get_changelog(app: tauri::AppHandle) -> CmdResult<Vec<ChangelogRelease>> {
    let path = app
        .path()
        .resolve("CHANGELOG.md", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError { kind: "io".into(), message: format!("changelog path: {e}") })?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| AppError { kind: "io".into(), message: format!("read changelog: {e}") })?;
    Ok(changelog::parse(&text))
}
```

- [ ] **Step 3: Register the module in `src-tauri/src/commands/mod.rs`**

Add `pub mod updates;` after `pub mod terminal;` (line 32):

```rust
pub mod profiles;
pub mod terminal;
pub mod updates;
```

And extend the doc list (after the §2.8 docker bullet, ~line 17) with:

```rust
//! - [`updates`] — §2.9 updates & about (`check_for_update`,
//!   `install_update`, `get_changelog`)
```

- [ ] **Step 4: Register the plugin and commands in `src-tauri/src/lib.rs`**

(a) After the `tauri_plugin_opener::init()` plugin line (line 86), add:

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
```

(b) In the `generate_handler!` macro, after the docker block
(`commands::docker::run_flyway_seeds,` line 217), add:

```rust
            // §2.9 updates & about
            commands::updates::check_for_update,
            commands::updates::install_update,
            commands::updates::get_changelog,
```

- [ ] **Step 5: Build to verify it compiles**

Run: `npm run build && cargo build --manifest-path src-tauri/Cargo.toml`
Expected: compiles. (`npm run build` first so build.rs finds `frontendDist`.)

> If `app.restart()` triggers a "mismatched types" error, confirm the function
> body ends with `app.restart();` and no trailing `Ok(())` — `restart()`
> returns `!` and diverges.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/updates.rs src-tauri/src/commands/mod.rs src-tauri/src/events.rs src-tauri/src/lib.rs
git commit -m "feat(updater): add check_for_update, install_update, get_changelog commands"
```

---

## Task 6: TypeScript IPC contract (TDD via specs)

**Files:**
- Modify: `src/app/core/ipc/tauri.types.ts`
- Modify: `src/app/core/ipc/commands.ts`
- Modify: `src/app/core/ipc/events.ts`
- Modify: `src/app/core/ipc/commands.spec.ts` (76 → 79)
- Modify: `src/app/core/ipc/events.spec.ts` (7 → 8)

- [ ] **Step 1: Update the count assertions first (they will fail)**

In `commands.spec.ts`, change the `describe('CMD registry')` test (lines 8-18):

```ts
  it('contains the 79 contract commands, all snake_case and unique', () => {
    // 76 prior + 3 updates/about commands (ipc-contract.md §2.9 #77–#79):
    // check_for_update / install_update / get_changelog.
    const names = Object.values(CMD);
    expect(names.length).toBe(79);
```

In `events.spec.ts`, add to the `EVT registry` test before the length assert
(line 16-17):

```ts
    expect(EVT.updateProgress).toBe('update://progress');
    expect(Object.values(EVT).length).toBe(8);
```

- [ ] **Step 2: Run the specs to verify they fail**

Run: `npm test -- src/app/core/ipc/commands.spec.ts src/app/core/ipc/events.spec.ts`
Expected: FAIL — CMD length is 76 (expected 79), `EVT.updateProgress` undefined.

- [ ] **Step 3: Add the types to `tauri.types.ts`**

Append:

```ts
/** Result of `check_for_update` (ipc-contract.md §2.9). */
export interface UpdateInfo {
  available: boolean;
  version: string | null;
  notes: string | null;
  date: string | null;
}

/** One version block from `get_changelog` (mirrors Rust `ChangelogRelease`). */
export interface ChangelogRelease {
  version: string;
  date: string | null;
  added: string[];
  changed: string[];
  fixed: string[];
  removed: string[];
}

/** Payload of `update://progress`. `contentLength` is null until known. */
export interface UpdateProgressEvent {
  downloaded: number;
  contentLength: number | null;
}
```

- [ ] **Step 4: Add the `CMD` entries and wrapper group in `commands.ts`**

(a) Add the import to the `tauri.types` type block (after `WorkspaceGroup,`):

```ts
  ChangelogRelease,
  UpdateInfo,
```

(b) In the `CMD` object, after the docker block (`runFlywaySeeds:` line 128),
add:

```ts
  // updates & about (§2.9)
  checkForUpdate: 'check_for_update',
  installUpdate: 'install_update',
  getChangelog: 'get_changelog',
```

(c) After the `terminal` wrapper group (closes at line 630), add a new group:

```ts

  // -- updates & about (§2.9) -----------------------------------------------

  readonly updates = {
    /** Query for a newer version; `available: false` when up to date. */
    check: (): Promise<UpdateInfo> =>
      this.bridge.invoke<UpdateInfo>(CMD.checkForUpdate),

    /** Download + install the available update; progress via `update://progress`. */
    install: (): Promise<void> => this.bridge.invoke<void>(CMD.installUpdate),

    /** Full parsed changelog history, newest first. */
    changelog: (): Promise<ChangelogRelease[]> =>
      this.bridge.invoke<ChangelogRelease[]>(CMD.getChangelog),
  };
```

- [ ] **Step 5: Add the event to `events.ts`**

(a) Add the type import (after `ServiceStatusEvent,`):

```ts
  UpdateProgressEvent,
```

(b) In `EVT`, after `appCloseRequested` (line 41):

```ts
  /** events.rs `UPDATE_PROGRESS` — download progress during install_update */
  updateProgress: 'update://progress',
```

(c) Add the listener method after `onAppCloseRequested` (line 97):

```ts
  /** Update download progress while `install_update` runs. */
  onUpdateProgress(
    handler: (event: UpdateProgressEvent) => void,
  ): Promise<UnlistenFn> {
    return this.bridge.listen(EVT.updateProgress, handler);
  }
```

- [ ] **Step 6: Run the specs to verify they pass**

Run: `npm test -- src/app/core/ipc/commands.spec.ts src/app/core/ipc/events.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/core/ipc/tauri.types.ts src/app/core/ipc/commands.ts src/app/core/ipc/events.ts src/app/core/ipc/commands.spec.ts src/app/core/ipc/events.spec.ts
git commit -m "feat(ipc): add updates/changelog commands and update progress event"
```

---

## Task 7: Updates store (Angular, TDD)

**Files:**
- Create: `src/app/core/state/updates.store.ts`
- Create: `src/app/core/state/updates.store.spec.ts`

Study an existing store first (e.g. `settings.store.ts`) to match the injection
and signal idioms used in this codebase.

- [ ] **Step 1: Write the failing spec**

Create `src/app/core/state/updates.store.spec.ts`:

```ts
/** TestBed-free specs (vitest-style). */
import { describe, expect, it } from 'vitest';

import { IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import { FakeTauriBridge } from '../ipc/tauri-bridge.fake';
import { CMD } from '../ipc/commands';
import { UpdatesStore } from './updates.store';

function makeStore(bridge: FakeTauriBridge): UpdatesStore {
  return new UpdatesStore(new IpcCommands(bridge), new IpcEvents(bridge));
}

describe('UpdatesStore', () => {
  it('exposes availability after a successful check', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.checkForUpdate, {
      available: true,
      version: '1.1.0',
      notes: 'New stuff',
      date: '2026-07-01',
    });
    const store = makeStore(bridge);

    await store.check();

    expect(store.available()).toBe(true);
    expect(store.info()?.version).toBe('1.1.0');
  });

  it('stays unavailable and swallows errors on silent startup check', async () => {
    const bridge = new FakeTauriBridge().whenInvoked(CMD.checkForUpdate, () => {
      throw { kind: 'updater', message: 'offline' };
    });
    const store = makeStore(bridge);

    await store.checkSilently();

    expect(store.available()).toBe(false);
    expect(store.info()).toBeNull();
  });

  it('caches the changelog after first load', async () => {
    const releases = [
      { version: '1.0.0', date: '2026-06-21', added: ['x'], changed: [], fixed: [], removed: [] },
    ];
    const bridge = new FakeTauriBridge().whenInvoked(CMD.getChangelog, releases);
    const store = makeStore(bridge);

    const first = await store.loadChangelog();
    const second = await store.loadChangelog();

    expect(first).toEqual(releases);
    expect(second).toEqual(releases);
    expect(bridge.invokesOf(CMD.getChangelog).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/app/core/state/updates.store.spec.ts`
Expected: FAIL — `UpdatesStore` not found.

- [ ] **Step 3: Implement the store**

Create `src/app/core/state/updates.store.ts`:

```ts
import { Injectable, inject, signal } from '@angular/core';

import { IpcCommands } from '../ipc/commands';
import { IpcEvents } from '../ipc/events';
import type { ChangelogRelease, UpdateInfo } from '../ipc/tauri.types';

/**
 * Update availability + install progress + changelog cache.
 *
 * `checkSilently()` is the startup probe — failures (offline, first-release
 * 404) are swallowed. `check()` surfaces errors for the manual button.
 */
@Injectable({ providedIn: 'root' })
export class UpdatesStore {
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);

  private readonly _info = signal<UpdateInfo | null>(null);
  /** Download progress 0..1 while installing, or null when idle. */
  private readonly _progress = signal<number | null>(null);
  private readonly _installing = signal(false);
  private changelogCache: ChangelogRelease[] | null = null;

  readonly info = this._info.asReadonly();
  readonly progress = this._progress.asReadonly();
  readonly installing = this._installing.asReadonly();

  available(): boolean {
    return this._info()?.available ?? false;
  }

  /** Manual check — propagates errors to the caller. */
  async check(): Promise<void> {
    this._info.set(await this.commands.updates.check());
  }

  /** Startup check — swallows errors (offline / no release yet). */
  async checkSilently(): Promise<void> {
    try {
      await this.check();
    } catch {
      this._info.set(null);
    }
  }

  /** Subscribe to download progress; call once during app init. */
  async listenProgress(): Promise<void> {
    await this.events.onUpdateProgress((e) => {
      this._progress.set(
        e.contentLength && e.contentLength > 0
          ? e.downloaded / e.contentLength
          : null,
      );
    });
  }

  /** Download + install + restart. Throws on failure. */
  async install(): Promise<void> {
    if (this._installing()) {
      return;
    }
    this._installing.set(true);
    this._progress.set(0);
    try {
      await this.commands.updates.install();
      // On success the app restarts; this line is effectively unreachable.
    } finally {
      this._installing.set(false);
      this._progress.set(null);
    }
  }

  /** Parsed changelog history, cached after the first load. */
  async loadChangelog(): Promise<ChangelogRelease[]> {
    if (this.changelogCache === null) {
      this.changelogCache = await this.commands.updates.changelog();
    }
    return this.changelogCache;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/app/core/state/updates.store.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/core/state/updates.store.ts src/app/core/state/updates.store.spec.ts
git commit -m "feat(updates): add UpdatesStore with check, install and changelog cache"
```

---

## Task 8: Changelog dialog + settings "About / Updates" section + i18n

**Files:**
- Create: `src/app/features/dialogs/changelog/changelog-dialog.component.ts`
- Modify: `src/app/features/dialogs/settings/settings-dialog.component.ts`
- Modify: `src/assets/i18n/en.json`
- Modify: `src/assets/i18n/es.json`

Follow the existing dialog pattern: extend `DialogBase`, use
`DialogShellComponent`, translate every string via the `| t` pipe. Read
`java-manager-dialog.component.ts` for the canonical stacked-dialog shape.

- [ ] **Step 1: Add i18n keys to BOTH locale files (identical structure)**

In `en.json`, under the `dialog.settings` object add:

```json
"updates_title": "Updates",
"check_updates": "Check for updates",
"up_to_date": "You are on the latest version.",
"update_available": "Version {version} is available.",
"update_now": "Update now",
"view_changelog": "View changelog",
"current_version": "Current version {version}",
"checking": "Checking…",
"installing": "Installing…"
```

Add a new top-level `dialog.changelog` object in `en.json`:

```json
"changelog": {
  "title": "Changelog",
  "unavailable": "Changelog is unavailable.",
  "added": "Added",
  "changed": "Changed",
  "fixed": "Fixed",
  "removed": "Removed"
}
```

Mirror BOTH blocks in `es.json` with Spanish text and the SAME keys:

```json
"updates_title": "Actualizaciones",
"check_updates": "Buscar actualizaciones",
"up_to_date": "Tienes la última versión.",
"update_available": "La versión {version} está disponible.",
"update_now": "Actualizar ahora",
"view_changelog": "Ver cambios",
"current_version": "Versión actual {version}",
"checking": "Comprobando…",
"installing": "Instalando…"
```

```json
"changelog": {
  "title": "Cambios",
  "unavailable": "El registro de cambios no está disponible.",
  "added": "Añadido",
  "changed": "Cambiado",
  "fixed": "Corregido",
  "removed": "Eliminado"
}
```

- [ ] **Step 2: Verify the locale key-sets stay identical**

Run:
```bash
node -e "const a=require('./src/assets/i18n/en.json'),b=require('./src/assets/i18n/es.json');const k=o=>Object.entries(o).flatMap(([p,v])=>v&&typeof v==='object'?k(v).map(s=>p+'.'+s):[p]).sort();const ka=k(a),kb=k(b);const d=[...ka.filter(x=>!kb.includes(x)),...kb.filter(x=>!ka.includes(x))];if(d.length){console.error('MISMATCH',d);process.exit(1)}console.log('i18n keys match')"
```
Expected: `i18n keys match`

- [ ] **Step 3: Create the changelog dialog**

Create `src/app/features/dialogs/changelog/changelog-dialog.component.ts`:

```ts
/**
 * Full changelog viewer — renders the parsed `get_changelog` history.
 * Pure presentational over `UpdatesStore.loadChangelog()`; stacks on top of
 * the settings dialog.
 */
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { UpdatesStore } from '../../../core/state/updates.store';
import type { ChangelogRelease } from '../../../core/ipc/tauri.types';
import { DialogShellComponent } from '../../../ui';
import { DialogBase } from '../dialog-base';

@Component({
  selector: 'app-changelog-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogShellComponent, TPipe],
  template: `
    <ui-dialog-shell
      [dialogTitle]="'dialog.changelog.title' | t"
      width="640px"
      [cascadeLevel]="cascadeLevel()"
      (closed)="closeSelf()"
    >
      @if (releases(); as list) {
        @for (rel of list; track rel.version) {
          <section class="release">
            <h3>
              {{ rel.version }}
              @if (rel.date) { <span class="release__date">— {{ rel.date }}</span> }
            </h3>
            @for (group of groups; track group.key) {
              @if (rel[group.key].length) {
                <h4>{{ group.label | t }}</h4>
                <ul>
                  @for (item of rel[group.key]; track item) { <li>{{ item }}</li> }
                </ul>
              }
            }
          </section>
        }
      } @else {
        <p>{{ 'dialog.changelog.unavailable' | t }}</p>
      }
    </ui-dialog-shell>
  `,
})
export class ChangelogDialogComponent extends DialogBase {
  private readonly updates = inject(UpdatesStore);

  protected readonly releases = signal<ChangelogRelease[] | null>(null);

  protected readonly groups = [
    { key: 'added', label: 'dialog.changelog.added' },
    { key: 'changed', label: 'dialog.changelog.changed' },
    { key: 'fixed', label: 'dialog.changelog.fixed' },
    { key: 'removed', label: 'dialog.changelog.removed' },
  ] as const satisfies ReadonlyArray<{
    key: keyof Pick<ChangelogRelease, 'added' | 'changed' | 'fixed' | 'removed'>;
    label: string;
  }>;

  constructor() {
    super();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.releases.set(await this.updates.loadChangelog());
    } catch {
      this.releases.set([]);
    }
  }
}
```

> If `DialogBase` does not provide a usable no-arg `constructor()`/`super()`,
> match the exact constructor signature used by `java-manager-dialog.component.ts`
> instead (read it first), and trigger `load()` from `ngOnInit`.

- [ ] **Step 4: Add the "About / Updates" section to the settings dialog**

In `settings-dialog.component.ts`:

(a) Extend the imports to inject the store and dialog:

```ts
import { UpdatesStore } from '../../../core/state/updates.store';
import { ChangelogDialogComponent } from '../changelog/changelog-dialog.component';
```

(b) In the component class, after `private readonly i18n` add:

```ts
  private readonly updates = inject(UpdatesStore);
  protected readonly checking = signal(false);
  protected readonly version = signal<string | null>(null);

  protected readonly updateInfo = this.updates.info;
  protected readonly installing = this.updates.installing;
```

(c) Read the app version from `@tauri-apps/api/app`. Add at the top:

```ts
import { getVersion } from '@tauri-apps/api/app';
```

and a constructor that loads it:

```ts
  constructor() {
    super();
    void getVersion().then((v) => this.version.set(v));
  }
```

(d) Add the UI section in the template, after the Java row and before the
closing `</div>` of `.settings`:

```html
        <div class="settings__divider"></div>

        <!-- 5. Updates / About -->
        <ui-form-row [label]="'dialog.settings.updates_title' | t" labelWidth="155px">
          <div class="settings__updates">
            <ui-button variant="blue" [loading]="checking()" (clicked)="checkUpdates()">
              {{ 'dialog.settings.check_updates' | t }}
            </ui-button>
            <ui-button variant="neutral" (clicked)="openChangelog()">
              {{ 'dialog.settings.view_changelog' | t }}
            </ui-button>
          </div>
        </ui-form-row>
        <p class="settings__hint">
          {{ 'dialog.settings.current_version' | t: { version: version() ?? '—' } }}
        </p>
        @if (updateInfo()?.available) {
          <div class="settings__update-banner">
            <span>{{ 'dialog.settings.update_available' | t: { version: updateInfo()!.version } }}</span>
            <ui-button variant="success" [loading]="installing()" (clicked)="installUpdate()">
              {{ 'dialog.settings.update_now' | t }}
            </ui-button>
          </div>
        }
```

(e) Add the handler methods to the class:

```ts
  protected async checkUpdates(): Promise<void> {
    if (this.checking()) {
      return;
    }
    this.checking.set(true);
    try {
      await this.updates.check();
      if (!this.updates.available()) {
        await this.dialogs.error(
          this.i18n.t('dialog.settings.updates_title'),
          this.i18n.t('dialog.settings.up_to_date'),
        );
      }
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    } finally {
      this.checking.set(false);
    }
  }

  protected async installUpdate(): Promise<void> {
    try {
      await this.updates.install();
    } catch (err: unknown) {
      await this.dialogs.error(this.i18n.t('misc.error_title'), describe(err));
    }
  }

  protected openChangelog(): void {
    this.dialogs.open(ChangelogDialogComponent);
  }
```

> Verify `this.i18n.t(key, params)` supports an interpolation-params second
> argument (it is used elsewhere, e.g. `java_n_configured`). The `| t: {…}`
> pipe form is used the same way.

- [ ] **Step 5: Run the frontend test suite**

Run: `npm test`
Expected: PASS (existing suites green; no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/app/features/dialogs/changelog/ src/app/features/dialogs/settings/settings-dialog.component.ts src/assets/i18n/en.json src/assets/i18n/es.json
git commit -m "feat(ui): add updates section in settings and changelog dialog"
```

---

## Task 9: Wire the silent startup check

**Files:**
- Modify: the app bootstrap/root component (find it: `Glob src/app/*.component.ts` and the root in `app.config.ts` / `main.ts`).

- [ ] **Step 1: Locate the root component init**

Run: `grep -rln "frontendReady\|frontend_ready\|class AppComponent" src/app`
Read the root component that already calls `frontendReady()` on init — the
startup check belongs alongside it.

- [ ] **Step 2: Add the startup probe**

In the root component's init (where `frontendReady()` / store hydration runs),
inject `UpdatesStore` and call, fire-and-forget, AFTER first paint:

```ts
private readonly updates = inject(UpdatesStore);

// inside the existing init method, after frontendReady():
void this.updates.listenProgress();
void this.updates.checkSilently();
```

> Only the `main` window should run this — guard with the same
> `?log=` / terminal-window check the root uses to skip main-only work, if one
> exists. If the root already early-returns for detached windows, no extra
> guard is needed.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app
git commit -m "feat(updates): silent update check on startup"
```

---

## Task 10: CI — sign the installer with the updater key and publish latest.json

**Files:**
- Modify: `.github/workflows/build-and-sign.yml`

The minisign signature MUST be computed over the **SignPath-signed** installer,
so all new steps go in the `sign-and-release` job AFTER the SignPath step and
BEFORE the release. The Node CLI (`@tauri-apps/cli`) provides `tauri signer`.

- [ ] **Step 1: Add Node + the signer + manifest steps to `sign-and-release`**

After the `Sign NSIS installer with SignPath` step (which writes to `signed/`)
and before `Upload signed installer`, insert:

```yaml
      - name: Setup Node LTS
        uses: actions/setup-node@v4
        with:
          node-version: lts/*

      - name: Generate updater signature + latest.json
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ''
          REF_NAME: ${{ startsWith(github.ref, 'refs/tags/') && github.ref_name || inputs.release-tag }}
        run: |
          set -euo pipefail
          INSTALLER=$(ls signed/*-setup.exe | head -n1)
          VERSION="${REF_NAME#v}"

          # Minisign-sign the SignPath-signed installer (the artifact users
          # download). Writes "$INSTALLER.sig".
          npx --yes @tauri-apps/cli signer sign "$INSTALLER"
          SIGNATURE=$(cat "$INSTALLER.sig")

          # Release notes = this version's CHANGELOG.md section (## [x.y.z] ...
          # up to the next "## " heading).
          NOTES=$(awk -v ver="$VERSION" '
            $0 ~ "^## \\[" ver "\\]" { grab=1; next }
            grab && /^## / { exit }
            grab { print }
          ' CHANGELOG.md)

          ASSET="https://github.com/${GITHUB_REPOSITORY}/releases/download/${REF_NAME}/$(basename "$INSTALLER")"

          jq -n \
            --arg version "$VERSION" \
            --arg notes "$NOTES" \
            --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --arg signature "$SIGNATURE" \
            --arg url "$ASSET" \
            '{version:$version, notes:$notes, pub_date:$pub_date,
              platforms:{"windows-x86_64":{signature:$signature, url:$url}}}' \
            > signed/latest.json

          echo "Generated latest.json for $VERSION"
          cat signed/latest.json
```

- [ ] **Step 2: Publish latest.json alongside the installer**

In the `Create GitHub Release` step, change the `files:` line from:

```yaml
          files: signed/*-setup.exe
```

to:

```yaml
          files: |
            signed/*-setup.exe
            signed/latest.json
```

- [ ] **Step 3: Add an inline comment guarding the ordering**

Above the `Generate updater signature` step, add:

```yaml
      # ⚠ ORDERING: minisign-sign the SignPath-SIGNED installer, never the
      # build output. The updater verifies the downloaded (signed) binary
      # against this signature — signing the unsigned one breaks all updates.
```

- [ ] **Step 4: Validate the workflow YAML**

Run: `npx --yes yaml-lint .github/workflows/build-and-sign.yml 2>/dev/null || node -e "require('js-yaml')" 2>/dev/null; python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build-and-sign.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build-and-sign.yml
git commit -m "ci: sign installer with updater key and publish latest.json"
```

---

## Task 11: Update the IPC contract doc

**Files:**
- Modify: `docs/migration/ipc-contract.md`

- [ ] **Step 1: Document the new surface**

Read `docs/migration/ipc-contract.md` to match its formatting. Add a `§2.9
Updates & about` subsection listing the three commands with their arg/return
shapes (`check_for_update → UpdateInfo`, `install_update → void`,
`get_changelog → ChangelogRelease[]`), and add `update://progress` to the §3
events list with its payload `{ downloaded, contentLength }`. Update any
total-count line ("59 commands" / "7 events" style) consistently with the new
totals (commands +3, events +1).

- [ ] **Step 2: Commit**

```bash
git add docs/migration/ipc-contract.md
git commit -m "docs: document updates/changelog IPC surface (§2.9 + update event)"
```

---

## Task 12: Cut the 1.0.0 release (end-to-end verification)

**Files:** version files (already set if needed) + tag.

- [ ] **Step 1: Bump the three version files to 1.0.0**

Set `version` to `1.0.0` in `package.json`, `src-tauri/tauri.conf.json`, and
`[package] version` in `src-tauri/Cargo.toml` (currently `0.9.0`).

- [ ] **Step 2: Confirm CHANGELOG.md already has the `## [1.0.0]` section** (Task 1).

- [ ] **Step 3: Commit and tag**

```bash
git commit -am "chore(release): v1.0.0"
git tag v1.0.0
```

- [ ] **Step 4: STOP — hand off to the user**

Do NOT push. Tell the user: pushing `git push origin master --tags` triggers
the CI that builds, SignPath-signs, minisign-signs, and publishes the release +
`latest.json`. The first published release is the end-to-end proof: a prior
build can then detect and install 1.0.0 → next version.

---

## Self-Review

**Spec coverage** (design §1–§5 + risks):
- §1 Versioning/CHANGELOG → Tasks 1, 2, 12.
- §2 Update infra (CI + keys) → Tasks 3, 10.
- §3 Update logic (Rust commands/events) → Task 5.
- §4 Changelog logic (Rust parser → UI) → Tasks 4, 5 (`get_changelog`), 8.
- §5 UI (settings + changelog + i18n + startup check) → Tasks 7, 8, 9.
- Contract-doc + count-assertion rule → Tasks 6, 11.
- Risk "first-release 404" → Task 7 `checkSilently()` swallows errors.
- Risk "CI ordering regression" → Task 10 Step 3 inline guard + CLAUDE.md note.

**Type consistency:** Rust `ChangelogRelease` (camelCase serde) ⇄ TS
`ChangelogRelease`; Rust `UpdateInfo` ⇄ TS `UpdateInfo`; event payload
`{ downloaded, contentLength }` ⇄ TS `UpdateProgressEvent`. Command names
`check_for_update` / `install_update` / `get_changelog` identical across
`lib.rs`, `CMD`, and the contract doc. Counts: CMD 76 → 79, EVT 7 → 8.

**Placeholder scan:** none — every code step carries full content; UI steps that
depend on un-read local idioms (DialogBase ctor, i18n params) carry an explicit
"verify against existing file" note rather than a guess.

**Open verification points flagged for the implementer** (not placeholders —
real "check the existing pattern" notes): DialogBase constructor shape (Task 8
Step 3), root-component init location (Task 9 Step 1), `t()` params form
(Task 8 Step 4).
