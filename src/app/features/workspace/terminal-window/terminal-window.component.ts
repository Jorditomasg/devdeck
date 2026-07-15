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
 * - keeps the PTY viewport in sync with the window (fit addon + resize).
 *
 * The PTY is killed Rust-side when the OS window closes (`on_window_event`,
 * design decision: closing a terminal window kills its shell). The webview must
 * NOT drive this via `onCloseRequested`: that wrapper calls `window.destroy()`,
 * which the term-* capability denies (no `core:window:*` perms), so the window
 * would never close.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import { TranslationService } from '../../../core/i18n/translation.service';
import { IpcCommands } from '../../../core/ipc/commands';
import { IconComponent } from '../../../ui';

@Component({
  selector: 'terminal-window',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './terminal-window.component.scss',
  imports: [IconComponent],
  template: `
    <div class="term__host" #host></div>
    <button
      type="button"
      class="term__pin"
      [class.term__pin--on]="pinned()"
      [attr.aria-label]="i18n.t('log.always_on_top')"
      [attr.title]="i18n.t('log.always_on_top')"
      (click)="togglePinned()"
    >
      <ui-icon [name]="pinned() ? 'pin-filled' : 'pin'" [size]="16" />
    </button>
    @if (!atBottom()) {
      <button
        type="button"
        class="term__jump"
        [attr.aria-label]="i18n.t('log.jump_to_bottom')"
        [attr.title]="i18n.t('log.jump_to_bottom')"
        (click)="scrollToBottom()"
      >
        <ui-icon name="arrow-down-to-line" [size]="16" />
      </button>
    }
  `,
})
export class TerminalWindowComponent implements OnInit, OnDestroy {
  protected readonly i18n = inject(TranslationService);
  private readonly commands = inject(IpcCommands);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  /** Whether this window is pinned above others (per-window, not persisted). */
  protected readonly pinned = signal(false);
  /** False once the user scrolls up off the bottom — reveals the jump button. */
  protected readonly atBottom = signal(true);

  /** Terminal id from the `?terminal=` query param (set by app.component). */
  private readonly id = decodeURIComponent(
    new URLSearchParams(window.location.search).get('terminal') ?? '',
  );

  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;

  async ngOnInit(): Promise<void> {
    document.title = `${this.id} — DevDeck`;

    // Follow the app's design tokens (xterm needs concrete values at init
    // time, so resolve the CSS custom properties here).
    const css = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string): string =>
      css.getPropertyValue(name).trim() || fallback;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: token('--font-family-mono', 'Consolas, monospace'),
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: token('--color-app', '#0f0e26'),
        foreground: token('--color-text-primary', '#e0e7ff'),
        cursor: token('--color-text-accent-bright', '#818cf8'),
        selectionBackground: token('--color-text-accent', '#6366f1'),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.host().nativeElement);
    fit.fit();
    this.term = term;
    this.fit = fit;

    // Ctrl+C copies when there's a selection, otherwise falls through to the
    // PTY as SIGINT (Windows Terminal behaviour). Returning false stops xterm
    // from emitting the keystroke to onData.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === 'keydown' &&
        e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        e.key === 'c' &&
        term.hasSelection()
      ) {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      return true;
    });

    // Track scroll position for the jump-to-bottom button: onScroll covers user
    // scrolling, onWriteParsed covers new output arriving while scrolled up
    // (baseY grows but the viewport stays put).
    term.onScroll(() => this.refreshAtBottom());
    term.onWriteParsed(() => this.refreshAtBottom());

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
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.term?.dispose();
  }

  /** Toggle "always on top" for this window (Rust owns the window state). */
  protected togglePinned(): void {
    const next = !this.pinned();
    this.pinned.set(next);
    void this.commands
      .setWindowAlwaysOnTop(next)
      .catch((err: unknown) => console.error('set always on top failed', err));
    this.term?.focus();
  }

  /** Scroll the terminal to the newest line. */
  protected scrollToBottom(): void {
    this.term?.scrollToBottom();
    this.refreshAtBottom();
    this.term?.focus();
  }

  /** Recompute whether the viewport sits at the bottom of the scrollback. */
  private refreshAtBottom(): void {
    const buffer = this.term?.buffer.active;
    this.atBottom.set(buffer ? buffer.viewportY >= buffer.baseY : true);
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
