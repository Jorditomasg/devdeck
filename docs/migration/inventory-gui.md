# GUI Feature Inventory — DevDeck (Python/customtkinter → Angular + Tauri 2 migration contract)

> **Purpose**: Exhaustive functional spec of the current GUI layer. Angular implementation agents
> will NOT read the Python source — every behavior listed here is a migration requirement.
> File:line references point to the Python source for traceability only.
>
> Scope: everything under `gui/`, plus `config/ui_theme.yml` (design tokens) and `assets/icons/`.
> Backend calls (`core/*`, `application/*`) are referenced as the "service API" the GUI consumes —
> these become Tauri commands.

---

## Table of Contents

1. [Application shell & main window](#1-application-shell--main-window)
2. [Topbar](#2-topbar)
3. [Global panel (batch controls)](#3-global-panel-batch-controls)
4. [Scrollable card list & status bar](#4-scrollable-card-list--status-bar)
5. [Global log (stdout/stderr capture + detached window)](#5-global-log)
6. [RepoCard — header (collapsed state)](#6-repocard--header-collapsed-state)
7. [RepoCard — expand panel (lazy-built)](#7-repocard--expand-panel-lazy-built)
8. [RepoCard — log panel](#8-repocard--log-panel)
9. [RepoCard — git behaviors](#9-repocard--git-behaviors)
10. [RepoCard — config/environment management](#10-repocard--configenvironment-management)
11. [RepoCard — docker compose](#11-repocard--docker-compose)
12. [RepoCard — actions (start/stop/restart/install/pull/clean/merge)](#12-repocard--actions)
13. [BaseDialog (shared modal behavior)](#13-basedialog-shared-modal-behavior)
14. [Messagebox API](#14-messagebox-api)
15. [Dialog: Clone](#15-dialog-clone)
16. [Dialog: Config Editor](#16-dialog-config-editor)
17. [Dialog: Confirm Close](#17-dialog-confirm-close)
18. [Dialog: Instance Conflict](#18-dialog-instance-conflict)
19. [Dialog: Docker Compose manager](#19-dialog-docker-compose-manager)
20. [Dialog: Merge Branch (with revert)](#20-dialog-merge-branch-with-revert)
21. [Dialog: Profile manager + Import Options](#21-dialog-profile-manager--import-options)
22. [Dialog: Settings (+ Java managers)](#22-dialog-settings--java-managers)
23. [Dialog: Repo Config Manager (env/app configs)](#23-dialog-repo-config-manager)
24. [Dialog: Workspace Groups](#24-dialog-workspace-groups)
25. [System tray](#25-system-tray)
26. [Profiles subsystem (app_profile.py)](#26-profiles-subsystem)
27. [Workspace groups UX](#27-workspace-groups-ux)
28. [Timing, debounce & concurrency table](#28-timing-debounce--concurrency-table)
29. [Theme system & design tokens](#29-theme-system--design-tokens)
30. [i18n](#30-i18n)
31. [Tooltip widget](#31-tooltip-widget)
32. [SearchableCombo widget](#32-searchablecombo-widget)
33. [Cross-cutting UX details](#33-cross-cutting-ux-details)
34. [Persistence touched by the GUI](#34-persistence-touched-by-the-gui)

---

## 1. Application shell & main window

Source: `gui/app.py` — class `DevOpsManagerApp(ProfileManagerMixin, ctk.CTk)` (app.py:43).

### Window basics
- Title: `"DevDeck"`; initial geometry `1300x900`; min size `1000x650` (app.py:99-101).
- Dark appearance mode + "blue" CTk theme set BEFORE window creation (app.py:47-48).
- **Anti white-flash**: window starts at `alpha 0.0` (app.py:50) and only becomes visible
  (`alpha 1.0`) after the full UI is built and repos scanned (app.py:164-166). Tauri equivalent:
  show window only after first paint of the loaded app.
- Window icon: `assets/icons/icon_red.ico`, re-applied 200 ms later (Tk quirk) (app.py:104-107).
  Icon color swaps between `red` (nothing running) and `green` (≥1 service running/starting) —
  see §25 and §33.
- Windows-only: `SetCurrentProcessExplicitAppUserModelID('boa.devopsmanager.app.1')` for taskbar
  grouping (app.py:56-61).
- Close protocol intercepted → `_on_close` (app.py:111), see §17 / §33.

### Startup sequence (app.py:44-170)
1. Set theme, create window invisible.
2. Resolve workspace dir (constructor arg or app dir), load settings from
   `devdeck_config.json` via cached config loader (app.py:719-727).
3. Resolve active workspace group (`core.config_manager.get_active_group`), default `"Default"`.
4. Per-group last profile: settings key `last_profile_by_group` (dict group→profile name), with
   one-time migration from legacy `last_profile` for the Default group (app.py:83-89).
5. **Single-instance check** (app.py:137-158): `InstanceManager(workspace_dir)`
   `.find_other_instances()`; if any live instance manages the same workspace, show
   `InstanceConflictDialog` (§18) BEFORE building the UI. On `cancel`: cleanup + hard exit.
   On `close_others` with stragglers: log warning and continue. Then
   `instance_mgr.start_server(on_shutdown=self._on_remote_shutdown)` — an IPC server; when another
   instance asks this one to quit, `_on_remote_shutdown` (app.py:980-987) bounces to the UI thread
   and calls `_on_close(force=True)` (no confirmation dialog, services stopped, state saved).
6. `_build_ui()` → topbar, global panel, scrollable card area, statusbar, global log redirect.
7. `_scan_repos()` (async thread) → builds cards.
8. `_load_initial_profile_data()` — loads the saved profile data for dirty tracking (no apply).
9. Reveal window; start tray status loop (`_check_tray_status`, every 5 s).

### Window-level event bindings
- `<Unmap>` → `_on_window_unmap` (minimize-to-tray, §25) (app.py:124).
- `<Configure>` → `_on_window_configure` (visible-state snapshot, §25) (app.py:126).
- `<FocusIn>`/`<FocusOut>` → app-level focus tracking with 400 ms debounce that triggers a
  git refresh of all cards when the app regains focus from ANOTHER application (app.py:127-135,
  918-952). Key subtleties:
  - `<FocusIn>` fires for descendants too; the code does NOT filter by `event.widget == self`.
    Instead it tracks an `_app_has_focus` boolean: only the unfocused→focused transition triggers
    a refresh (app.py:918-937).
  - `<FocusOut>` defers via `after_idle`: only marks unfocused when `focus_displayof()` is None,
    i.e. focus genuinely left the application — internal widget focus moves are ignored
    (app.py:939-952).
  - Refresh handler `_refresh_all_cards_on_focus` (app.py:954-975) sorts cards by priority:
    expanded or running/starting cards first (they grab the limited git semaphore slots); the rest
    catch up on the regular 30 s badge cycle. Calls each card's `_on_app_focus()` (§9).

### Main vertical layout (top→bottom)
1. **Topbar** (56 px fixed height) — §2.
2. 2 px divider line (`theme.C.divider`) (app.py:198).
3. **GlobalPanel** — `fill=x, padx=10, pady=(10,6)` (app.py:175-178) — §3.
4. **Scrollable card list** — `fill=both, expand` (app.py:328-341) — §4.
5. **Status bar** — single-line label, height 24, anchored west, accent color (app.py:183-188).

---

## 2. Topbar

Source: `gui/app.py:192-289`.

Fixed-height frame (`theme.G.topbar_height` = 56, `fg=theme.C.app`, no propagate). Right-side
buttons are packed FIRST so they reserve space; the path label fills the remainder (app.py:200-202).

### Left section
- Logo label: `"🚀 DevDeck"`, font h1 bold, `text_primary` (app.py:204-207).
- **Workspace path label** (app.py:209-217):
  - Shows current workspace dir, mono base font, accent color, `hand2` cursor.
  - Click (Button-1) → opens the workspace folder in the OS file explorer
    (`os.startfile` / `open` / `xdg-open`) (app.py:467-480).
  - On resize, the path is middle-of-nowhere ellipsized: measured with the actual font, truncated
    char-by-char from the right and suffixed `"..."` to fit available width − 10 px
    (`_update_path_label`, app.py:438-465). Re-entrancy guarded by `_updating_path_label` flag.
  - Tooltip: `tooltip.workspace_dir` with full path; updated dynamically when workspace changes
    (app.py:756).
- **Group selector area** (`_group_area`) — REPLACES the path label when groups are relevant
  (app.py:219-241, 306-326):
  - Contains: label `label.group`, a `SearchableCombo` (width 160) of group names firing
    `_on_group_changed`, and a `⚙` gear button (width 32, `neutral` variant) that opens
    `WorkspaceGroupsDialog` with `on_groups_changed=_on_groups_updated_topbar`.
  - **Swap rule** (`_update_topbar_group_ui`, app.py:306-326): if `len(groups) > 1` OR the active
    group has `>1` path → hide path label, show group area (combo values = group names, selection =
    active group). Otherwise hide group area, show path label. Called after every card rebuild and
    after group CRUD.
  - `_on_groups_updated_topbar` (app.py:295-304): refresh the swap UI; if the previously active
    group name vanished, activate the first available group (persist via `set_active_group`) and
    re-trigger `_on_group_changed`.

### Right section (`_build_topbar_buttons`, app.py:243-289) — packed left→right inside the frame:
1. **Profile dropdown** — `SearchableCombo`, width 160, height "lg", border & button color
   `theme.C.profile_accent` (#7c3aed). Values from `_profile_dropdown_values()` (§26).
   Selection fires `_on_profile_dropdown_change`. Initial value: current profile name, or the
   i18n sentinel `label.no_profile`. Tooltip `tooltip.profile_selector`.
2. **👤 Manage profiles** button — width 38, `neutral` variant, height lg, font h2 → opens
   `ProfileDialog` (§21). Tooltip `tooltip.manage_profiles`.
3. `btn.clone` (width 95, `blue`) → CloneDialog (§15). Tooltip `tooltip.clone_btn`.
4. `btn.rescan` (width 95, `warning`) → `_scan_repos`. Tooltip `tooltip.rescan_btn`.
5. `⚙` (width 38, `neutral`) → SettingsDialog (§22). Tooltip `tooltip.settings_btn`.
6. `📋` (width 38, `neutral`) → detach global log window (§5). Tooltip `tooltip.global_log_btn`.

Button font rule: text length > 2 chars → font "base", else font "h2" (app.py:284).

---

## 3. Global panel (batch controls)

Source: `gui/global_panel.py` — `GlobalPanel(ctk.CTkFrame)`.

Card-styled frame (corner `corner_card`, border `card_border`, bg `card`). Holds a reference list
of all repo cards, refreshed by `set_cards()` after every scan (global_panel.py:27-29).

### Row 1 — title + select-all (global_panel.py:33-51)
- Title label `label.global_panel_title` (font xxl bold).
- **Select All checkbox** (right-aligned, default checked, 16 px box, `text_muted` label
  `label.select_all`): toggles `card.set_selected(value)` on EVERY card (global_panel.py:126-130).

### Row 2 — branch tools (left) + service actions (right) (global_panel.py:53-116)
Left group:
- Label `label.global_branch` (width 45) + **branch entry** (width 180, placeholder
  `label.branch_placeholder`).
- **Apply branch** button (`btn.apply_branch`, width 70, `blue`): validates non-empty branch
  (else `show_warning(misc.enter_branch)`) and ≥1 selected card (else
  `show_warning(misc.no_repos_selected)`). Runs in a background thread: calls
  `card.set_branch(branch)` per selected card; collects repos where the branch doesn't exist and
  shows a warning listing them (`misc.branch_not_found_msg`, bulleted `• repo` lines), and logs
  summary `log.global_branch_applied` / `log.global_branch_not_found` (global_panel.py:136-174).
- **Pull all** (`btn.pull_all`, width 90, `blue`): sequential `git pull` of each selected repo in
  a worker thread; logs `log.global_pulling` (global_panel.py:176-194).
- **Install all** (`btn.install_all`, width 95, `neutral_alt`): filters selected cards that have a
  `run_install_cmd`; if none → log `log.global_all_installed`. Otherwise runs
  `card.install_dependencies(skip_if_installed=True)` for each, in PARALLEL threads, with a
  lock-protected countdown; on last completion logs `log.global_install_done`
  (global_panel.py:196-233).
- **Async-button disabling**: Apply-branch, Pull-all and Install-all are disabled together while
  any of these async ops runs, re-enabled when done (`_set_async_btns_state`,
  global_panel.py:118-124).

Right group (packed right; visual order left→right = Start, Stop, Restart):
- **Start** (`btn.start`, width 80, `start` variant): `card.do_start()` for each selected card;
  log `log.global_starting` (global_panel.py:235-241).
- **Stop** (`btn.stop`, width 80, `danger`): `card.do_stop()` for selected; log
  `log.global_stopping` (global_panel.py:243-249).
- **Restart** (`btn.restart`, width 90, `warning`): stop all selected, then start them again after
  a fixed **3000 ms** delay (global_panel.py:251-263).

All buttons have tooltips (`tooltip.apply_branch`, `tooltip.pull_all`, `tooltip.install_all`,
`tooltip.start_selected`, `tooltip.stop_selected`, `tooltip.restart_selected`).

---

## 4. Scrollable card list & status bar

Source: `gui/app.py:328-368, 622-686`.

- `CTkScrollableFrame`, transparent, `yscrollincrement=20`.
- **Custom scroll handling with overscroll prevention** (app.py:343-368):
  - Wheel events handled only when the pointer is actually over the card area (checked via
    `winfo_containing` + widget-path prefix).
  - If content fits entirely (top≤0 and bottom≥1) → swallow event.
  - Scroll step: ±3 units; scrolling up is blocked at top, down blocked at bottom (covers
    Windows/mac `<MouseWheel>` delta and X11 `<Button-4>/<Button-5>`).
- **Card (re)build** (`_build_cards`, app.py:622-686): destroys all card widgets, creates one
  `RepoCard` per repo (`fill=x, padx=4, pady=3` — vertical list of horizontal cards), then:
  - Restores per-repo persisted state from settings `repo_state`: `selected`, `custom_command`,
    `java_version`, `expanded` (app.py:646-654).
  - **Staggered expanded restore**: cards saved as expanded re-open via `_toggle_expand()` spaced
    60 ms apart (counting only re-opened cards) so a wall of expanded cards doesn't freeze the UI
    (app.py:656-664).
  - **Staggered branch loading**: per card at `30 ms × index` via `_refresh_branch_startup`
    (suppresses dirty-check) (app.py:666-669).
  - **Staggered badge refresh**: per card starting at `3000 + 500 × index` ms so N cards don't
    saturate the git semaphore at startup (app.py:671-675).
  - Updates global panel card list + topbar group UI; re-applies the active profile with
    `_skip_dirty_check=True` (branches still loading async) (app.py:677-686).
- **Repo scanning** (app.py:534-596): resolves the active group's path list (fallback: first
  group's paths or single workspace dir; one-time migration persisting the default group), then in
  a daemon thread calls `project_analyzer.detect_repos_for_group(paths)` (or a legacy fallback that
  dedups by path and sorts by lowercase name), wires/updates `ManageServicesUseCase`, then back on
  the UI thread rebuilds the cards, sets statusbar `label.ready` and logs
  `log.repos_detected` (count + comma-joined names). Optional `_after_scan` callback.
  While scanning: statusbar shows `label.scanning_status` and log `log.scanning`.
- **Status bar** (app.py:183-188, 370-382): label, font "md", `text_accent`, height 24. `_log()`
  prints every message to stdout (→ global log) and mirrors messages **shorter than 100 chars**
  into the statusbar (scheduled on the UI thread).

---

## 5. Global log

Source: `gui/app.py:180-190, 384-532`.

- `sys.stdout` and `sys.stderr` are redirected to a `StreamRedirector` callback (app.py:482-488,
  15-23). Every chunk is ANSI-escape-stripped (regex `\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`,
  app.py:490-494) and pushed to a thread-safe `queue.Queue`.
- A **100 ms polling loop** (`_poll_global_log`, app.py:511-517 — docstring says 50 ms but code
  uses `after(100, ...)`) drains the queue on the UI thread into:
  - an in-memory buffer `_global_log_buffer` (list of chunks), and
  - the detached log textbox if open, trimmed to **1000 lines** via `_insert_log_into_textbox`
    (app.py:519-532; per-textbox line counters keyed by `id(textbox)`).
- **Detached global log window** (`_detach_global_log`, app.py:392-436): 📋 topbar button.
  - Singleton: if already open, just focus it.
  - `CTkToplevel` 800x600, title `dialog.global_log.title`, icon matching current app icon color
    (applied after 200 ms), lifted + focus-forced after 100/110 ms.
  - Header with a `btn.clear_log` button (width 60, `log_action` sm) → `_clear_global_log`
    (clears buffer, counters and the textbox, app.py:384-390).
  - Read-only textbox styled `theme.log_textbox_style(detached=True)`; seeded with the full
    buffer on open and auto-scrolled to end.

---

## 6. RepoCard — header (collapsed state)

Sources: `gui/repo_card/_base.py` (composition + public API), `gui/repo_card/_header.py` (UI).

`RepoCard` is a CTkFrame (corner `corner_card`, border `card_border`, bg `card`) composed of
mixins: Header, ExpandPanel, Log, Git, Config, Docker, Actions (_base.py:21-30).

### Construction state (_base.py:39-103)
Holds: repo info, service launcher, java versions map, status (`'stopped'` initial), branches
cache + "recent count" separator index, current branch, cached behind-count, expanded flag,
installing flag, `selected_var` (BooleanVar, default True), `selected_java_var` (StringVar default
`label.java_default`), `_branch_in_profile_var` (BooleanVar default False), per-env-file profile
tracking vars, active compose files set, docker buttons/status cache, an action ThreadPoolExecutor
(`max_workers=3`, named `act-<repo>`), log line counters, pre-panel log buffer, full log buffer
(for detached window), `_expand_panel_built=False`, pending profile / pending custom command
(values applied before the lazy panel exists).

Subscribes to EventBus `SERVICE_STATUS_CHANGED` (filters by repo name → `_update_status`)
(_base.py:90-91, 127-129). `destroy()` shuts the pool down, stops the compose poll thread, cancels
badge/branch timers and unsubscribes (_base.py:105-125).

Startup timers per card: branch refresh after 200 ms, badge loop after 400 ms, danger badge after
300 ms (_base.py:99-101). (These are re-staggered by app.py during `_build_cards`, §4.)

### Header layout (`_build_header`, _header.py:51-60)
Transparent frame, `hand2` cursor, **click anywhere on the header toggles expand**. Hover
highlights the header background to `card_hover`; leave restores transparent (_base.py:93-94,
_header.py:29-33). Right section packed first (reserves space), left expands.

Left→right visual order:
1. **Selection checkbox** — bound to `selected_var`, 18 px; toggling fires the profile
   change callback (_header.py:68-72).
2. **Status dot** — label text `"🔴"` recolored per status (the emoji glyph itself is constant;
   only `text_color` changes — Angular: use a colored dot). Font xl, width 30. Click toggles
   expand (_header.py:75-81). Colors: §33.
3. **Type badge** — repo type title-cased with `-`→space (e.g. "Spring Boot"), white xs bold text
   on the repo type's `ui_config.color` background, corner `corner_badge`, height 18
   (_header.py:84-90).
4. **Name label** — `"{ui_config.icon} {repo.name}"` (default icon 📁), font h2 bold.
   Left-click toggles expand; **right-click (Button-3) opens the repo's git remote URL in the
   browser** (lazily fetched via `get_remote_url` and cached on the repo) (_header.py:93-101,
   19-27). Tooltip `tooltip.open_repo`.
5. **Badges** (`_build_header_name_hints`, _header.py:105-157):
   - **📥 pull badge** (`_pull_count_label`): `"📥 N"` when N commits behind, else empty. Accent
     color, md bold. **Click → pull** (§12). Tooltip `tooltip.pending_pulls`.
   - **📝 changes badge** (`_changes_count_label`): `"📝 N"` unstaged/untracked count, warning
     yellow. **Click → list modified files in the card log** (§9). Tooltip `tooltip.modified_files`.
   - **⚠️ conflict badge** (`_conflict_count_label`): `"⚠️ N"` unmerged paths, error red, shown only
     during merge conflicts. **Click → list conflicted files in log**. Tooltip
     `tooltip.conflict_files`.
   - **Danger env badge** (`_danger_env_badge`): yellow xs bold text (i18n `badge.danger_env`)
     shown when any active env config is flagged "dangerous" (§10). Click expands. Tooltip
     `tooltip.danger_env_badge`.
   - **Deps-missing warning** (`_branch_hint_warn`): yellow xs mono `install.status_deps_missing`
     shown when install check_dirs are missing AND repo has an install cmd (_header.py:327-348).
     Click expands.
   - **Hint label** (`_branch_hint`): grey (text_faint) xs mono, expands to fill. Concatenation of
     up to three fragments separated by 3 spaces (_header.py:283-348):
     `⎇ <branch>` (combo value if panel built, else cached branch) +
     `⚙ <profile>` (first meaningful config combo value, or pending profile) +
     `$ <custom or default run command>`. Click expands.
     Only re-rendered when content actually changed (`_last_header_hints_state` memo).

Right group (packed right-first; visual left→right) (_header.py:159-225):
1. **Status text** (`_status_text`): i18n status string, colored per status (§33). E.g.
   `label.status.running_port` includes the port.
2. **Port label**: `":{server_port}"` (md bold mono, accent) — only if the repo defines/detected a
   port.
3. **Action buttons frame**:
   - ▶ Start (width 32, `start` variant, font lg). Tooltip `tooltip.start_btn`.
   - ⬛ Stop (width 32, `danger`). Tooltip `tooltip.stop_btn`.
   - 🔄 Restart (width 32, `warning`). Tooltip `tooltip.restart_btn`.
   - **Visibility/enable matrix** (`_update_button_visibility`, _header.py:240-281), memoized on
     `(is_installing, is_running)`:

     | State | Visible buttons | Enabled |
     |---|---|---|
     | installing + running | Stop, Restart | both disabled |
     | installing + stopped | Start | disabled |
     | running/starting | Stop, Restart | enabled |
     | stopped/error | Start | enabled |

     Additionally the expand-panel Install button is disabled while running, re-enabled when
     stopped and not installing (_header.py:277-281).
4. **📁 Open in explorer** (width 28, `neutral`) → OS file manager on repo path
   (_header.py:179-184, 227-238). Tooltip `tooltip.open_explorer`.
5. **▼/▲ expand toggle** (width 28, `toggle_expand` variant, accent-bright text). Text flips to
   ▲ when expanded (_header.py:170-176; _expand_panel.py:495-506). Tooltip `tooltip.expand`.

### Public card API consumed by app/profiles/global panel (_base.py:138-346)
`is_selected/set_selected`, `set_branch(branch) -> bool` (threaded checkout, skips if already on
branch, only checks out if branch exists), `set_profile`, `set_custom_command`,
`get_custom_command`, `get_current_profile` (string for single combo, `{rel_path: value}` dict for
multi-env), `get_branch`, `get/set_branch_in_profile`, `get/set_profile_in_profile`,
`get/set_profile_tracked_files`, `get_name`, `get_repo_info`, `get_docker_compose_active`,
`set_docker_compose_active` (resolves basenames→abs paths, background-stops deactivated compose
files, recolors buttons), `get/set_docker_profile_services`, `do_pull/do_start/do_stop`,
`get_status`.

**Collapsed-card semantics (critical)**: widgets like `_branch_combo`, `_config_combo(s)`,
`_cmd_entry`, `_java_combo` do not exist until first expand. `set_profile`/`set_custom_command`
store pending values (`_pending_profile`, `_pending_custom_command`) which the lazy panel build
picks up; getters fall back to pending values (_base.py:172-216). All widget access elsewhere is
`hasattr`-guarded.

---

## 7. RepoCard — expand panel (lazy-built)

Source: `gui/repo_card/_expand_panel.py`.

**Lazy construction**: `_build_expand_panel()` is called only on the first `_toggle_expand()`
(`_expand_panel_built` flag) (_expand_panel.py:495-506). Panel bg `expand_panel`, corner
`corner_panel`, packed below the header; 1 px divider on top. After build: danger badge sync at
+50 ms; docker status prefetch at +600 ms (only if repo has compose files) (_expand_panel.py:52-57).

### Row 1 — Branch + repo tools (`_build_branch_row`, :94-139)
- Label `label.branch` (width 50, right-aligned).
- **Branch SearchableCombo** (width 180): values = recency-ordered branches with a visual
  separator after the N "recent" ones (`separator_after`); initial values are the cached list or
  `[label.loading]`; selecting fires `_on_branch_change` (checkout, §9).
- **🔄 reload button** (width 28, `log_action`): `_reload_repo` — re-reads current branch,
  branch list, badges from local git, no network (§9). Tooltip `tooltip.reload_repo`.
- **Branch-in-profile checkbox** (18 px, bound `_branch_in_profile_var`): whether the branch is
  tracked by the active profile; fires change callback. Tooltip `tooltip.branch_in_profile`.
- **⬇ Pull** button (width 65, `blue`): text becomes `⬇ Pull (N)` with `blue_active` bg when
  behind N commits (§9). Tooltip `tooltip.pull_btn`.
- **Merge** button (`btn.merge`, width 80, `purple_alt`) → MergeBranchDialog (§20). Tooltip
  `tooltip.merge_btn`.
- **Clean** button (`btn.clean`, width 80, `purple`) → confirm + `git clean` flow (§12). Tooltip
  `tooltip.clean_btn`.
- **Config** button (`btn.config`, width 80, `neutral`) — ONLY when the repo has NO environment
  files and is not `docker-infra` (_expand_panel.py:126-132): opens the raw config editor; if
  multiple candidate files (env files + compose files), shows a **file selector popup**
  (`_show_file_selector`, :529-554 — 400x300 CTkToplevel, `transient+grab_set`, scrollable list of
  file basename buttons, flat style with light/dark tuple colors).
- **Install/Reinstall button** (right-aligned, width 100) (`_build_install_btn`, :172-218):
  built only if repo defines `ui_config.install` or `run_install_cmd`. Installed state is
  determined by ALL `install.check_dirs` existing. Label/style: installed →
  `install.label_ok` with `neutral_alt`; missing → `install.label_missing` with `danger_alt`.
  Tooltip shows the exact command that will run. Click → `_run_install_cmd` (§12).

### Row 2 — Env/App config selectors (conditional) (`_build_selector_row`, :376-396)
Built when repo has `environment_files` and is not `docker-infra`.
- Env files are **deduplicated to one representative file per parent directory** with priority:
  prefer `.yml` over `.properties`; prefer `environment.ts` over variants (:226-240; duplicated in
  `_config.py:154-166`).
- Label prefix comes from `ui_config.selectors[0].label` (default `"App"`).
- For EACH target file, one selector row (`_build_env_file_selector`, :257-347):
  - Label `{prefix}:` (width 50).
  - **Config SearchableCombo** (width 180): options = `[label.no_selection] + sorted(config names)`
    from `load_repo_configs(config_key)` where config_key = `"{repo}::{rel_dir}"` (§10).
    Selecting fires `_on_config_change(value, target_file)` (§10).
  - Initial value priority: pending profile value (dict keyed by rel path or abs path, or plain
    string) → persisted `load_active_config(config_key)` → `label.no_selection`. If a value is
    chosen, `_on_config_change(chosen, target_file, skip_log=True)` is re-fired after 500 ms to
    rewrite the file.
  - **⚙ config manager button** (width 28, `neutral`, font xl) → RepoConfigManagerDialog (§23)
    keyed to this target file; on close, the combo options are reloaded and the selection reset to
    `label.no_selection` if it vanished (§10). Tooltip `tooltip.modify_config` (with module name).
  - **Per-file profile-tracking checkbox** (18 px): whether THIS env file is included in the
    profile. Initial state from `_pending_profile_tracked_keys` (None → all tracked). Fires change
    callback. Tooltip `tooltip.env_in_profile`.
  - If the repo has >1 env selector row: a grey xs mono label with the module dir name (rel path
    of the file's directory, `"root"` for top level).

### Row 2b — Java version (conditional) (`_build_java_combo_section`, :349-374)
Built when `'java_version' ∈ repo.features`.
- Label `label.java` + **SearchableCombo** (width 150) bound to `selected_java_var`; options =
  `[label.java_default] + sorted(java_versions.keys())`.
- If the repo YAML recommends a version: a hint label `label.java_recommended` (md, faint) shown
  ONLY while the selection is the default (trace on the var toggles visibility).
- `update_java_versions(versions)` (:398-408): live-refreshes options after Settings change;
  resets selection to default if the chosen version disappeared.

### Row 3 — Custom command (skipped for `docker-infra`) (`_build_command_row`, :410-436)
- Label `label.cmd` + full-width entry (mono md font, section bg). Placeholder = repo default
  `run_command` (or `label.cmd_placeholder`). Pre-filled from pending custom command.
- `<FocusOut>` and `<Return>` update header hints + fire profile change callback.
- Tooltip `tooltip.cmd_entry` (shows the default command).

### Row 3.5 — Docker compose buttons (conditional) (`_build_docker_row`, :438-491)
Built when `'docker_checkboxes' ∈ repo.features` and compose files exist. For each compose file
(except one named `all`):
- Display name: `docker-compose.yml` → `docker-compose`; `docker-compose.<x>.yml` → `<x>`.
- Button text: `🐳 <Name> [running/total]` (`[?/?]` before first status fetch). Font md, height 26.
- Colors by state: running>0 → bg `docker_active_fg` + border `docker_border_running` (green);
  in active profile but 0 running → bg active + border `docker_border_active` (blue); else bg
  `docker_stopped_fg` + border `docker_border_stopped` (grey).
- Click → DockerComposeDialog for that file (§19). Tooltip `tooltip.docker_manage_active` /
  `tooltip.docker_manage`.
- Starts the per-card compose status polling thread on first build (§11).

### Row 4 — Log panel (§8).

### Status updates (`_update_status`, :558-587; `_on_status_change`, :589-617)
Sets `_status`, cancels any pending log-flash revert timer, recolors the status dot, sets status
text from `{running: label.status.running_port(port), starting, installing, stopped, error}` with
the matching `theme.COLORS` color, and recomputes button visibility. Always marshaled to the UI
thread via `after(0)`.

---

## 8. RepoCard — log panel

Source: `gui/repo_card/_log.py`; row built in `_expand_panel.py:59-92`.

- Header: label `label.log_section` (base bold, secondary) + right-aligned buttons:
  `btn.detach_log` (width 80) and `btn.clear_log` (width 60), both `log_action` sm style.
- **Textbox**: height 120, read-only, `theme.log_textbox_style()` (mono sm, app bg, card border).
- **`_repo_log(message)`** (_log.py:95-123) — the card's log sink (also passed to backend calls):
  - Strips ANSI escapes; prepends `[HH:MM:SS] ` timestamp.
  - Appends to `_full_log_buffer` (capped at `LOG_MAX_LINES` = 500 — complete history for the
    detached window).
  - If the embedded textbox exists → `insert_log_line` (auto-trim at 500 lines using an O(1)
    `count_ref` counter, autoscroll; `gui/log_helpers.py:8-40`). If the panel was never opened,
    lines accumulate in `_pre_panel_log_buffer` and are flushed into the textbox when the panel is
    first built (_expand_panel.py:88-92).
  - Mirrors into the detached textbox if open.
  - Triggers `_flash_log_icon`.
- **Flash animation** (`_flash_log_icon`, _log.py:125-144): only while status is running/starting,
  the status dot turns **orange (`status_logging`)** for 3000 ms then reverts to the status color.
  Re-flashing resets the timer. Status changes cancel the pending revert so the flash never
  overrides a fresh status color (_expand_panel.py:563-566).
- **Clear** (_log.py:22-38): empties embedded + detached textboxes, both counters, both buffers,
  resets `_has_logs`.
- **Detach** (_log.py:40-93): singleton per card (focus if open). CTkToplevel 800x600 titled
  `Logs - {repo}`; icon green/red by current status (after 200 ms); lift/focus at 100/110 ms;
  header with `btn.clear_log` (clears BOTH views); detached-style textbox seeded with a snapshot
  of `_full_log_buffer` (race-safe: snapshot taken on the main thread before the deferred copy).

---

## 9. RepoCard — git behaviors

Source: `gui/repo_card/_git.py`.

### Concurrency primitives (class-level, shared across ALL cards)
- `_GIT_BADGE_SEMAPHORE = Semaphore(3)` — caps concurrent `git status` calls (_git.py:16).
- `_GIT_BRANCH_SEMAPHORE = Semaphore(3)` — caps branch-list loads (_git.py:17).
- `_GIT_FETCH_SEMAPHORE = Semaphore(2)` — caps network fetches (heavier) (_git.py:18).
- Badge and fetch acquire **non-blocking**: if no slot, the cycle is skipped (not queued)
  (_git.py:37-38, 70-71). Branch refresh acquires blocking (_git.py:136).

### Badge refresh loop (`_refresh_badge_loop` / `_refresh_badge`, :50-92)
- Every **30 000 ms** per card; also bound to toplevel `<FocusIn>` (additively, on card map —
  _header.py:35-42).
- Skips work while the window is iconic (minimized/tray) but keeps rescheduling; does NOT skip on
  collapsed cards (header badges are always visible).
- One `git status` summary per cycle → `_apply_badge_labels(s)` (:94-120): updates 📝 unstaged
  count, ⚠️ conflicts count, 📥 behind count, caches `behind`, and restyles the expand-panel Pull
  button (`⬇ Pull (N)` + `blue_active` bg when N>0, plain `⬇ Pull` + `blue` otherwise). If the
  branch reported by status differs from the cached one (external checkout), updates the cached
  branch, the combo and header hints.

### Focus refresh (`_on_app_focus`, :20-48)
Called by the app on focus regain/tray restore: immediate local `_refresh_badge()` plus a
**background `git fetch` throttled to once per 300 s per card** (`FOCUS_FETCH_THROTTLE_S`),
semaphore-capped non-blocking; badge re-refreshed after the fetch.

### Branch list & combo
- `_load_ordered_branches` (:122-131): branches ordered by checkout recency
  (`order_branches_by_recency`); caches `(ordered, recent_count)` on the card — single source of
  truth shared with the merge dialog.
- `_refresh_branch` (:133-166): one `git status` (branch + counts), branch list, lazily fetches
  remote URL; updates combo values/selection (`separator_after=recent_count`), header hints,
  badges; fires the profile change callback unless suppressed.
  `_refresh_branch_startup` = suppressed variant (no dirty-check on startup) (:168-170).
- `_reload_repo` (:172-196): logs `log.reload_start`, local-only reload of branch + list, updates
  combo/hints/pull state/badge, fires change callback, logs `log.reload_done`.
- `_fetch_branches` (:198-210): network fetch then reload combo values.
- **Branch change** (`_on_branch_change`, :212-246): ignores values not in cache. Threaded
  `git checkout`; verifies the resulting branch. Success → update combo/hints/pull/badges + change
  callback. Failure → `show_error(dialog.git.checkout_error_title/msg)` and revert combo to the
  actual branch.

### Badge click handlers
- `_show_modified_files` (:248-265): logs `log.modified_files_header` (count) + one indented line
  per file, or `log.no_changes_local`.
- `_show_conflicts` (:267-284): same pattern with `log.conflict_files_header` / `log.no_conflicts`.

### Log-driven detection (used while a service starts)
- `_detect_port_from_log` (:286-302): if no static port, match each log line against the repo's
  `port_patterns` (or `PORT_PATTERNS_FALLBACK` — `http://localhost:PORT` style and
  `listening on/bound to ... port N`, constants.py:31-34); first match sets `server_port` and
  refreshes the status row.
- `_detect_status_from_log` (:304-317): only while `starting`; repo `error_pattern` match → status
  `error`; `ready_pattern` match → status `running`.

---

## 10. RepoCard — config/environment management

Source: `gui/repo_card/_config.py`.

- **Config key** (`get_config_key`, :17-31): `"{repo.name}::{relative_dir}"` (e.g.
  `backend::src/main/resources`), `"root"` for the repo root; bare repo name when no target file.
- **`_on_config_change(config_name, target_file, skip_log)`** (:131-151): resolves the target file
  (explicit, or via repo `env_main_config_filename` within `environment_files` /
  `env_default_dir`), computes `is_real_change` vs the persisted active config, persists the new
  active config (`save_active_config`), then in a worker thread:
  - `label.no_selection` → **restore original**: `git checkout -- <target_file>` and log
    "Configuración deseleccionada…" (:51-65).
  - Otherwise → load configs for the key and **write the payload** (:95-129):
    - writer type `angular`: dict payload becomes `export const environment = {json};`
      via `write_angular_environment_raw`.
    - writer type `spring` (:67-93): sniffs properties-vs-yaml format; flips the target extension
      (`.yml` ⇄ `.properties`) to match; DELETES the opposite-extension file and its compiled copy
      under `target/classes/`; writes raw.
    - default: raw write.
    - Success → log `Configuración '<name>' aplicada.`; failure → `show_error` with
      `dialog.config.write_error`.
  - Always: refresh header hints, badge (file changed → git dirty), danger badge; fire change
    callback when it was a real change.
- **Danger configs** (:168-199): per config-key set of "dangerous" config names
  (`load_danger_configs`). `_update_danger_badge`: for each deduped env target file, if the active
  config is in the danger set → combo border turns warning-yellow; header badge `badge.danger_env`
  shown if ANY file is dangerous.
- **Config manager launch** (`_open_config_manager`, :201-220): opens RepoConfigManagerDialog
  (§23) with the config key and the source dir of the target file; on close, reloads the combo's
  options (`[no_selection] + sorted(names)`), resetting selection to `no_selection` if the current
  one was deleted, then refreshes hints and danger badge (:222-247).

---

## 11. RepoCard — docker compose

Source: `gui/repo_card/_docker.py`.

- **Status cache**: `_docker_status_cache: {file: (running, total)}`.
- **Prefetch** (`_prefetch_docker_status`, :45-60): on first expand (+600 ms), parses each compose
  file's services and queries container status (`docker compose ps` equivalents in `db_manager`);
  populates the cache and updates buttons if already built.
- **Poll loop** (`_start_compose_status_thread`, :148-166): background thread, wakes every
  **15 s** (`DOCKER_POLL_MS`), stoppable via `_compose_stop_event`. Skips the docker subprocess
  while the app is in the tray (detected via the toplevel's `_tray_icon` attribute — Tk `state()`
  is not thread-safe). Each pass (`_poll_compose_status`, :81-108) updates per-file button text
  `🐳 Name [r/t]` and border (running → green, active-in-profile → blue, else grey), **only when
  the counts actually changed**; then updates the card-level status: if any active compose file
  has running containers → status `running` with text `Ejecutando (N servicios)` (hardcoded
  Spanish — flag for i18n), else `stopped` (:130-146).
- **Immediate poll trigger** (`_update_compose_counts_now`, :71-79): one-shot background poll;
  used after start/stop with follow-ups at +3 s and +7 s to catch slow containers (:184-187,
  380-381).
- **Profile services** (`_on_docker_profile_change`, :25-43): callback from the dialog's
  checkboxes; stores `{compose_file: [services]}`; non-empty selection auto-adds the file to
  `_active_compose_files` (border blue), empty removes it; fires the profile change callback.
- **Start** (`_start_docker_services`, :168-188): `docker compose up` for each active file (all
  repo files if none active; warning log if none exist), limited to the profile-selected services
  when set.
- Dialog launch: `_open_docker_compose_dialog` (:13-23) → §19, with status-change and
  profile-change callbacks wired back to the card.

---

## 12. RepoCard — actions

Source: `gui/repo_card/_actions.py`. All subprocesses are created with
`CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` on Windows, `shell=True`, merged stdout/stderr
(:16-25). Long ops run on the card's 3-worker action pool.

### Install (`install_dependencies` / `_run_install_cmd`, :33-189)
- Public `install_dependencies(skip_if_installed, on_complete)` — used by Global "Install all";
  no-ops (calling `on_complete`) when no install cmd or already installed (check_dirs all exist).
- `_run_install_cmd`: if already installed and triggered from the button → **confirm reinstall**
  (`ask_yes_no(dialog.reinstall.title/confirm)`). Command = `run_reinstall_cmd` when installed and
  defined, else `run_install_cmd`.
- UI during install: button text `install.in_progress` + disabled; `_is_installing=True`; card
  status → `installing` (purple dot); start button disabled (§6 matrix).
- Env: if repo has `java_version` feature and a non-default Java is selected, builds
  `JAVA_HOME` env via `build_java_env` and logs `Usando JAVA_HOME: …` (:60-74).
- Worker: streams output lines to the card log; `wait(timeout=600 s)` then kill on timeout (log
  `log.install_timeout`); success = all check_dirs now exist. Completion (:83-115): button restyled
  `install.label_ok`/`neutral_alt` on success (also refresh hints + badge, log `log.install_done`)
  or `install.error`/`danger_alt` on failure (log `log.install_fail`); status reverted from
  `installing` to `stopped`; button visibility recomputed; `on_complete` fired. Exception path
  resets the button and status (:181-189).

### Start (`_start`, :236-270)
1. **Docker repos** (`docker_checkboxes` feature): check the daemon in a thread; if unavailable →
   `show_error(dialog.docker.unavailable_*)`; else status `starting` + `_start_docker_services`.
2. **Custom command**: if the cmd entry differs from the default run command → `_start_custom`
   (logs `Ejecutando: {cmd}`).
3. **Default**: no `run_command` → warning log and abort. Else build Java env if applicable,
   status → `starting`, log `[repo] ▶ {cmd}`, submit `_run_start_thread`.
- `_run_start_thread` (:272-313): spawn process; register a `RunningService` in the legacy
  launcher map (so stop/restart work); if the repo has NO `ready_pattern` → status `running`
  immediately, otherwise stay `starting` until the ready pattern matches in the log stream (§9).
  Streams output (ANSI-stripped, port/status detection per line). After EOF, `wait(30 s)` then
  kill. Final status resolution: manual stop flag → `stopped`; still `starting` at exit → `error`;
  else `stopped`. Logs `[repo] ⏹ Proceso terminado (código N)`. Exceptions → status `error`.
- `_start_custom` / `_run_custom_command` (:315-356): same lifecycle without launcher
  registration; same final-status rules.

### Stop / Restart (:362-399)
- `_stop`: docker repos → `_stop_docker_services` (status `stopped` immediately;
  `docker compose down` per active file; immediate + 3 s status polls). Otherwise set
  `_is_stopping_manually=True` and delegate to `launcher.stop_service(name, log, update_status)`.
- `_restart`: docker → stop, then at +2000 ms status `starting` + start. Process repos → stop,
  sleep 0.3 s, start (in pool).

### Pull (`_pull`, :401-444)
1. Log `log.pull_start`.
2. Read local changes excluding repo-defined `env_pull_ignore_patterns` (so env-file overwrites
   don't block pulls). If dirty → `show_error(dialog.pull.error_title, dialog.pull.error_msg)`
   listing up to 10 files (+`...`); abort.
3. If cached behind-count > 0 → `ask_yes_no(dialog.pull.confirm_title, dialog.pull.confirm_msg)`
   (N commits, branch name); on yes (or when behind==0, immediately) → `git pull`, then refresh
   branch + badges.

### Clean (`_clean_repo`, :485-514)
- `ask_yes_no(dialog.clean.confirm_title/confirm_msg)` then `clean_repo` (git clean + reset).
- On success (+500 ms): all config combos reset to `label.no_selection`; for multi-combo cards the
  active config is persisted as deselected WITHOUT rewriting files (git already restored
  originals); badges/pull state refreshed.

### Merge (`_open_merge_dialog`, :446-468)
Opens MergeBranchDialog (§20) sharing the card's recency-ordered branch cache + separator index +
current branch + `env_pull_ignore_patterns`; `on_complete=_post_merge_refresh` (refresh branch +
badges).

---

## 13. BaseDialog (shared modal behavior)

Source: `gui/dialogs/_base.py` — `BaseDialog(ctk.CTkToplevel)`; ALL dialogs except
InstanceConflictDialog and the SearchableCombo popup inherit it.

Constructor: `(parent, title, width, height)` (:48-75). Behaviors to replicate:

1. **Transient + non-resizable by default** (`transient(parent)`, `resizable(False, False)`);
   dialogs that need resize override after `super().__init__` (e.g. docker, repo-config-manager).
2. **WM close** defaults to `destroy` (overridable).
3. **Parent darken overlay** (:114-188): BEFORE the dialog renders, a PIL `ImageGrab` screenshot
   of the parent's client area is taken and darkened to 50 % (`_OVERLAY_DARKEN = 0.5`); when the
   dialog grabs focus, the darkened image is placed as a Canvas child covering the parent — a
   visual "modal dimming". The canvas is tagged (`_basedialog_overlay`) for defensive cleanup;
   stale overlays on the same parent are removed first. (Angular/Tauri: a plain CSS backdrop.)
4. **Centering + cascade** (:81-108): centered over the parent; each level of dialog NESTING
   offsets +20 px x/y (`_CASCADE_OFFSET_PX`) so stacked dialogs are visibly layered.
5. **Window icon**: parent app's current red/green ico, applied after 200 ms (:62-70).
6. **Deferred grab/focus** (:244-257): at +10 ms — force `deiconify` (CTkToplevel defers its own
   show; this is the Windows alpha/render workaround), apply the overlay, `ToolTip.hide_all()`
   (grab_set re-routes pointer events so open tooltips would never get `<Leave>`), then
   `grab_set` + `lift` + `focus_force`.
7. **Blocked-click feedback** (:194-218): with the grab active, clicks on the parent are re-routed
   to the dialog; if the click's screen coords fall OUTSIDE the dialog rect → `bell()` +
   `lift` + `focus_force` (the modal "knocks").
8. **Destroy** (:224-242): release grab, remove overlay, destroy, then schedule a parent cleanup
   +50 ms (orphan-overlay scan + synthetic `<Configure>` to force a repaint — Windows Tk quirk).

---

## 14. Messagebox API

Source: `gui/dialogs/messagebox.py`. Themed replacement for `tkinter.messagebox` — used
EVERYWHERE in the GUI.

Public functions (all modal, blocking via `wait_window`):

| Function | Buttons (label → result → variant) | Icon | Returns |
|---|---|---|---|
| `show_info(parent, title, msg)` | OK → True → `blue` | ℹ #6366f1 | None |
| `show_warning(parent, title, msg)` | OK → True → `warning` | ⚠ #f59e0b | None |
| `show_error(parent, title, msg)` | OK → True → `danger` | ✕ #ef4444 | None |
| `ask_yes_no(parent, title, msg)` | No → False → `neutral`, Yes → True → `blue` | ? #7c3aed | bool |

Internal `_AppMessageDialog(BaseDialog)` (:24-94):
- Width fixed 460; height auto-computed from message length: lines = ceil(len/52) + `\n` count;
  `height = max(108, 88 + lines*20)`.
- Layout: 5 px colored accent bar on the left (icon color), icon char (xl bold, width 28) +
  message label (wraplength 370, left-justified), button row anchored bottom-right (buttons packed
  in reverse so the list order reads left→right). Button width 90, height md.
- Note: button labels "OK"/"Yes"/"No" are currently NOT i18n'd.

---

## 15. Dialog: Clone

Source: `gui/dialogs/clone.py` — `CloneDialog(BaseDialog)`, 500x220, title `dialog.clone.title`.

Fields:
- **URL entry** (width 450, placeholder `dialog.clone.url_placeholder`).
- **Folder name entry** (width 450, placeholder `dialog.clone.folder_placeholder`) — optional;
  defaults to the URL's last path segment minus `.git` (:56-63).
- **Progress bar** (width 450, starts 0).
- Buttons: `dialog.clone.btn` (width 120, `blue`) and `btn.cancel` (width 100, `neutral`).

Flow (:65-103):
1. Empty URL → `show_warning(dialog.clone.error_no_url)`.
2. Destination folder already exists → `show_warning(dialog.clone.error_folder_exists)`.
3. Clone button disabled with text `dialog.clone.btn_cloning`; background thread runs
   `git clone` with a progress callback (0–100 → bar 0–1).
4. Success → bar to 1.0, `show_info(dialog.clone.success_*)`, fire `on_complete` (app passes
   `_scan_repos`), close. Failure → `show_error(dialog.clone.error_clone_msg)`, re-enable button,
   reset bar.

---

## 16. Dialog: Config Editor

Source: `gui/dialogs/config_editor.py` — `ConfigEditorDialog(BaseDialog)`, 700x550, title
`Editor: {basename}`.

- Header shows the full file path (xs mono, placeholder color).
- Mono textbox editor loaded via `read_config_file_raw`.
- **Dirty tracking** via the underlying `<<Modified>>` event: first change appends `" *"` to the
  window title (:66-72).
- Buttons (right-aligned): `btn.save` (`success`, width 120), `btn.cancel` (`neutral`, width 100),
  `btn.reload` (`warning`, width 100).
- **Save** (:84-94): writes content (trailing newline stripped), logs `Guardado: {file}`,
  `show_info(dialog.config_editor.saved_*)`, closes. Failure → `show_error(error_save)`.
- **Reload** (:96-102): re-reads from disk, clears dirty, restores title.
- **Close/Cancel with unsaved changes** → `ask_yes_no(dialog.config_editor.unsaved_title/msg)`;
  declining keeps the dialog open (:74-82). WM close routed to the same handler.

---

## 17. Dialog: Confirm Close

Source: `gui/dialogs/confirm_close.py` — `ConfirmCloseDialog(BaseDialog)`, 420x180, title
`dialog.confirm_close.title`. Result attribute: `confirmed: bool`.

- Message: `message_one` for exactly 1 running service, `message_many` (with count) otherwise.
- Buttons right-aligned: `btn_cancel` (`neutral`, width 110) and `btn_confirm` (`danger`,
  width 130 — confirm closes everything).
- Used by `app._on_close` (app.py:1082-1119): counts cards in running/starting; if >0 and not
  forced, shows the dialog and aborts close unless confirmed. On confirmed close: restore
  stdout/stderr, stop tray icon, instance-manager cleanup, `service_launcher.stop_all`, save
  per-repo state + settings, destroy, `os._exit(0)`.

---

## 18. Dialog: Instance Conflict

Source: `gui/dialogs/instance_conflict.py` — `InstanceConflictDialog(ctk.CTkToplevel)`. **NOT a
BaseDialog**: it appears before the main UI exists (no parent to screenshot). 460x200, centered on
the SCREEN (x centered, y at 1/3 height), grab+focus at +10 ms (:75-95).

Results: `choice ∈ {'close_others','open_anyway','cancel'}` and `remaining` (instances that did
not close in time, only meaningful for `close_others`).

- Message: `dialog.instance_conflict.message_one` / `message_many(count)` (bold) + `detail` label.
- Buttons (right→left): `btn_cancel` (`neutral`, 100), `btn_open_anyway` (`warning`, 120),
  `btn_close_others` (`danger`, 150).
- **Close-others flow** (:107-129): disables all buttons, sets detail text to `closing`, sends a
  shutdown request to the other instances, then polls `still_alive()` every **300 ms** up to
  **40 polls (~12 s)**; finishes when none remain or polls exhausted, exposing `remaining`.
- WM close (X) = cancel.

---

## 19. Dialog: Docker Compose manager

Source: `gui/dialogs/docker_compose.py` — `DockerComposeDialog(BaseDialog)`, 900x640, resizable,
minsize 680x440, title `Docker Compose - {basename}`.

Constructor inputs: compose file, log callback (card log), `on_status_change` (card's immediate
poll), initial `profile_services` list, `on_profile_change` callback.

### Header (:42-88)
- Title `docker.title` (h2 bold) + **profile count label** (`docker.profile_count` with n, blue,
  empty when 0).
- Right controls: **auto-refresh switch** (`docker.auto_refresh`, default ON),
  `docker.btn_start_all` (`success`, width 110) → `docker compose up` (all),
  `docker.btn_stop_all` (`danger_deep`, width 110) → `docker compose down`.
  Both check the docker daemon first (`is_docker_available`; failure logs `docker.log_unavailable`).

### Service rows (scrollable list; one per service parsed from the compose YAML) (:90-172)
Empty list → red label `docker.no_services`. Each row (height 44, section_alt bg, subtle border):
- **Profile checkbox** (18 px, blue accents, tooltip `tooltip.docker_profile_checkbox`): marks the
  service as part of the profile; updates the count label and fires
  `on_profile_change(file, [services])` → card auto-manages the active state (§11).
- **Status dot** `●` (lg) — green `status_running` / grey `status_stopped`, updated by refresh.
- **Name** (base bold) + details: image name, `·`-joined published ports (sm, muted).
- **Status text** (width 85, right): localized running/stopped, same color as the dot.
- Buttons: `Start` (width 54, `success`) / `Stop` (width 54, `danger_deep`) — per-service
  `docker compose up/stop <name>` with daemon check and logs `docker.log_starting/log_stopping`;
  `Logs` (width 54, `neutral_alt`) → select this service in the log panel.

### Log panel (bottom) (:174-203, 326-358)
- Title `docker.logs_title_empty` → `docker.logs_title(name)` once a service is selected.
- `btn.reload` (width 80, disabled until a service is selected): re-fetches
  `docker compose logs <service>` in a thread (shows `docker.log_loading` meanwhile).
- `btn.clear_log` (width 60) empties the box. Box: mono md, height 150, read-only.

### Refresh (:281-322)
- `_refresh_status`: threaded `get_compose_service_status` → recolor all rows; afterwards invokes
  `on_status_change` (card refreshes its compose counters).
- **Auto-refresh loop**: every **5000 ms** while the dialog exists, gated by the switch.
- WM close sets `_auto_refresh=False` then destroys (:360-362).

---

## 20. Dialog: Merge Branch (with revert)

Source: `gui/dialogs/merge_branch.py` — `MergeBranchDialog(BaseDialog)`, 560x660, title
`dialog.merge.title`.

Inputs: repo path/name, branch list + `recent_count` (shared from the card cache so the recents
divider matches), current branch, `dirty_ignore` patterns, log callback, `on_complete`.

### Layout (:61-193)
- Header: `dialog.merge.repo_label(name)` (bold).
- **Target section** (section bg, `dialog.merge.target_section`):
  - Radio `target_branch` (mode `existing`) + **destination SearchableCombo** (width 220,
    `command=_on_destination_change`).
  - Radio `target_new` (mode `new`) + row: label `base_label` + **base SearchableCombo**
    (width 160) + **new-branch entry** (width 170, placeholder `new_placeholder`).
- **Source section** (`dialog.merge.source_section`): label `source_label` + **source
  SearchableCombo** (width 230) + radios `origin_remote` (default, merge `origin/<x>` after a
  fetch) / `origin_local` (merge local branch as-is).
- Checkboxes: `pull_opt` (pull destination before merge — default ON) and `push_opt` (push after a
  clean merge — default OFF).
- **Live log**: label `log_label` + read-only log textbox (height 140) fed by every merge step.
- Buttons: `dialog.merge.btn` (`blue`, width 140) and `btn.cancel` (`neutral`, width 100).

### Selector population logic (:106-293)
- If the card supplied both branches AND the current branch → populate immediately; otherwise all
  three combos show `label.loading` and a background thread loads local refs + recency order
  (:195-215). An OPEN dropdown updates live (SearchableCombo reactive `configure`).
- **Default tracking**: destination and base default to the current branch and KEEP tracking
  fresh loads until the user manually picks a value (`_user_touched_dest/_base`; `set()` does not
  fire `command`, so only real user picks flip the flags) (:233-261).
- **Source exclusion**: in `existing` mode the source list excludes the chosen destination (and
  the recents separator index is adjusted); in `new` mode the full list is offered. If the current
  source selection collides/vanishes it resets to the first option (:263-283).
- **Mode sync** (`_sync_state`, :285-293): `existing` → destination combo readonly, base+entry
  disabled; `new` → inverse.

### Validation (`_collect_params`, :297-335)
Warnings (`show_warning(misc.error_title, …)`): no source (`error_no_source`); existing-mode: no
target (`error_no_target`), target == source (`error_same_branch`); new-mode: no base
(`error_no_base`), no new-branch name (`error_no_new`).

### Merge run (:360-411)
- On start: capture a **revert point** (current branch; for existing-mode also the destination's
  pre-merge SHA) (:373-385); clear dialog log; button disabled with `btn_running`; worker calls
  `git_manager.merge_branch(repo, source, source_remote, target_mode, target|base+new_branch,
  pull_target, push, dirty_ignore, log)`. Each log line mirrors to the card log AND the dialog box.
- **Outcome handling** (`_report`, :470-488):
  - `ok` → log `done_ok`; button becomes **Close** (`btn.close`).
  - `ok_push_failed` → log `done_push_failed(msg)`; button → Close (merge stays revertible since
    the remote was untouched).
  - `conflict` → log `done_conflict(count)`; button → Close.
  - `blocked_dirty` → log `done_dirty` + up to 20 dirty files; button reset for retry.
  - other errors → `done_error(msg)`; button reset for retry.
  - On `ok`/`ok_push_failed`, `on_complete` fires (card refreshes branch + badges).
### Cancel / revert (:415-459)
- Cancel (button or X) with no merge applied → just close.
- Merge applied AND pushed → `show_warning(revert_pushed_title/msg)` (policy: never revert after a
  successful push) then close.
- Merge applied, not pushed → `ask_yes_no(revert_confirm_title/msg)`; if confirmed:
  - merge still in flight → set `cancel_requested`, disable button, log `cancel_pending`; when the
    worker returns, auto-revert (or warn if it turned out pushed).
  - else → `_do_revert`: worker calls `git_manager.revert_merge(repo, revert_point, log)`
    (restores destination SHA / deletes the new branch / returns to the original branch), fires
    `on_complete`, closes. Log `dialog.merge.reverting`.

---

## 21. Dialog: Profile manager + Import Options

Source: `gui/dialogs/profile.py`.

### ProfileDialog (BaseDialog, 580x520, title `dialog.profile.title`) (:33-441)
Inputs: workspace dir, repos, repo cards, log, `on_profile_loaded` (= app `_apply_config`),
`on_rescan`, `on_profiles_changed` (= app `_refresh_profile_dropdown`).

Content (scrollable):
1. Section header `dialog.profile.section_title` (h2 bold).
2. **Save section** (:67-95): label `save_current`; name entry (width 300, placeholder
   `name_placeholder`) + `btn_save` (`success`, width 100); checkbox `include_config_files`
   (default ON) — embeds the actual config file contents in the profile.
   - Save flow (:148-180): empty name → warn `error_no_name`; existing name →
     `ask_yes_no(overwrite_title/msg)`; builds profile via `build_profile_data(repo_cards,
     include_config_files)`, saves, logs, `show_info(saved_*)`, refreshes list, selects the new
     item, notifies `on_profiles_changed(name)`.
3. **Saved profiles list** (:97-132, 386-441): scrollable frame (height 120, section_alt bg) of
   full-width buttons (selected = `blue` fg, others `neutral`; selection updates only the two
   affected buttons). Selecting also pre-fills the save-name entry (easy overwrite). The whole
   section hides when no profiles exist. Below: `btn_load` (`blue`), `btn_delete` (`danger_deep`),
   `btn_export` (`warning`), each width 100, all guarding "no selection" with
   `show_warning(error_no_selection)`.
   - **Load** (:182-194): loads data or `show_error(error_load_failed)`; then `_apply_profile_data`.
   - **Delete** (:307-321): `ask_yes_no(confirm_delete_*)` → delete, log, refresh,
     `on_profiles_changed()`.
   - **Export** (:323-345): native save-file dialog (`.json`, initial `{name}.json`) →
     `export_profile_to_file`; info/error feedback (`exported_*` / `error_export_failed`).
4. **Import section** (:134-146): `btn_import` (`purple`, width 250) → native open-file dialog →
   `import_profile_from_file`; invalid → `show_error(error_invalid_file)`. Name-collision logic
   (:347-384): if a profile with the same name exists AND content is identical (ignoring
   name/created metadata) → `show_info(no_changes_identical)` and stop; if it exists but differs →
   auto-rename `name1`, `name2`, … The import is staged (`_pending_save_profile_name`) and saved
   only when the options dialog completes.
5. Help text `dialog.profile.help_text` (sm, placeholder color).

**Change preview** (`_build_changes_text`, :220-278): diffs the profile against
`build_profile_data(current cards)` producing lines for: missing repos to clone
(`changes_clone_repo`), per-repo branch changes (`change_branch from→to`) and profile changes
(`change_profile`), and a config-files overwrite summary (`changes_overwrite_files(count)`).
If nothing differs → profile applied directly (`_apply_basic_config`: fire `on_profile_loaded`,
log `log.profile_applied`, `show_info(loaded_*)`, close). Otherwise → **ImportOptionsDialog**.

### ImportOptionsDialog (BaseDialog, 580x650, resizable, minsize 500x500, title
`dialog.import.title`) (:444-891)
Two-step wizard:

**Step 1 — options + preview**:
- Missing-repos block (only when some repos in the profile aren't in the workspace): yellow title
  `missing_repos_title`, truncated name list (≤80 chars), checkbox `clone_missing` (default ON).
- Config-files checkbox `overwrite_files(count)` (default ON when the profile embeds files).
- **Java mappings** (:497-596): versions referenced by the profile but not registered locally each
  get a row `java_needs(version)` + a plain CTkComboBox `[java_default] + local versions` and a
  truncated "used in repo…" hint. Applied as a rewrite of `java_version` in the profile data.
- **Preview textbox** (mono, read-only, live-updated when checkboxes toggle): change lines +
  clone lines (`will_clone(name, branch, java)`) + `will_overwrite(count)`, or
  `no_changes_selected`.
- Buttons: `btn_accept` (`success`, lg, width 150) / `btn.cancel` (`neutral`, lg).

**Step 2 — progress** (replaces step 1 on Accept; buttons disabled, accept text `btn_applying`):
- Title `applying_title`, progress label (starts `preparing`), progress bar, log label
  `log_detail`, read-only mono log box.
- Worker steps (:765-873):
  1. Apply Java mappings.
  2. If cloning: progress label `starting_clone_one/many`; clones run in a 5-worker
     ThreadPoolExecutor; each repo: clone → checkout profile branch; per-repo progress ticks
     (`✅ name` / `❌ Error: name` / `⚠ name: sin URL`); logs `log.import_cloning`,
     `log.import_clone_error`.
  3. Always: merge `saved_environments` + `config_files` from the profile into
     `repo_configs` in the app config, with rename-on-conflict and active-config fixups; renames
     are logged (`[import] Renombres por conflicto: …`). Tick "🗂 Entornos guardados importados".
  4. If overwrite configs: apply embedded config files to each repo dir (5-worker pool), targeting
     the repo's profile env; tick "📝 Config files aplicados".
- Completion (:748-763): bar 1.0, label `completed`, Accept hidden, Cancel becomes a `success`
  **Close** (`btn_close`), `show_info(done_title, log.import_complete)`. Close fires
  `on_complete(profile_data, did_clone)` → ProfileDialog saves a pending imported profile,
  notifies dropdown refresh, applies the profile to the cards, and rescans if anything was cloned
  (:289-305).

---

## 22. Dialog: Settings (+ Java managers)

Source: `gui/dialogs/settings.py`.

### SettingsDialog (BaseDialog, width 580, height auto-fit to content; horizontal-only resize)
(:18-400)
Single-card form; each row = bold label (fixed width 155) + control, separated by 1 px dividers.
Bottom bar: `btn.save_changes` (`success`, lg, width 150) + `btn.cancel` (`neutral`, lg).

Rows:
1. **Language** (`dialog.settings.language_title`): SearchableCombo of available language display
   names (`list_available_languages()`), current from settings `language` (default `en_EN`).
   On save with a CHANGED language: the restart notice is loaded **from
   the NEW language's YAML** (so the message appears in the target language) →
   `show_info(language_restart_title/msg)` (:374-394). Takes effect on next launch.
2. **Workspace** (`workspace_title`): `btn.manage_groups` (`blue`, width 150) → WorkspaceGroupsDialog
   (§24), forwarding `on_groups_changed`.
3. **Behavior** (`behavior_title`): checkbox `minimize_to_tray` (default ON) — gates the
   minimize-to-tray behavior (§25).
4. **Quick access** (`shortcut_title`): OS-adaptive button — Windows `btn.create_shortcut_win` /
   Linux `btn.create_shortcut_linux` (`blue`, width 260) with matching tooltip.
   - Windows (:202-221, 279-370): creates `DevDeck.lnk` on the Desktop via raw COM
     IShellLink ctypes (target `wscript.exe /nologo run.vbs`, icon, workdir); success info shows
     the path; COM errors raise localized `shortcut_err_link/qi/save` with HRESULT.
   - Linux (:223-277): writes a `.desktop` entry (Exec=run.sh, icon, `Terminal=false`) into
     `~/.local/share/applications/` AND the `xdg-user-dir DESKTOP` folder (chmod 700); info lists
     created paths or warns `shortcut_unavailable`.
5. **Java** (`java_title`): `btn.manage_java` (`purple`, width 200) → JavaVersionsManagerDialog;
   count label `java_none_configured` / `java_n_configured(count)` refreshed on return.

Save (:374-400): persists `language`, `java_versions`, `minimize_to_tray` into settings and calls
`on_save` (app `_save_settings` → writes config, invalidates cache, propagates Java versions to
all cards, and rescans if the workspace dir changed — app.py:729-764).

### JavaVersionsManagerDialog (BaseDialog, 560x380, resizable, minsize 420x280) (:403-523)
- Scrollable list of `☕ name` + truncated path (≤38 chars), each with ✏ edit (`warning` sm) and
  🗑 delete (`danger_deep` sm; confirm `java_delete_title/msg`).
- Bottom bar: `btn.autodetect_java` (`purple`, width 150) — merges `auto_detect_java_paths()`
  results (skipping duplicate names/paths); reports `java_detected_msg(added_count)` or, when none
  found, offers manual add via `ask_yes_no(java_not_found_*)`. `btn.add_java` (`neutral`,
  width 130) and `btn.close` (`success`, width 120 — returns the updated map via `on_done`).
- Empty state label `java_no_versions`.

### JavaVersionEditorDialog (BaseDialog, 520x220) (:526-598)
- Title `java_new_title` / `java_edit_title`. Header `java_config_header`.
- Fields: name entry (width 380, placeholder e.g. "Java 17"), path entry (width 330) + 📁 browse
  (native directory chooser, `java_dir_title`).
- Validation: name required (`java_name_required`); path must exist (`java_path_required`); if
  `<path>/bin/java(.exe)` is missing → `ask_yes_no(java_exe_warn_*)` lets the user save anyway.
- Save → `on_save(name, path)`; Cancel closes.

---

## 23. Dialog: Repo Config Manager

Source: `gui/dialogs/repo_config_manager.py` — `RepoConfigManagerDialog(BaseDialog)`, 850x600,
resizable, minsize 700x450, title `⚙ Gestor de Entornos/Apps - {config_key}`.

Manages named environment/app configurations stored per config key (§10) in the app config.

### Layout
- **Left panel** (fixed width 250): header `dialog.env_manager.title`; scrollable list of config
  buttons (selected = `blue` fg, others transparent; dangerous configs are prefixed `⚠ ` and
  rendered in warning yellow); `btn_new` (`blue`) and `btn_auto_import` (`purple_alt`).
- **Right panel**: title var (`select_hint` / `editing(name)`); action buttons `btn_rename`
  (width 90), `btn_duplicate` (width 80) (both `neutral`), `btn_delete` (width 80, `danger`),
  **⚠ danger toggle** (width 32) — all disabled until a config is selected; mono editor textbox;
  bottom-right `btn_save` (`success`).

### Behaviors
- **Selection** (:217-265): switching away from an edited config triggers
  `_check_unsaved_changes` — if the editor text differs from the stored value,
  `ask_yes_no(unsaved_title/msg)` offers to save it. Selecting loads the text, enables buttons,
  syncs the danger toggle styling (yellow bg/border + tooltip `tooltip.mark_danger_on` when
  flagged; neutral + `mark_danger_off` otherwise) (:158-193).
- **Save** (:275-281): stores editor text under the selected name, persists
  (`save_repo_configs`), `show_info(saved_*)`.
- **New / Rename / Duplicate** (:283-333): each uses `_AskNameDialog` (BaseDialog 380x160 — a
  prompt label + entry pre-selected, Accept/Cancel buttons, Return=accept, Escape=cancel,
  blocking). Duplicate pre-fills `{name}_copia`. Name collisions → `show_error(error_duplicate)`.
- **Delete** (:335-343): `ask_yes_no(delete_title/msg)` then removes and clears the editor.
- **Danger toggle** (:158-171): adds/removes the config from the per-key danger set
  (`save_danger_configs`), restyles, refreshes the list (⚠ prefix).
- **Auto-import** (:345-383): collects the repo's env files (filtered to the launching combo's
  source dir when provided), runs `auto_import_configs` (parses existing env files into named
  configs using the repo's `env_patterns`), adds only NEW names, persists, and reports
  `auto_import_success(added)` / `auto_import_exists` / `auto_import_no_files`.
- **Close** (X): unsaved-check, then `on_close` callback (card reloads its combo options), destroy
  (:389-393).

---

## 24. Dialog: Workspace Groups

Source: `gui/dialogs/workspace_groups.py` — `WorkspaceGroupsDialog(BaseDialog)`, 620x480, title
`dialog.workspace_groups.title`.

Data model: `[{name: str, paths: [str]}]` from `get_workspace_groups()`; active group name from
`get_active_group()`.

### Layout (grid)
- **Left column**: label `groups_label`; a native `tk.Listbox` of group names (themed colors:
  card bg, accent selection); buttons `btn.add_group` (`blue` sm) / `btn.delete_group`
  (`danger` sm).
- **Right column**: label `name_label`; name entry (placeholder `name_placeholder`) +
  `btn.rename` (`neutral` sm); label `paths_label`; `tk.Listbox` of the selected group's paths;
  `btn.add_path` (`blue` sm) / `btn.remove_path` (`danger` sm).
- Bottom-right: `btn.save` (`success`).

### Behaviors
- Initial selection: the active group (fallback first) (:117-127).
- **Add group** (:149-163): inserts `new_group_name` (auto-suffixed " 1", " 2"… on collision) with
  empty paths and selects it.
- **Delete group** (:165-179): refuses when only one group remains; reselects a neighbor.
- **Rename** (:181-192): in-place from the entry; silently ignores empty/duplicate names.
- **Add path** (:194-204): native directory chooser; dedup per group; **auto-saves immediately**
  (`set_workspace_groups`) and fires `on_groups_changed(groups)` → topbar refresh + rescan.
- **Remove path** (:206-214): removes the selected path (not persisted until Save).
- **Save** (:216-231): rejects groups with zero paths
  (`show_error(error_empty_paths, names…)`); persists; if the active group no longer exists,
  activates the first; fires `on_groups_changed` only when groups actually changed vs the
  deep-copied initial snapshot; closes.

---

## 25. System tray

Source: `gui/app.py:778-1080` (pystray-based; menu/restore semantics must be replicated with the
Tauri tray API).

### Minimize-to-tray (`_on_window_unmap`, app.py:831-846)
On window `<Unmap>` where `state == 'iconic'` AND setting `minimize_to_tray` is ON:
1. `ToolTip.hide_all()` (a topmost tooltip would otherwise stay painted on the desktop).
2. Snapshot `_pre_tray_state = dict(_last_visible_state)`.
3. The window is **kept iconic, not withdrawn** — only its **taskbar entry is hidden** by flipping
   `WS_EX_TOOLWINDOW`/`WS_EX_APPWINDOW` on the topmost wrapper HWND (Windows-only no-op elsewhere;
   app.py:796-818). Rationale: restore via `deiconify()` is then native-fast (DWM keeps the GDI
   surface; no CTk re-render).
4. Set `_in_tray = True` and spawn the tray icon.

### `_last_visible_state` snapshot pattern (CRITICAL)
- `<Configure>` handler (app.py:820-829): for every configure event on the toplevel while NOT
  iconic/withdrawn, store `{geometry, state, fullscreen}`. This is the ONLY place state is
  snapshotted.
- **Why snapshotting inside `<Unmap>` is forbidden**: by the time `<Unmap>` fires, Tk has already
  transitioned the window to iconic, so `self.state()` and `attributes('-fullscreen')` are stale —
  you would always restore to "iconic". The continuous `<Configure>` snapshot is the last KNOWN
  visible state. (Documented in CLAUDE.md and app.py:120-126.)

### Tray icon lifecycle
- Lazy image cache per color from `assets/icons/icon_{red|green}.ico`; fallback to a solid
  64x64 PIL image (app.py:782-794).
- `_spawn_tray_icon` (app.py:862-875): stops any previous icon first (no orphan icons/threads);
  color green if ANY card is running/starting else red; pystray menu built dynamically at open
  time; `run_detached()`.
- `_tray_icon_alive` (app.py:848-860): checks pystray internals (`_running` flag +
  `_setup_thread.is_alive()`) to detect a dead/never-registered icon.
- **Self-healing** in the 5 s status loop (app.py:1019-1029): if `_in_tray` and the icon died,
  respawn it; if that fails, restore the taskbar entry so the user is never stranded.

### Tray status loop (`_do_update_tray_status`, app.py:1008-1040) — every 5000 ms
- Computes running count; switches the app/window/dialog icons red↔green on transition
  (`_apply_window_icon` also walks open CTkToplevels, app.py:992-1006).
- Updates the tray image and tooltip: `"DevDeck — {running}/{total} corriendo"`
  (hardcoded Spanish — flag for i18n).

### Tray menu (`_build_tray_menu`, app.py:1042-1064) — built dynamically each open
1. `tray.start_selected(count)` — only when ≥1 card selected → `do_start()` each (UI thread).
2. `tray.stop_running(count)` — only when ≥1 running → `do_stop()` each.
3. Separator + one DISABLED line per running service: `"{name} - {label.tray.starting|running}"`.
4. Separator, `tray.show` (**default item** — double-click restores), `tray.quit`
   (→ `_on_close`, includes the confirm-running dialog).

### Restore (`_restore_window`, app.py:887-916)
1. Clear `_in_tray` BEFORE stopping the icon (prevents the self-heal loop respawning during the
   stop→deiconify window); stop the icon.
2. On the UI thread: re-show the taskbar entry, `deiconify()`, then reapply `_pre_tray_state`:
   fullscreen → `-fullscreen True`; zoomed → `state('zoomed')`; else `geometry(snapshot)` +
   `state('normal')` (no snapshot → just normal). `lift()` + `focus_force()`.
3. +50 ms: one-shot `_refresh_all_cards_on_focus` so git badges are fresh immediately.

---

## 26. Profiles subsystem

Source: `gui/app_profile.py` (`ProfileManagerMixin`) + topbar widgets (§2).

A **profile** captures, per repo: branch (optional), env config selection(s) (optional, possibly
per-file), tracked env-file set, custom command, java version, selected flag, docker compose
active files, docker per-file service selections — plus optionally the embedded config file
contents. Profiles are stored PER WORKSPACE GROUP (`load/save/list_profiles(group_name=…)`).

### Dropdown
- Values: `list_profiles(group)` or the sentinel `[label.no_profile]` when none exist
  (app_profile.py:12-18). While a profile is active, the sentinel is hidden from the list
  (refresh logic, :20-33).
- Selecting the sentinel (:43-58): clears current profile name/data, persists empty
  `last_profile_by_group[group]`, sets every card's profile combo to `label.no_selection`, restores
  the dropdown list.
- Selecting a profile (:60-77): load (error → log only), set name+data BEFORE applying (avoids a
  false dirty positive), persist `last_profile_by_group`, refresh dropdown, `_apply_config(data)`.

### Apply (`_apply_config`, :222-277)
- Sets `_current_profile_data`, raises **`_applying_profile = True`** for the duration, applies
  each repo's config to its card, logs `log.config_applied`, then lowers the flag and runs ONE
  `_do_check_profile_changes()` — unless `_skip_dirty_check=True` (startup / card rebuild, where
  async branch loads would race).
- Per-card application (`_apply_config_to_card`, :241-277): branch (+`branch_in_profile` flag;
  absent branch = untracked), profile value + tracked-files semantics (`profile: None` present ⇒
  explicitly untracked; `profile_tracked` list restores per-file checkboxes; legacy profiles
  without it ⇒ all tracked), custom command, java version, selected flag, docker compose actives,
  docker service maps.

### Dirty detection
- **Trigger**: every card-level mutation calls `on_change_callback` →
  `_check_profile_changes` (:97-107): returns immediately while `_applying_profile`;
  otherwise debounce — cancel pending and schedule `_do_check_profile_changes` in 10 ms.
  (Constants define `PROFILE_DEBOUNCE_MS = 300` and docstrings describe a "300 ms burst"; the
  scheduled delay in code is 10 ms — the 300 ms figure is the documented contract for bursts.
  Migration: a 300 ms debounce is the safe interpretation; the essential invariant is
  "many triggers per burst → one check".)
- **Comparison** (`_detect_unsaved_profile_changes` + helpers, :147-220): dirty when repo-name
  sets differ, or any card deviates on: branch tracked-flag/value (:163-173), profile
  tracked-flag/value/per-file set (None/''/{} treated equal) (:175-190), custom command,
  selected flag, docker active files (compared by basename), docker service maps (basename keys,
  sorted lists) (:206-220).
- **Dirty styling** (`_set_profile_combo_dirty`, :109-132): dirty → combo text
  `"{name} *"` (`PROFILE_DIRTY_SUFFIX`), yellow text (`text_warning_badge`), orange border/button
  (`status_logging`), dark-amber bg `#2a1a00`, bold font. Clean → restore profile-accent styling
  and plain name (or `label.no_profile`).

### Quick save (`_save_current_profile`, :79-95)
With an active profile: rebuild profile data from the cards (including config files), save under
the same name/group, refresh dirty state, log `log.profile_saved`. With no active profile: open
the ProfileDialog instead. (Note: currently not bound to a visible button — the 👤 button opens
the manager; keep the function for parity.)

### Group switching interplay (app.py:598-620)
`_on_group_changed`: persist active group, rescan that group's paths; afterwards
`_reload_profiles_for_group`: load the group's `last_profile_by_group` entry, refresh the
dropdown, and apply it (`_skip_dirty_check=True`).

---

## 27. Workspace groups UX

Summary of the flows spread across §2, §4, §24, §26:

- Groups = named sets of directories; exactly one is active. Persisted in
  `devdeck_config.json` (`workspace_groups`, `active_group`) via `core.config_manager`.
- Topbar swap rule: >1 group OR active group with >1 path → group combo replaces the path label.
- Selecting a group: persists, rescans across ALL its paths (repos deduped by path, sorted by
  name), then loads that group's own last profile.
- Groups CRUD dialog reachable from the topbar gear AND Settings → Workspace.
- Add-path is auto-saved + auto-rescans immediately; other edits persist on Save.
- Deleting the active group activates the first remaining one.
- Profiles and "last profile" memory are scoped per group.

---

## 28. Timing, debounce & concurrency table

Constants: `gui/constants.py`. All values must survive the migration (do NOT lower poll
intervals — documented performance constraint).

| Name | Value | Used for | Source |
|---|---|---|---|
| `BADGE_REFRESH_MS` | 30 000 ms | per-card git badge poll loop | _git.py:55 |
| `DOCKER_POLL_MS` | 15 000 ms | per-card compose status poll | _docker.py:161-162 |
| `PROFILE_DEBOUNCE_MS` | 300 ms | documented profile dirty-check debounce (code schedules 10 ms) | app_profile.py:98-107 |
| `FOCUS_REFRESH_DEBOUNCE_MS` | 400 ms | app focus-regain → all-cards refresh | app.py:935 |
| `FOCUS_FETCH_THROTTLE_S` | 300 s | min interval between per-card background fetches on focus | _git.py:30 |
| `GIT_BADGE_SEMAPHORE_COUNT` | 3 | max concurrent `git status` (badges) + branch loads | _git.py:16-17 |
| `GIT_FETCH_SEMAPHORE_COUNT` | 2 | max concurrent `git fetch` | _git.py:18 |
| `LOG_MAX_LINES` | 500 | per-card log trim (embedded, detached, buffer) | log_helpers.py:11 |
| Global log trim | 1000 lines | detached global log textbox | app.py:509 |
| Global log poll | 100 ms | stdout/stderr queue drain | app.py:515 |
| Tray status loop | 5 000 ms | icon color/tooltip + self-heal | app.py:1040 |
| Docker dialog auto-refresh | 5 000 ms | service status in DockerComposeDialog | docker_compose.py:318-319 |
| Global restart delay | 3 000 ms | stop→start gap in GlobalPanel restart | global_panel.py:263 |
| Card restart delay | 300 ms (process) / 2 000 ms (docker) | _actions.py:385-399 |
| Log flash duration | 3 000 ms | orange status-dot flash on log line | _log.py:144 |
| Expanded-restore stagger | 60 ms × open-card index | card rebuild | app.py:656-664 |
| Branch-load stagger | 30 ms × index | card rebuild | app.py:666-669 |
| Badge-start stagger | 3 000 + 500 × index ms | card rebuild | app.py:671-675 |
| Card init timers | branch 200 ms, badge 400 ms, danger badge 300 ms | _base.py:99-101 |
| Docker post-start polls | 0 / 3 000 / 7 000 ms | _docker.py:184-187 |
| Docker prefetch on expand | 600 ms | _expand_panel.py:57 |
| Env-config re-apply on panel build | 500 ms | _expand_panel.py:309 |
| Install timeout | 600 s (kill +5 s) | _actions.py:159-167 |
| Start process wait after EOF | 30 s (kill +5 s) | _actions.py:291-297 |
| Instance-conflict close poll | 300 ms × max 40 (~12 s) | instance_conflict.py:17-18 |
| Tooltip delay | 500 ms (`ui_theme.yml tooltip.delay_ms`) | tooltip.py:11 |
| Combo search debounce | 150 ms (`COMBO_SEARCH_DEBOUNCE`) | searchable_combo.py:438-441 |
| Combo page sizes | first 30 / next 30 (`COMBO_MAX_RENDER_ITEMS`/`COMBO_PAGE_SIZE`) | searchable_combo.py:526 |
| Dialog grab/icon delays | grab +10 ms, icon +200 ms, parent cleanup +50 ms | _base.py:70-72, 240 |
| Per-card action pool | ThreadPoolExecutor(3) | _base.py:75-78 |
| Import clone/config pools | ThreadPoolExecutor(5) | profile.py:709, 869 |
| Repo detection pool | min(8, n) workers (order-preserving) | application/services/project_analyzer.py |

---

## 29. Theme system & design tokens

Sources: `gui/theme.py` + `config/ui_theme.yml`. The YAML is deep-merged over embedded defaults at
import time; the app must start even if the YAML is missing (theme.py:92-116). The YAML is the
user-editable theme → in Angular these become CSS custom properties / a design-token file,
ideally still user-overridable.

### API surface (used by every GUI file)
- `theme.font(size_key, bold=False, mono=False)` → `(family, size[, "bold"])`. Families:
  `Segoe UI` / mono `Consolas`. Sizes: xs 9, sm 10, md 11, base 12, lg 13, xl 14, xxl 15, h2 16,
  h1 22 (theme.py:124-136).
- `theme.btn_style(variant, height="md", width=None, font_size="base")` → kwargs
  `{fg_color, hover_color, border_color, border_width(1), corner_radius(6), height, font[, width]}`
  (theme.py:223-259). Heights: sm 24, md 28, lg 34. **Never pass `font=` alongside it.**
- `theme.combo_style(height="md")` → `{fg_color: section, border_color: default_border,
  button_color: default_border, corner_radius: 6, height, font: base}` (theme.py:262-277).
- `theme.log_textbox_style(detached=False)` → mono sm, bg `app`, text `primary`; embedded adds
  corner 6 + card border, detached is borderless corner 0 (theme.py:280-301).
- `theme.tooltip_colors(mode)` → `(bg, text, border)` per appearance mode; `tooltip_delay()`
  500 ms; `tooltip_wrap()` 250 px (theme.py:304-323).
- `theme.C.*` color namespace, `theme.G.*` geometry namespace, `theme.STATUS_ICONS` /
  `theme.COLORS` status maps (theme.py:139-219).

### Design tokens (actual values from config/ui_theme.yml)

**Geometry** (ui_theme.yml:24-38): corner_btn 6, corner_card 10, corner_panel 8, corner_badge 4,
corner_combo 6, corner_tooltip 6, border_width 1, btn heights 24/28/34, topbar_height 56,
checkbox 18 / sm 16 / corner 4.

**Backgrounds** (:41-48):
| Token | Hex | Usage |
|---|---|---|
| app | `#0f0e26` | root window, topbar, log textboxes |
| card | `#16132e` | collapsed card, dialogs' root |
| card_hover | `#1c1940` | card header hover |
| expand_panel | `#120f28` | expanded accordion body |
| section | `#1e1b4b` | entries, combos, settings frames |
| section_alt | `#0f172a` | dialog list backgrounds |
| divider | `#312e81` | 1 px separators |

**Borders** (:51-55): card `#3b3768`, default `#4338ca`, settings `#312e81`, subtle `#334155`.

**Text** (:58-72): primary `#e0e7ff`, secondary `#c7d2fe`, muted `#94a3b8`, faint `#6b7280`,
placeholder `#888888`, accent `#6366f1`, accent_bright `#818cf8`, warning_badge `#facc15`,
white `#ffffff`; file-selector button colors: light `#333333` / dark `#dddddd`, hover light
`#E3F2FD` / hover dark `#1a2332`.

**Status** (:75-80): running `#22c55e`, starting `#eab308`, stopped `#6b7280`, error `#ef4444`,
logging `#f97316`. STATUS_ICONS/COLORS add `installing: #7c3aed` (purple; theme.py:204-219).

**Button variants** (:84-179) — `fg / hover / border`:
| Variant | fg | hover | border | Semantic use |
|---|---|---|---|---|
| success | #064e3b | #047857 | #10b981 | save/apply/positive |
| start | #144d28 | #16a34a | #22c55e | start service |
| danger | #4c1616 | #dc2626 | #ef4444 | stop service / destructive |
| danger_alt | #7f1d1d | #991b1b | #b91c1c | failed install / unsaved quick-save |
| danger_deep | #450a0a | #dc2626 | #ef4444 | delete profile / docker stop |
| warning | #4a3310 | #d97706 | #f59e0b | restart / reload / export |
| blue | #172554 | #2563eb | #3b82f6 | pull / clone / browse / primary |
| blue_active | #1d4ed8 | #2563eb | #3b82f6 | pull with pending commits |
| neutral | #1e293b | #475569 | #64748b | cancel / settings / misc |
| neutral_alt | #334155 | #475569 | #64748b | installed-ok / file actions |
| purple | #2e1065 | #6d28d9 | #7c3aed | clean / import |
| purple_alt | #4c1d95 | #6d28d9 | #7c3aed | merge / auto-import |
| purple_global | #2e1065 | #9333ea | #a855f7 | (reserved: global panel purple actions) |
| log_action | #1e1b4b | #312e81 | #4338ca | clear/detach log, reload-branch |
| toggle_expand | transparent | #312e81 | #4338ca | card chevron |
| profile_accent | #7c3aed | #6d28d9 | #7c3aed | profile combo accent |

**Docker** (:182-187): btn_stopped_fg `#1e293b`, btn_active_fg `#0f172a`, border_running
`#10b981`, border_active `#3b82f6`, border_stopped `#334155`.

**Tooltip** (:190-198): dark mode bg `#2a2a3e` / text `#e0e0e0` / border `#444466`; light mode bg
`#333344` / text `#f5f5f5` / border `#555577`; delay 500 ms; wrap 250 px.

**Messagebox accents** (messagebox.py:16-21): info `#6366f1`, warning `#f59e0b`, error `#ef4444`,
question `#7c3aed`.

**Misc hardcoded**: profile-dirty combo bg `#2a1a00` (app_profile.py:117); repo type badge bg =
per-type `ui_config.color` from `config/repo_types/*.yml`; default hint color `'#888'`
(status fallback); danger-button override `#4a3310`/`#d97706` (repo_config_manager.py:177-178).

### Assets
`assets/icons/icon_red.ico` (~31 KB) and `assets/icons/icon_green.ico` (~31 KB) — window, tray,
dialog and detached-log icons. Red = idle, green = ≥1 service running/starting.

---

## 30. i18n

Source: `core/i18n.py` + `config/translations/{en_EN,es_ES}.yml` (435 keys each).

- Every user-visible string goes through `t("key", **kwargs)` (Python `.format` interpolation,
  e.g. `t("dialog.clone.error_folder_exists", name=name)`).
- `init_i18n(language_code)` runs once at startup before any widget; language stored in settings
  under `language`; change requires restart (Settings shows the restart notice in the NEW
  language — §22).
- `list_available_languages()` → `[{code, name}]` discovered from the translations folder.
- **Key namespaces** (counts from en_EN.yml): `dialog.merge.*` (42), `dialog.settings.*` (41),
  `tooltip.*` (38), `dialog.profile.*` (37), `btn.*` (32), `log.*` (29), `dialog.env_manager.*`
  (26), `dialog.import.*` (24), `label.*` (18+6 status+2 tray), `docker.*` (14),
  `dialog.clone.*` (12), `dialog.workspace_groups.*` (8), `dialog.instance_conflict.*` (8),
  `misc.*` (6), `install.*` (5), `dialog.confirm_close.*` (5), `dialog.config_editor.*` (5),
  `tray.*` (4), `dialog.pull.*` (4), `placeholder.*` (3), `dialog.reinstall.*` (2),
  `dialog.git.*` (2), `dialog.docker.*` (2), `dialog.clean.*` (2), `dialog.global_log.*` (1),
  `dialog.config.*` (1), `badge.*` (1).
- **Sentinel values that double as state** (must remain comparable after migration — better:
  replace with non-display sentinels): `label.no_profile`, `label.no_selection`,
  `label.java_default`, `label.loading`.
- **Known i18n gaps (hardcoded Spanish/English to fix during migration)**: tray tooltip
  `"… corriendo"` (app.py:1037); docker card status `"Ejecutando (N servicios)"`
  (_docker.py:140); several card log strings (`"Configuración … aplicada."`, `"Deteniendo compose
  inactivo"`, `"Usando JAVA_HOME"`, `"Ejecutando: …"`, `"⏹ Proceso terminado"`, install/compose
  warnings in _actions.py/_docker.py/_base.py); messagebox button labels OK/Yes/No
  (messagebox.py:100-119); compose-button tooltips in `_base.py:322-325`; profile import log
  fragments (`"(con config files)"`, `"[import] …"`); `RepoConfigManagerDialog` window title
  (`"⚙ Gestor de Entornos/Apps"`); duplicate-name suffix `"_copia"`; `_show_loading` uses
  hardcoded `"cargando..."` comparisons in `_header.py:288` and `_git.py:214`.

---

## 31. Tooltip widget

Source: `gui/tooltip.py`.

- `ToolTip(widget, text)`: shows after **500 ms** hover; canceled on `<Leave>` / `<ButtonPress>`.
- Position: below the widget, +12 px x / +4 px y from the widget's root coords; suppressed if the
  pointer already left the widget bounds when the timer fires (:88-104).
- Styled: outer 1 px border frame + inner bg frame (theme tooltip colors per appearance mode),
  md font, wraplength 250 px, left-justified, topmost override-redirect toplevel.
- **Grab interaction**: a class-level registry of active tips enables `ToolTip.hide_all()` —
  called when a modal grabs input or the window hides to tray (the `<Leave>` event would never
  arrive) (:25-49). Additionally `_show` re-checks `grab_current()`: if a DIFFERENT toplevel holds
  the grab, the tooltip is suppressed (closes the race where the timer fires after `grab_set`)
  (:77-86).
- `update_text(text)`: dynamic text update; empty text cancels any pending/visible tip (:153-157).

---

## 32. SearchableCombo widget

Source: `gui/widgets/searchable_combo.py`. Drop-in CTkComboBox replacement used for: branches,
env configs, java versions, profiles, groups, languages, merge selectors.

### Display (collapsed) (:136-224)
- Frame (width/height from `combo_style`) containing: an ellipsized value label (left, `hand2`
  cursor), a 1 px separator, and a `▾` arrow button (width 26).
- Click on label or arrow toggles the popup. Disabled state ignores clicks and greys the label.
- **Ellipsizing**: text measured with the real font; truncated with `…` when overflowing; a
  tooltip with the FULL text is attached only while truncated (:192-224).

### Popup (:236-371)
- A frameless `tk.Toplevel` placed directly below the widget (width = max(widget width, 180)).
  Windows: `overrideredirect`; Linux: `-type popup_menu` WM hint (Wayland focus), X11 fallback to
  overrideredirect.
- Contents: **search entry** (auto-focused, placeholder `placeholder.search`) + a canvas-based
  scrollable list of item buttons.
- **Filtering**: case-insensitive substring; **debounced 150 ms**; empty result shows
  `placeholder.no_results` (:443-473).
- **Infinite scroll**: first page 30 items; +30 more whenever scrolled ≥98.5 % of the way down
  (:520-574). Scroll position preserved when appending.
- **Sizing**: max 9 visible rows (36 px each); scrollbar (width 12) appears only above 9 items;
  popup height = 44 (search area) + canvas height + 4 + 8 (deterministic) (:382-429).
- **Recents separator**: optional `separator_after=N` draws a 1 px divider after the first N items
  — only on the unfiltered list (used by branch/merge combos for "recent vs alphabetical")
  (:512-518, 539-548).
- Item buttons: left-anchored, height 28, selected item highlighted with `section` bg; each has a
  tooltip with the full (untruncated) value (:493-510).
- **Dismissal**: Escape; click outside the popup (global click handler registered +50 ms after
  open so the opening click doesn't insta-close); main-window `<Unmap>` (minimize) closes it;
  widget destroy closes it (:364-379, 576-643).
- **Live refresh**: `configure(values=…, separator_after=…)` while the popup is OPEN re-renders
  the list in place (async branch loads update an open dropdown) (:721-731).
- **Keyboard**: only Escape-to-close and typing in the search field. NO arrow-key navigation or
  Enter-to-select exists — Angular may add it, but parity requires search + click.
- API: `set(value)` (does NOT fire `command` — load-time sets never trigger change handlers — this
  is load-bearing for the merge dialog default-tracking and profile apply), `get()`,
  `configure(values|separator_after|state|command|text_color|font|button_color|…)`, optional
  bound `variable` (used by the Java combo).

---

## 33. Cross-cutting UX details

### Status model (single source of truth per card: `_status`)
States: `stopped`, `starting`, `running`, `error`, `installing`, plus transient visual `logging`.

| State | Dot color | Status text (i18n) | Notes |
|---|---|---|---|
| running | #22c55e green | `label.status.running_port` (with port) | docker cards: `Ejecutando (N servicios)` |
| starting | #eab308 yellow | `label.status.starting` | until ready_pattern/error_pattern |
| stopped | #6b7280 grey | `label.status.stopped` | |
| error | #ef4444 red | `label.status.error` | process died while `starting` |
| installing | #7c3aed purple | `label.status.installing` | install cmd running |
| logging (flash) | #f97316 orange | (unchanged) | 3 s flash per received log line, only while running/starting |

### Window/tray/dialog icon color
Red ico when nothing runs; green ico when ≥1 card is running/starting. Applied to: main window,
every open CTkToplevel, tray icon, detached log windows, new dialogs (BaseDialog reads
`_current_icon_color`).

### Confirm-close flow
§17. Force-close (IPC shutdown request) skips the dialog but still stops services and saves state.

### Instance-conflict flow
§18 — startup-blocking three-way choice with graceful-shutdown polling.

### Profile dirty indicator
Topbar combo turns yellow/orange with `name *` (§26).

### Danger environments
Per-config "dangerous" flag → yellow combo border + header badge `badge.danger_env` (§10, §23).

### Overscroll prevention
Main card list refuses to scroll past its edges and ignores wheel events outside it (§4).

### Buttons reserve space before expanding labels
Recurring Tk pattern (topbar, card header, docker rows): right-side controls are packed first so
text labels can't push them off-screen. In CSS use flex with `flex-shrink: 0` on the controls.

### Thread→UI marshaling
Every background thread updates the UI via `after(0, …)`. In Tauri: events / `invoke` responses on
the main thread. All `winfo_exists()` guards correspond to "component still mounted" checks.

---

## 34. Persistence touched by the GUI

All in `devdeck_config.json` (single file, mtime-cached reads via
`_load_config_cached`; writers must invalidate the cache):

| Key | Written by | Content |
|---|---|---|
| `workspace_dir` | app | last single workspace path (legacy) |
| `workspace_groups`, `active_group` | groups dialog / topbar | `[{name, paths[]}]`, active name |
| `last_profile`, `last_profile_by_group` | profile dropdown | legacy + per-group last profile |
| `repo_state` | app close | per repo: `selected`, `custom_command`, `java_version`, `expanded` |
| `java_versions` | settings | `{name: java_home}` |
| `language` | settings | i18n code |
| `minimize_to_tray` | settings | bool |
| `repo_configs` | repo config manager / import | `{config_key: {name: content}}` |
| `active_configs` | env combo changes | `{config_key: active_name}` |
| danger configs | danger toggle | per config_key set |
| profiles | profile manager | per group, via `core.profile_manager` |

`_save_settings` (app.py:729-757) deliberately preserves `active_configs`/`repo_configs` from
disk over stale in-memory copies before merging — replicate this merge rule or move to granular
storage.
