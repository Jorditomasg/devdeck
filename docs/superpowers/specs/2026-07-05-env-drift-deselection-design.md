# Env-file drift deselection — design

**Date:** 2026-07-05
**Status:** approved (pending spec review)

## Problem

When a user selects a saved environment (env/app profile) for a repo module,
DevDeck writes that env's content **verbatim** to the target file on disk. If
the user later edits that file directly — so it no longer matches the selected
env — the card keeps showing the env as selected, which is a lie. The selection
should **deselect** itself, and the user should be **notified**.

## Key facts (verified in code)

- **Verbatim write → byte compare is reliable.** `write_active_environment`
  (`src-tauri/src/config/writers.rs`) writes the saved content byte-for-byte
  (raw/angular verbatim; spring preserves comments, no re-dump). So
  `file_on_disk == saved_environments[selectedName]` is a sound drift test with
  no false positives from transformation.
- **State locations:** selected env → `active_configs["{repo}::{module}"]`
  (config.json). Saved contents → `repo_configs` via `get_saved_environments`
  (#29). Env target file + writer type → derived from `RepoInfo` frontend-side.
- **The active file differs by writer:** raw/angular → the target file
  (`.env` / `environment.ts`); spring → `application-{profile}.yml` (or
  `.properties`) in the resources dir, derived by the writer from the target.
- **Deselect does NOT touch the file.** `set_active_config(null)`
  (`src-tauri/src/commands/config.rs:128`) only clears the map — no
  `git checkout`. So deselecting on drift leaves the user's edit intact.
- **Refresh trigger:** the frontend never polls; Rust runs the 30 s badge poll
  (`src-tauri/src/git/poll.rs`) and emits `git://badge` per repo (plus an
  immediate kick after every scan). The badge poller knows only repo *paths* —
  not modules, active_configs, or saved contents.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| When to detect drift | On the existing 30 s poll — hook the `git://badge` event, no new timer, no new event. |
| What deselect does | Clear the selection only; leave the edited file untouched. |
| Notify the user | Yes — inline dismissible banner (mirrors the existing orphan banner; non-modal, no nag). |
| Re-match to another saved env | No. Editing a file until it equals a *different* saved env still just deselects. |
| Resolve the active file per writer | New Rust command (single source of truth), not TS replication. |

## Approach

### Trigger & wiring (features layer)

`repos.store` lives in `core/` and must not import `features/` services
(layering). So the drift subscription lives in
`workspace-page.component.ts` (features), which already subscribes to other
events. On each `git://badge` for repo `R`, it calls
`RepoActionsService.checkEnvDrift(R)`.

The badge poller's immediate kick after startup scan means the **first** badge
also runs the check — covering env files edited while the app was closed.

### New IPC command

`read_active_environment { writerType, targetFile, profile } -> string`

Resolves the active file through the writers registry (same target logic as
`apply_environment`) and reads it raw; missing file → `""`. Symmetric with
`apply_environment` minus `content`. All file IO stays in Rust.

- Rust: add `resolve_active_file(writer_type, target_file, profile) -> PathBuf`
  in `writers.rs` (mirrors each writer's target resolution), plus a
  `read_active_environment` command in `commands/config.rs`, registered in
  `lib.rs`.
- Contract: `CMD` + wrapper in `core/ipc/commands.ts`, type in `tauri.types.ts`,
  `docs/migration/ipc-contract.md`, and the count assertion in
  `commands.spec.ts` (101 → 102) — updated together.

### `checkEnvDrift(repo)` (RepoActionsService)

For each module of `repo` **with a selected env** (`configValues[moduleKey]`
non-empty = `selectedName`):

1. `savedContent = savedEnvCache[configKey][selectedName]` (fetch +
   cache `get_saved_environments` once per configKey; invalidate on
   apply/save).
2. `current = await read_active_environment(writerType, targetFile, selectedName)`.
3. If `savedContent === undefined` (env deleted) **or** `current !== savedContent`
   → **drift**:
   - `set_active_config(key, null)` + `ws.setConfigValue(repo, moduleKey, '')`
     as a **non-silent** patch (so the profile dirty-check recomputes — the
     workspace no longer matches the saved profile, which is correct).
   - record the drifted `{repo, moduleKey}` in a drift-notice signal.

Once deselected, the next poll skips that module (no selection) → no re-notify.

### Notification (banner)

An inline, dismissible banner in the workspace page, mirroring the orphan
banner mechanism: reads the drift-notice signal, lists the deselected
selections ("N env selection(s) deselected because their files changed"),
dismiss clears the signal. i18n keys in `en.json`/`es.json` (identical
structure).

## Efficiency

Per 30 s badge cycle, per repo: **one** `read_active_environment` IPC call per
module **that has a selected env** (small file). Saved contents are cached in
memory (0 IPC after first fetch). Modules with no selection are skipped
entirely. Typically a handful of small reads per cycle — negligible.

## Testable units

- **Rust:** `resolve_active_file` unit tests for raw/angular/spring(.yml) and
  spring(.properties); `read_active_environment` missing-file → `""`.
- **Frontend:** a pure `driftedModules(...)` helper in `workspace-logic.ts`
  (given selected values + saved map + current contents → list of drifted
  module keys, including the env-deleted case), unit-tested. The comparison
  itself is a byte `!==`.

## Addendum (2026-07-05): Spring apply model — Model B

Investigation during testing revealed that for Spring repos the original model
was inconsistent: selecting "mysql" wrote `application-mysql.properties`, but
`mvn spring-boot:run` (no `spring.profiles.active` injected — verified in
`process.rs`) loads the BASE `application.properties`. So the selection had no
runtime effect.

**Decision (user, product owner): Model B.** A Spring selection is stamped into
the BASE running file (`application.{ext}`, no profile suffix), exactly like the
`raw`/`angular` writers already target their single running file. This makes
Spring consistent instead of special-cased.

- `SpringWriter::active_path` now returns `application.{ext}` for ANY profile;
  `write_active`, `resolve_active_file`, and `read_active_environment` all follow
  → apply and drift both act on the base file with no extra logic.
- The per-profile `application-{p}.*` files remain as preset SOURCES only
  (editable via the config manager); editing them no longer affects selection.
- **Destructive by design:** selecting a profile overwrites `application.*`.
  Restore the original by selecting "default" (its preset holds the base content).
- **Safe:** `auto_import_configs` is NOT called in production code and
  `merge_repo_configs` never overwrites an existing preset, so stamping the base
  file cannot corrupt the "default" preset on rescan.
- Spring-only; no frontend changes.

## Out of scope

- File watcher (instant detection) — rejected as heavier than the poll approach
  and against DevDeck's no-watcher design.
- Auto re-match to another saved env.
- Rewriting/restoring the edited file on deselect.

## `ponytail:` upgrade path

If many modules carry active selections and the per-cycle reads ever measure as
hot, gate `read_active_environment` by mtime (a `stat` returned alongside, or a
cheap mtime command) so unchanged files skip the read. Not worth it today.
