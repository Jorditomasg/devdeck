/**
 * Pure status helpers for the repo card header — the EXACT button
 * visibility/enable matrix of inventory-gui.md §6 (`_update_button_visibility`,
 * v1 gui/repo_card/_header.py:240-281), unit-tested in
 * `card-visibility.spec.ts`.
 */
import type { ServiceStatus } from '../../../core/ipc/tauri.types';

/** Header action-row render model. */
export interface HeaderButtonVisibility {
  readonly showStart: boolean;
  readonly showStop: boolean;
  readonly showRestart: boolean;
  readonly startEnabled: boolean;
  readonly stopEnabled: boolean;
  readonly restartEnabled: boolean;
  /** Expand-panel Install button disabled while running or installing (§6). */
  readonly installEnabled: boolean;
}

/** "Running" in v1 matrix terms = a live service process (running/starting). */
export function isActiveStatus(status: ServiceStatus): boolean {
  return status === 'running' || status === 'starting' || status === 'stopping';
}

/**
 * The §6 matrix, keyed on `(installing, running)` exactly as v1 memoized it:
 *
 * | State                | Visible        | Enabled  |
 * |----------------------|----------------|----------|
 * | installing + running | Stop, Restart  | disabled |
 * | installing + stopped | Start          | disabled |
 * | running/starting     | Stop, Restart  | enabled  |
 * | stopped/error        | Start          | enabled  |
 */
export function headerButtonVisibility(
  installing: boolean,
  running: boolean,
): HeaderButtonVisibility {
  if (installing) {
    return running
      ? {
          showStart: false,
          showStop: true,
          showRestart: true,
          startEnabled: false,
          stopEnabled: false,
          restartEnabled: false,
          installEnabled: false,
        }
      : {
          showStart: true,
          showStop: false,
          showRestart: false,
          startEnabled: false,
          stopEnabled: false,
          restartEnabled: false,
          installEnabled: false,
        };
  }
  return running
    ? {
        showStart: false,
        showStop: true,
        showRestart: true,
        startEnabled: false,
        stopEnabled: true,
        restartEnabled: true,
        installEnabled: false,
      }
    : {
        showStart: true,
        showStop: false,
        showRestart: false,
        startEnabled: true,
        stopEnabled: false,
        restartEnabled: false,
        installEnabled: true,
      };
}

/**
 * Convenience adapter for the v2 6-state model: `installing` became a status
 * of its own (it can no longer overlap `running`, ipc-contract.md §1.4), so
 * the matrix collapses to `(status === 'installing', isActive(status))` —
 * plus a dedicated `stopping` row (also a v2 addition): the stop is already
 * in flight, so Stop/Restart stay VISIBLE but DISABLED until the terminal
 * status event lands (double-stop / restart-during-stop guard).
 */
export function visibilityForStatus(status: ServiceStatus): HeaderButtonVisibility {
  if (status === 'stopping') {
    return {
      showStart: false,
      showStop: true,
      showRestart: true,
      startEnabled: false,
      stopEnabled: false,
      restartEnabled: false,
      installEnabled: false,
    };
  }
  return headerButtonVisibility(status === 'installing', isActiveStatus(status));
}

/** The 5 dot states `ui-status-dot` renders (§33 — no `stopping` in v1). */
export type DotStatus = 'stopped' | 'starting' | 'running' | 'error' | 'installing';

/**
 * Map the 6-state service status onto the 5-state dot: `stopping` (a v2
 * addition) renders as the yellow transitional `starting` color.
 */
export function dotStatusFor(status: ServiceStatus): DotStatus {
  return status === 'stopping' ? 'starting' : status;
}
