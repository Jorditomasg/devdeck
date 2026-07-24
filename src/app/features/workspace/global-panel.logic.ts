/**
 * Pure helpers for the global panel's one-row command bar (§3): the selection
 * readout that drives the tri-state checkbox, the `n/N` counter and the button
 * counts, plus "how many of the selected repos are actually alive" — the scope
 * of the Stop confirmation, because confirming a stop for repos that are
 * already stopped is pure noise.
 */
import type { ServiceStatus } from '../../core/ipc/tauri.types';
import { ACTIVE_STATUSES } from '../../core/state/services.store';

export interface SelectionCounts {
  readonly selected: number;
  readonly total: number;
}

export function selectionCounts(
  names: readonly string[],
  isSelected: (name: string) => boolean,
): SelectionCounts {
  return { selected: names.filter((name) => isSelected(name)).length, total: names.length };
}

/**
 * Selected repos with a live OS process. Docker-compose repos managed outside
 * the service registry read as not-alive here — same blind spot the batch stop
 * itself has (it goes through `services.stop`), so the confirmation matches
 * what the action really does.
 */
export function activeAmong(
  names: readonly string[],
  statusOf: (name: string) => ServiceStatus | undefined,
): number {
  return names.filter((name) => {
    const status = statusOf(name);
    return status !== undefined && ACTIVE_STATUSES.includes(status);
  }).length;
}
