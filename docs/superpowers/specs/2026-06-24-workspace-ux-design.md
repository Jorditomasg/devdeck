# Workspace UX: selector, search, manual order, marked-accent — design

Date: 2026-06-24
Scope: `src/app/features/workspace` (+ one Rust/TS config field). No process,
detection or IPC-contract changes.

## Problem

The workspace page lists detected repos with no way to search, no manual
ordering, and no visual emphasis on the "marked" (batch-selected) ones.
Switching workspaces (already supported via `workspace_groups`) leaves any
running services alive but invisible in the new group's list — silent orphans.

## Decisions (from brainstorming)

1. **Workspace selector** — already exists: the topbar shows
   `ui-searchable-select` whenever there is more than one group
   (`showGroupSelector`). No work needed.
2. **Switch with running repos → keep alive + warn.** Switching never kills
   processes (current Rust behaviour). A banner surfaces services running in
   another workspace, with a one-click "stop them".
3. **"Marked" = the existing `selected` checkbox.** No new favourite concept.
   Marked cards render at full presence; unmarked dim to 0.5 (CSS only).
4. **Order = alphabetical by default, then manual drag.** Persisted as a
   fractional `order` on `repo_state` so a reorder writes ONE repo, not the
   whole list. Drag is disabled while a search filter is active.
5. **Search** — live, case-insensitive substring on repo name, ephemeral.

## Implementation

- **Config**: `RepoState.order: Option<f64>` (Rust) / `order?: number` (TS).
  Persisted through the existing `set_repo_state` command — no new IPC.
- **Pure logic** (`workspace-list.logic.ts`, unit-tested): `effectiveOrder`
  (persisted order ?? alphabetical baseline), `orderedRepos`, `filterRepos`,
  `reorder` + `midOrder` (fractional drop), `computeOrphans` / `orphanGroups`.
- **WorkspaceStore**: `repoFilter` signal, `serviceGroups` session map
  (repo → origin group, tagged on each scan), `setCardOrder`, and a shared
  `repoStatePatch(name)` builder reused by the card and the drag handler.
- **WorkspacePage**: `visibleRepos` (ordered + filtered), orphan banner +
  `onStopOrphans`, search input, and a left **grip handle** per card for drag
  (the card stays fully interactive — a draggable card would block log-text
  selection).
- **RepoCard**: host class `card--dimmed` on `!selected` + SCSS.
- **i18n**: `placeholder.search_repos`, `label.no_repos_match`,
  `label.orphans_running`, `btn.stop_orphans`, `tooltip.drag_reorder`
  (en + es, identical structure).

## Deliberate simplifications (ponytail)

- Origin-group naming relies on a session map; after an app restart an orphan
  shows `(?)` instead of its group name. Upgrade path: scan all groups.
- Drop neighbour math is O(n) per drop — fine for tens of repos.

## Tests

`workspace-list.logic.spec.ts` (11 cases): ordering + fractional override,
search filter, reorder/midpoint edges, orphan computation, group labels.
