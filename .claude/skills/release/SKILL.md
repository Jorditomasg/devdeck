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
