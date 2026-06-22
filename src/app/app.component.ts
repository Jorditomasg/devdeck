import { ChangeDetectionStrategy, Component } from '@angular/core';

import { DialogHostComponent } from './features/dialogs/dialog-host.component';
import { DialogWindowHostComponent } from './features/dialogs/dialog-window-host.component';
import { LogWindowComponent } from './features/workspace/log-window/log-window.component';
import { TerminalWindowComponent } from './features/workspace/terminal-window/terminal-window.component';
import { WorkspacePageComponent } from './features/workspace/workspace-page.component';

/**
 * Application shell — router-less (inventory-gui.md §1).
 *
 * Render modes, decided once at startup from the URL:
 * - default: the workspace page (topbar / global panel / card list / global
 *   log / status bar) plus the dialog stack host;
 * - `?log=<serviceId>`: a detached log window created by the Rust
 *   `open_log_window` command — only the standalone log view, no dialogs;
 * - `?terminal=<id>`: a detached interactive terminal window created by
 *   `open_terminal_window` — only the xterm.js terminal (design doc 2026-06-14);
 * - `?dialog=<kind>`: a native dialog window created by `open_dialog_window`
 *   — only the dialog component for `<kind>` (docs/migration/dialogs-as-windows.md).
 *
 * This component stays a thin layout shell: no state, no IPC.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DialogHostComponent,
    DialogWindowHostComponent,
    LogWindowComponent,
    TerminalWindowComponent,
    WorkspacePageComponent,
  ],
  template: `
    @if (isTerminalWindow) {
      <terminal-window />
    } @else if (isLogWindow) {
      <log-window />
    } @else if (isDialogWindow) {
      <app-dialog-window-host />
    } @else {
      <workspace-page />
      <app-dialog-host />
    }
  `,
})
export class AppComponent {
  private readonly params = new URLSearchParams(window.location.search);
  /** Render mode — fixed for the lifetime of the window. */
  protected readonly isLogWindow = this.params.has('log');
  protected readonly isTerminalWindow = this.params.has('terminal');
  protected readonly isDialogWindow = this.params.has('dialog');
}
