# Git worktrees — design

Date: 2026-10-12 · Status: approved (brainstorming)

## Goal

Manage the git worktrees of each repo easily (create / delete / prune / open)
and run several worktrees of the same repo in parallel, each on its own port,
from a "Worktrees" section nested in the parent repo card.

Note: `src-tauri/src/git/worktree.rs` is the WORKING TREE (changes window). The
new git-worktree module is `git/worktrees.rs` (plural).

## Model

- A worktree is a child `RepoInfo`: `name = "<repo>@<folder>"`,
  `parent = Some("<repo>")`, `worktreeBranch = Some(branch)` (None = detached).
  It is detected with the normal pipeline on its own path, so modules/commands
  follow the worktree's branch.
- Service ids keep the `::` module separator: `repo@wt::module`.
  `find_repo_for_service` is unchanged (it matches `r.name`).
- Process registry is keyed by service id ⇒ parallel runs need no lifecycle
  change.

## Disk layout

`<root>/<repo>.worktrees/<folder>` where `<folder>` = branch with `/` and other
path-unsafe chars replaced by `-`. Sibling of the parent ⇒ same filesystem
(Windows or WSL distro) as the parent; git routing (`git/exec.rs`) applies
unchanged. The workspace scanner skips `*.worktrees` directories.

## Scan

For every detected git repo (top-level only), `git worktree list --porcelain`
(shared badge semaphore). Every non-main, non-bare entry whose folder exists is
detected and appended as a child `RepoInfo`. Missing folders are ignored (the
"Clean" action prunes them).

## Config inheritance

Per field, a worktree with no value of its own reads its parent's: command
profile (`commands/process.rs::resolved_command_override`), active Spring
environment (`spring_profile_env`) and JDK label (frontend
`RepoActionsService.startOverrides`). Writes go to the worktree's own key — it
inherits until changed.

## Ports

- `AppConfig.worktree_ports: { "repo@wt": u16 }`.
- Suggestion: first port > parent's `server_port` (or the last assigned) not in
  `worktree_ports` and bindable (`port_bindable`).
- Injection: repo-type YAML `run.port_injection: { env: NAME }` or
  `{ arg: "--port {port}" }`. Spring → `env: SERVER_PORT`, React →
  `env: PORT`, Angular / Nx → `arg: "--port {port}"`. A worktree service with a
  port and an injection rule gets it at start; without a rule it starts
  unchanged and the UI says "port not configurable".

## IPC (113 → 118 commands, no new events)

User repo-type overrides in the OS config dir do not inherit the bundled
`port_injection` — add it there too to get per-worktree ports.

| Command | Args | Returns |
|---|---|---|
| `git_worktree_suggest_port` | `repoName` | `number \| null` |
| `git_worktree_add` | `repoName, branch, mode: "new"\|"existing"\|"remote", base?, port?` | `OpOutput & { name? }` |
| `git_worktree_remove` | `name, force` | `OpOutput` |
| `git_worktree_prune` | `repoName` | `OpOutput` |
| `set_worktree_port` | `name, port \| null` | `()` |

After add / remove / prune the frontend re-runs the existing workspace scan
(`ReposStore.rescan`). Deleting the branch reuses `git_delete_branch`.

### Remove order

stop every running service `name` / `name::*` (normal escalation) →
`git worktree remove [--force] <path>` (run in the parent) → drop the worktree's
own config (port, `repo_state`, command profiles, `name::*` active envs). The
frontend then optionally deletes the branch (`git_delete_branch`, `-d`, then
`-D` after a second confirm when git says "not fully merged").

## UI

- Parent card: collapsible "Worktrees (N)" section with `+ New` and `Clean`;
  "New worktree" also in the card context menu. Children are filtered out of
  the top-level list (profiles, ordering, selection keep working on top-level
  repos only).
- Worktree row (presentational, `ui/`): branch, port (editable), status,
  start/stop/restart, logs, open folder (opener plugin `openPath`), terminal
  (existing terminal window), git history (existing git window), delete.
- New-worktree dialog (`worktree-add` window kind): mode new / existing,
  branch, base, port (pre-filled with the suggestion), read-only target path.
  An existing branch missing from the local list is remote-only → `remote`
  mode with base `origin/<branch>`.
- Delete: confirm (warns dirty per git badge / running "will be stopped") →
  remove (forced when dirty; a git "modified or untracked" refusal offers
  force) → confirm "also delete branch" → `-d`, then `-D` after confirm.

## Errors

Every git failure returns `OpOutput { ok: false, message }` (git stderr) shown
as a toast + ops log. Rust validates before calling git: branch name
(`git check-ref-format --branch`), target folder must not exist, port 1–65535
and not used by another worktree, worktree name must exist.

## Tests

Rust: porcelain parser (main / detached / bare / locked / prunable), branch →
folder sanitizing, port suggestion, config fallback, port injection on the
resolved command, scanner skips `*.worktrees`.
Frontend: parent/children grouping, command count 113 → 118.
