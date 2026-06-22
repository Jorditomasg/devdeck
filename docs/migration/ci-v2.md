# CI/CD — DevDeck v2 (`.github/workflows/v2-build-and-sign.yml`)

Pipeline for the Tauri 2 + Angular rewrite in `v2/`. The v1 workflow
(`build-and-sign.yml`) is untouched and keeps serving `v1` tags until retired.

## Pipeline overview

Triggers: tag push `v2.*`, or `workflow_dispatch` (optional `release-tag` input
→ draft release; empty → build + sign only).

| Job | Runner | What it does |
|---|---|---|
| `build` | windows-latest | Node LTS + Rust stable (npm + cargo caches) → `npm ci` in `v2/` → non-blocking `tsc --noEmit` → `ng build` (required before `cargo test`: tauri-build validates `frontendDist`) → non-blocking `cargo test` → `npm run tauri build` → upload unsigned NSIS installer as GitHub artifact |
| `sign-and-release` | ubuntu-latest | SignPath signs the installer (by artifact id, `wait-for-completion`) → upload signed artifact → `softprops/action-gh-release` attaches the **signed** installer (published on tags, draft on dispatch) |

Output: `DevDeck_<version>_x64-setup.exe` from
`v2/src-tauri/target/release/bundle/nsis/` — a self-contained NSIS installer.

**This fixes v1's packaging bug** (inventory-config-ci.md §5.4): v1 released a
bare Nuitka `--standalone` exe without its `main.dist/` folder, so the release
asset could not run. In v2 the signed release asset is the complete installer.

## Required secrets / variables

| Name | Kind | Value |
|---|---|---|
| `SIGNPATH_API_TOKEN` | secret | SignPath CI user token (same one v1 uses) |
| `SIGNPATH_V2_ARTIFACT_CONFIG` | repo variable (optional) | Overrides the SignPath artifact-configuration slug. Default: `installer` |

SignPath constants (same as v1): organization `566b6bce-16ea-4c67-80a2-1654b3efdef4`,
project `devdeck`, policy `release-signing`.

## ⚠ SignPath artifact configuration

v1 signs with artifact configuration **`exe`** (a bare PE file). The NSIS
`setup.exe` is a different artifact shape — **a new artifact configuration must
be created in the SignPath dashboard before the first v2 release** (suggested
slug `installer`: zip-file containing a pe-file, since GitHub artifacts arrive
as zips). If you pick another slug, set the `SIGNPATH_V2_ARTIFACT_CONFIG`
repository variable instead of editing the workflow.

## Prerequisites (one-time, before first run)

- **Commit `v2/package-lock.json`** — `npm ci` and the `setup-node` npm cache
  both require it (`cd v2 && npm install`, commit the lockfile).
- Recommended: commit `v2/src-tauri/Cargo.lock` for reproducible Rust builds
  (Tauri's own templates commit it for applications).
- Create the SignPath `installer` artifact configuration (above).

## How to cut a release

1. Bump versions so they match the tag: `v2/package.json`,
   `v2/src-tauri/tauri.conf.json` (`version`), `v2/src-tauri/Cargo.toml`.
   There is no auto-stamping — the installer filename embeds the
   `tauri.conf.json` version, not the tag.
2. Tag and push:

   ```bash
   git tag v2.0.1
   git push origin v2.0.1
   ```

3. The workflow builds, signs, and publishes the release with the signed
   installer attached.

Dry run: *Actions → v2 Build and Sign → Run workflow*, optionally filling
`release-tag` to get a **draft** release; leave it empty to just get the signed
installer as a workflow artifact.

> ⚠ v1 trigger overlap: `build-and-sign.yml` fires on `v*`, which also matches
> `v2.*` tags — pushing a v2 tag currently runs BOTH pipelines (and v1's will
> fail or release a broken asset). Narrow v1's trigger to `v1.*` or retire it.

## Local build reference

```bash
cd v2
npm install                 # or: npm ci (once the lockfile is committed)
npm run tauri build         # ng build + cargo build --release + NSIS bundling
# installer: v2/src-tauri/target/release/bundle/nsis/DevDeck_<version>_x64-setup.exe

# dev loop
npm run tauri dev           # ng serve on :4200 + tauri window

# tests / checks
npx tsc -p tsconfig.app.json --noEmit
npm run build               # required once before cargo test (frontendDist must exist)
cargo test --manifest-path src-tauri/Cargo.toml
```

## Pinned action versions

| Action | Version | Verification |
|---|---|---|
| `actions/checkout` | v4 | tauri-action official docs |
| `actions/setup-node` | v4 | tauri-action official docs |
| `dtolnay/rust-toolchain` | stable | tauri-action official docs |
| `Swatinem/rust-cache` | v2 | tauri-action official docs |
| `actions/upload-artifact` | v4 | proven with the SignPath connector in v1; SignPath docs show newer majors — bump deliberately |
| `signpath/github-action-submit-signing-request` | v2 | docs.signpath.io (v1 pipeline still uses @v1) |
| `softprops/action-gh-release` | v2 | same as working v1 pipeline |

`tauri-apps/tauri-action` was deliberately **not** used: its release upload
attaches the *unsigned* bundle. We need sign-before-release, so the build uses
the project's own `npm run tauri build` and the release is published explicitly
after SignPath returns the signed installer.
