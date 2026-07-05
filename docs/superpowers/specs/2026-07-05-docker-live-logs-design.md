# Docker live logs + service selection — design

Date: 2026-07-05
Status: implemented

## Problem

Two defects in the docker-compose surface:

1. **Docker logs are not detachable and not live.** Every other log in DevDeck
   (service, clone, branch, merge, stash, global panel) shares one engine:
   the `ui-log-viewer` component fed by a live Rust stream (`LogCache` +
   `service://log-line`), which is why they detach into their own window via
   `open_log_window`. Docker logs were the odd one out — a static `<pre>` fed
   by a one-shot `docker compose logs --tail=200` snapshot, wired into none of
   that pipeline, so they could not be detached and were not live.

2. **You cannot select docker services**, even though the repo config enables
   it (`docker_checkboxes` feature). The selection state (`dockerActive`,
   `dockerServices`) is fully modelled, persisted, profile-loadable and consumed
   at start — but **nothing in the UI writes it**. The per-service checkboxes
   had been removed from the docker dialog (a documented removal), and the card
   only renders buttons that open the dialog. Net effect: selections could only
   arrive by loading a saved profile.

## Decisions (from brainstorming)

- **Live docker logs, but lazy.** A `docker compose logs -f` follower runs
  ONLY while someone is viewing that service's log; it is killed when the last
  viewer leaves. Never one process per docker — only per *watched* log.
- **Start with a bounded tail (500) + "Load full history" on demand.** Fast and
  live by default; the full `--tail all` snapshot is one button away.
- **The "clear" button stays on every log.** No log loses it (revised mid-
  brainstorm; part 2 of the original request dropped entirely).
- **Service-selection checkboxes live in the docker window** (where services are
  listed per file), **saved live** (each toggle applies immediately in the main
  window). The window is not meant to stay open, but leaving it open is
  harmless because each toggle has already been relayed.

## Architecture

### Live logs — full reuse of the existing pipeline

The key insight: the detached-log pipeline is keyed by an arbitrary `serviceId`
string. If docker log lines are emitted under a **synthetic, self-describing
id**, everything downstream (backlog seeding, live events, detached window)
works unchanged.

- **Synthetic id**: `docker::<composeFile>::<service>` (empty `<service>` =
  whole stack). It is the `?log=` value, the `LogCache` key and the
  `docker_log_start` argument at once. No file path contains `::` and no compose
  service name contains `::`, so the id splits unambiguously on the LAST `::`
  — a detached window (which only receives the id) can re-derive file+service
  and re-attach on its own.

- **Rust `DockerLogManager`** (`docker/logs.rs`): a ref-counted registry of
  followers, keyed by synthetic id.
  - `attach(id)` — first attach spawns a tokio task running
    `docker compose -f <file> logs -f --tail=500 [service]`; each stdout/stderr
    line is ANSI-stripped and emitted as a single-line `service://log-line`
    batch under `id`. Later attaches just bump the ref-count (one process, no
    duplicate lines).
  - `detach(id)` — last detach aborts the task; the child is `kill_on_drop`, so
    the `logs -f` process dies. Nothing runs for a log nobody watches.
  - Lines flow through THE shared emitter, so the `LogCache` mirror and every
    attached window/panel get them for free.

- **Commands**: `docker_log_start { serviceId }`, `docker_log_stop
  { serviceId }` (#109/#110).

- **Frontend**:
  - In-dialog panel: reuses `ServicesStore.logsFor(id)` (already live in every
    window) filtered to `stream === 'docker'`, rendered via the shared
    `ui-dialog-log` organism (Detach + Clear header). `docker_log_start` on
    select, `docker_log_stop` on switch/close.
  - Detached window: `log-window.component` is already generic; it only gained
    an attach/detach lifecycle when its id begins with `docker::`.
  - "Load full history": one-shot `docker_compose_logs(file, service, 100000)`
    shown in place of the live tail, toggled back to live.

- **Global-log hygiene**: synthetic `docker::…` ids are kept OUT of the
  all-services global aggregate (both the frontend panel and the Rust
  `LogCache` GLOBAL), so live docker lines don't spam it with an ugly synthetic
  prefix. Docker *operation* logs (up/down, emitted under the repo name) still
  appear there as before.

### Service selection — cross-window relay

The docker dialog runs in an **isolated webview** with its own empty
`WorkspaceStore`; it cannot mutate the main window's store directly. So:

- Per-service checkbox in each row, seeded from the card's current selection
  passed as dialog args (`selectedServices`, `active`).
- Each toggle calls `set_docker_selection { repoName, file, services, active }`
  (#111) — a **pure Rust relay** that re-emits `docker://selection`. Routing
  through Rust keeps the "only Rust emits events" rule intact.
- The main window's `WorkspaceStore` subscribes to `docker://selection` and
  folds it into card state via `patchCard`, which runs the normal 300 ms
  profile dirty-check — identical to any in-app selection. A file is "active"
  for the profile start whenever ≥1 of its services is selected.

Keys are consistent everywhere on the compose file **basename** (e.g.
`docker-compose.kafka.yml`): the card seed, the relay `file`, the store's
`dockerServices` map and `dockerActive` list, and `repo-actions` consumption.

## IPC contract delta

- Commands: 107 → **110** (`docker_log_start`, `docker_log_stop`,
  `set_docker_selection`).
- Events: 11 → **12** (`docker://selection`).
- Count assertions updated in `commands.spec.ts` / `events.spec.ts`; contract
  doc (`docs/migration/ipc-contract.md`) updated.

## Known limitations (ponytail)

- Selecting individual services cannot express "active with ALL services"
  distinctly from "active with the full explicit list" — functionally
  equivalent at start time, so not worth a separate control.
- If `logs -f` exits on its own (e.g. no container yet), the stream entry
  lingers until the next detach; harmless. Not reaped eagerly.
