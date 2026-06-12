import { ChangeDetectionStrategy, Component } from '@angular/core';

import { DialogHostComponent } from './features/dialogs/dialog-host.component';
import { LogWindowComponent } from './features/workspace/log-window/log-window.component';
import { WorkspacePageComponent } from './features/workspace/workspace-page.component';

/**
 * Application shell — router-less (inventory-gui.md §1).
 *
 * Two render modes, decided once at startup from the URL:
 * - default: the workspace page (topbar / global panel / card list / global
 *   log / status bar) plus the dialog stack host;
 * - `?log=<serviceId>`: a detached log window created by the Rust
 *   `open_log_window` command — only the standalone log view, no dialogs.
 *
 * This component stays a thin layout shell: no state, no IPC.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogHostComponent, LogWindowComponent, WorkspacePageComponent],
  template: `
    @if (isLogWindow) {
      <log-window />
    } @else {
      <workspace-page />
      <app-dialog-host />
    }
  `,
})
export class AppComponent {
  /** Render mode — fixed for the lifetime of the window. */
  protected readonly isLogWindow = new URLSearchParams(window.location.search).has('log');
}
