import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

/**
 * The 5 persistent service states (inventory-gui §33). `logging` is NOT a
 * state — it is a transient visual flash layered on top (see `flashTick`).
 */
export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'error' | 'installing';

/** How long the orange logging flash holds before reverting (v1: 3000ms). */
export const LOG_FLASH_MS = 3000;

/**
 * Service status indicator dot — replaces the v1 header "🔴" label recolored
 * per status (inventory-gui §6 item 2, colors §33):
 * running green / starting yellow / stopped grey / error red /
 * installing purple, plus the transient orange `logging` flash (§8).
 *
 * Flash contract (mirrors `_flash_log_icon`, gui/repo_card/_log.py):
 * - The container increments `flashTick` once per received log line.
 * - The dot turns orange for 3s, re-flashing resets the timer.
 * - Flashes are honored ONLY while status is running/starting.
 * - Any status change cancels the pending revert so the flash never
 *   overrides a fresh status color.
 *
 * `label` feeds the native title (tooltip-friendly) and aria-label — pass the
 * already-translated status text (i18n stays in the container).
 */
@Component({
  selector: 'ui-status-dot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './status-dot.component.scss',
  template: `
    <span
      class="dot dot--{{ status() }}"
      [class.dot--flash]="flashing()"
      role="status"
      [attr.title]="label() || null"
      [attr.aria-label]="label() || status()"
    ></span>
  `,
})
export class StatusDotComponent {
  /** Current persistent status (single source of truth lives in the store). */
  readonly status = input<ServiceStatus>('stopped');
  /**
   * Monotonic counter: increment to trigger one 3s orange logging flash.
   * 0 (initial) never flashes.
   */
  readonly flashTick = input(0);
  /** Translated status text for title/aria (e.g. `label.status.running_port`). */
  readonly label = input('');

  protected readonly flashing = signal(false);

  private revertTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => clearTimeout(this.revertTimer));

    // Each tick (re)starts the 3s flash — only while running/starting (§8).
    effect(() => {
      const tick = this.flashTick();
      const status = untracked(this.status);
      if (tick <= 0 || (status !== 'running' && status !== 'starting')) {
        return;
      }
      this.flashing.set(true);
      clearTimeout(this.revertTimer);
      this.revertTimer = setTimeout(() => this.flashing.set(false), LOG_FLASH_MS);
    });

    // A status change cancels any pending revert and clears the flash
    // immediately so the new status color wins (§8 "flash never overrides").
    effect(() => {
      this.status();
      clearTimeout(this.revertTimer);
      untracked(() => this.flashing.set(false));
    });
  }
}
