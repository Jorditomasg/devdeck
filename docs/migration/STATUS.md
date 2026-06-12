# Engineering Status — DevOps Manager v2

Last updated: 2026-06-12. Companion docs: [`architecture-v2.md`](architecture-v2.md),
[`ipc-contract.md`](ipc-contract.md), [`ci-v2.md`](ci-v2.md),
[`migration-guide.md`](migration-guide.md).

## Implemented

All areas of the migration contract are written and present in `v2/`:

| Area | State |
|---|---|
| **Rust core** (`v2/src-tauri/src/`) | All modules implemented: `domain/`, `config/` (app-config store, env-file writers, repo-types loader, **v1 migrator** with sentinel normalization), `detection/` (single unified detector), `process/` (spawn/stream/supervise/kill, own process group on POSIX), `git/`, `java/`, `profiles/`, `docker/`, `commands/` (9 groups, all 57 contract commands registered in `lib.rs`), `events.rs`, `state.rs`. Startup migration + tray + single-instance wired in `lib.rs` |
| **Rust unit tests** | 40 source files carry `#[cfg(test)]` modules |
| **Angular app** (`v2/src/app/`) | `core/ipc/` (typed `commands.ts` / `events.ts` / `tauri.types.ts`, bridge + fake), `core/state/` (repos, services, profiles, settings stores), `core/i18n/`, `features/workspace/` (topbar, global panel, repo cards, statusbar) + 10 dialogs, `ui/` atomic components, SCSS token system, `assets/i18n/en.json` + `es.json` |
| **Frontend specs** | Vitest-style `*.spec.ts` across core/features/ui (TestBed-free) — runner wiring pending (see below) |
| **Repo-type YAML** | 6 definitions ported to `v2/config/repo-types/` (angular, docker-infra, maven-lib, nx-workspace, react, spring-boot), bundled as Tauri resources |
| **CI** | `.github/workflows/v2-build-and-sign.yml` written (build → SignPath sign → release) |
| **Docs** | Architecture, IPC contract, CI, three v1 inventories, user migration guide |

## Review status

An adversarial review round has been completed: **two independent blind judges** reviewed
the implementation against the contract docs, followed by a **fix round** applying their
findings. The code as committed reflects the post-fix state.

## UNVERIFIED — no build has ever run

**Neither `npm` nor `cargo` has ever been executed in `v2/`.** Everything below is
contract-correct on paper but unproven at runtime:

1. **Dependency version resolution** — the npm and crates.io pins were verified against the
   registries on 2026-06-10, but no install/resolution has ever run.
2. **TypeScript/Angular peer matrix** — verified against the npm registry on 2026-06-12:
   `@angular/compiler-cli@22.0.x` declares `typescript >=6.0 <6.1` and `typescript@6.0.3`
   exists, so the `~6.0.0` pin is correct; full resolution still unproven until `npm install`.
3. **`serde_yaml_ng` flatten behavior** — the repo-type/config serde models rely on
   `#[serde(flatten)]`-adjacent behavior that the `serde_yaml` family has historically
   handled differently from `serde_json`; untested against real YAML.
4. **Tauri argument casing on the wire** — the contract assumes Tauri 2's default
   camelCase-JS → snake_case-Rust mapping for command args
   ([`ipc-contract.md` §1.1](ipc-contract.md)); never exercised end-to-end.
5. **SignPath installer artifact configuration** — v1 signs a bare `exe`; the NSIS
   `setup.exe` needs a **new artifact configuration** (suggested slug `installer`) created in
   the SignPath dashboard before the first release ([`ci-v2.md`](ci-v2.md)).
6. **Missing `package-lock.json`** (and `Cargo.lock`) — `npm ci` and the CI npm cache will
   fail until lockfiles are generated and committed.
7. **Vitest runner wired but never executed** — `vitest` is in `devDependencies` with a
   `vitest.config.ts` and a `"test"` script; the 22 spec files have never actually run.

## First-build checklist

Run on **native Windows** (not WSL — see [`v2/README.md`](../../v2/README.md)):

```bash
# 1. First install + dev smoke test
cd v2
npm install
npm run tauri dev

# 2. Rust tests (frontend build required first — tauri-build validates frontendDist)
npm run build
cargo test --manifest-path src-tauri/Cargo.toml

# 3. Commit the lockfiles produced by step 1
git add v2/package-lock.json v2/src-tauri/Cargo.lock
```

Then, before the first release:

4. Create the SignPath **installer** artifact configuration (zip containing a pe-file) in the
   SignPath dashboard — org/project/policy slugs in [`ci-v2.md`](ci-v2.md). If you pick a
   different slug, set the `SIGNPATH_V2_ARTIFACT_CONFIG` repository variable.
5. Narrow the v1 workflow trigger: `.github/workflows/build-and-sign.yml` currently fires on
   `v*`, which also matches `v2.*` tags — change it to `v1.*` (or retire it) so a v2 tag does
   not run both pipelines.

Also expected during the first build round: generate the full icon set
(`npm run tauri icon src-tauri/icons/icon.ico`) and run the frontend specs (`npm test`).
