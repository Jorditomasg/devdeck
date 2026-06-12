/**
 * Pure docker-compose dialog logic (inventory-gui §19): status folding and
 * the running counters shown in the header.
 */
import type {
  ComposeService,
  DockerServiceState,
} from '../../../core/ipc/tauri.types';

/** Per-service state map (service name → running/stopped). */
export type StatusMap = Readonly<Record<string, DockerServiceState>>;

/** v1 §19 dialog auto-refresh cadence (5000 ms while the switch is ON). */
export const DIALOG_REFRESH_MS = 5000;

/** Default `docker compose logs` tail length for the bottom panel. */
export const LOGS_TAIL = 200;

/** Basename of a compose file path (the v1 window title `…- {basename}`). */
export function composeBasename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** State of one service; unknown/never-reported ⇒ `stopped` (ipc §3). */
export function serviceState(
  status: StatusMap,
  name: string,
): DockerServiceState {
  return status[name] ?? 'stopped';
}

/** Count of services currently `running` among the parsed compose services. */
export function countRunning(
  services: readonly ComposeService[],
  status: StatusMap,
): number {
  return services.filter((s) => serviceState(status, s.name) === 'running').length;
}

/**
 * Fold a `docker://status` payload into the current map. The poller reports
 * the union of the repo's tracked services (possibly spanning several
 * compose files), so merging — not replacing — keeps states for services of
 * non-selected files.
 */
export function mergeStatus(current: StatusMap, incoming: StatusMap): StatusMap {
  return { ...current, ...incoming };
}
