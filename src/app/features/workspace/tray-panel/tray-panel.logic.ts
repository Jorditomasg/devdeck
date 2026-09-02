/**
 * Pure view-model logic for the tray quick-control panel
 * (docs/superpowers/specs/2026-06-23-tray-panel-design.md).
 *
 * Kept free of Angular/IPC so the selection + status→affordance rules are unit
 * tested directly. The component wires signals into these functions.
 */
import type { RepoInfo, ServiceStatus } from '../../../core/ipc/tauri.types';
import { dockerCardStatus, serviceUrl } from '../repo-card/card-logic';
import { orderedRepos } from '../workspace-list.logic';
import { isDockerRepo } from '../workspace-logic';

/** Minimal selection shape read from `SettingsStore.repoStates()`. */
export type SelectionMap = Readonly<
  Record<
    string,
    {
      readonly selected?: boolean;
      readonly order?: number;
      /** Selected JDK label — the card's start/restart override (§7 row 2b). */
      readonly java_version?: string;
    }
  >
>;

/** One row in the tray panel — a selected repo with its live runtime view. */
export interface PanelService {
  /** Service id = repo name (multi-module repos use the primary id). */
  readonly id: string;
  readonly name: string;
  readonly status: ServiceStatus;
  readonly port?: number;
  /** Clickable browser URL — only set while running with a known port. */
  readonly url: string | null;
  /**
   * Compose files of a docker-managed repo, EMPTY for a process repo. Both the
   * status source and the lifecycle branch hang off this: a non-empty list
   * means the row is driven by compose up/down and polled through
   * `docker_compose_status`, never through the process registry.
   */
  readonly composeFiles: readonly string[];
}

/**
 * A status counts as "running" for the panel affordances (stop/restart shown,
 * start hidden) while it has — or is acquiring — a live process. Mirrors the
 * card's start/stop swap; `stopping` keeps the stop affordances until the
 * terminal `stopped` arrives.
 */
export function isRunning(status: ServiceStatus): boolean {
  return status === 'running' || status === 'starting' || status === 'stopping';
}

/**
 * Selected repos. Selection lives in config `repo_state[name].selected`, but
 * it is only persisted when the user TOGGLES a card — repos left at the v1
 * default (selected) have no entry. So the rule is "selected unless explicitly
 * deselected": absent/true ⇒ shown, only `selected: false` is excluded.
 */
export function selectedRepos(
  repos: readonly RepoInfo[],
  selection: SelectionMap,
): readonly RepoInfo[] {
  return repos.filter((r) => selection[r.name]?.selected !== false);
}

/**
 * Build the panel rows from repos + selection + the live runtime lookups.
 * Rows follow the main window's display order (persisted `repo_state.order`
 * over the FULL repo list, alphabetical baseline), then drop deselected repos.
 *
 * A docker-managed repo takes its status from `dockerRunning` (running
 * container count, from `docker_compose_status`) exactly like the card does —
 * it has no supervised process, so `statusFor` would report it `stopped`
 * forever and the row would only ever offer a Start button.
 */
export function buildPanelServices(
  repos: readonly RepoInfo[],
  selection: SelectionMap,
  statusFor: (id: string) => ServiceStatus,
  portFor: (id: string) => number | undefined,
  dockerRunning: Readonly<Record<string, number>> = {},
): readonly PanelService[] {
  const ordered = orderedRepos(repos, (name) => selection[name]?.order);
  return selectedRepos(ordered, selection).map((repo) => {
    const docker = isDockerRepo(repo);
    const status = docker
      ? dockerCardStatus(dockerRunning[repo.name] ?? 0)
      : statusFor(repo.name);
    const port = portFor(repo.name);
    return {
      id: repo.name,
      name: repo.name,
      status,
      port,
      url: isRunning(status) ? serviceUrl(port, repo.contextPath) : null,
      composeFiles: docker ? repo.dockerComposeFiles : [],
    };
  });
}

/** Ids of selected services currently running — the "Stop all" targets. */
export function runningIds(services: readonly PanelService[]): readonly string[] {
  return services.filter((s) => isRunning(s.status)).map((s) => s.id);
}

/** Ids of selected services currently stopped — the "Start all" targets. */
export function stoppedIds(services: readonly PanelService[]): readonly string[] {
  return services.filter((s) => !isRunning(s.status)).map((s) => s.id);
}
