/**
 * Detached interactive terminal window — a real PTY shell rendered with
 * xterm.js (design doc 2026-06-14).
 *
 * Rendered INSTEAD of the workspace page when the SPA is loaded with
 * `?terminal=<id>` (see `app.component.ts`); the window itself is created
 * Rust-side by `open_terminal_window`. This component:
 * - binds its output `Channel` via `attach` (raw PTY bytes, ANSI intact →
 *   `xterm.write`); the pre-attach backlog arrives as the first message;
 * - forwards keystrokes (`xterm.onData`) to the PTY (`terminal_write`);
 * - keeps the PTY viewport in sync with the window (fit addon + resize);
 * - kills the PTY when the window closes (`close_terminal`, no confirmation —
 *   closing a terminal window kills its shell).
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  viewChild,
} from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import { IpcCommands } from '../../../core/ipc/commands';
import { IpcEvents } from '../../../core/ipc/events';

@Component({
  selector: 'terminal-window',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './terminal-window.component.scss',
  template: `<div class="term__host" #host></div>`,
})
export class TerminalWindowComponent implements OnInit, OnDestroy {
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  /** Terminal id from the `?terminal=` query param (set by app.component). */
  private readonly id = decodeURIComponent(
    new URLSearchParams(window.location.search).get('terminal') ?? '',
  );

  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unlistenClose: (() => void) | null = null;

  async ngOnInit(): Promise<void> {
    document.title = `${this.id} — DevDeck`;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.host().nativeElement);
    fit.fit();
    this.term = term;
    this.fit = fit;

    // Keystrokes / pasted text → PTY stdin.
    term.onData((data) => void this.commands.terminal.write(this.id, data));

    // PTY output → xterm (raw bytes, ANSI intact). Backlog arrives first.
    await this.commands.terminal.attach(this.id, (bytes) => term.write(bytes));

    // Match the PTY to the current viewport, then follow window resizes.
    await this.pushResize();
    this.resizeObserver = new ResizeObserver(() => {
      this.fit?.fit();
      void this.pushResize();
    });
    this.resizeObserver.observe(this.host().nativeElement);

    term.focus();

    // Kill the PTY when the window closes (design: no confirmation).
    this.unlistenClose = await this.events.onWindowCloseRequested(() =>
      this.commands.terminal.close(this.id),
    );
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.unlistenClose?.();
    this.term?.dispose();
  }

  /** Push the current xterm dimensions to the PTY (SIGWINCH). */
  private pushResize(): Promise<void> {
    const term = this.term;
    if (!term) {
      return Promise.resolve();
    }
    return this.commands.terminal.resize(this.id, term.cols, term.rows);
  }
}
