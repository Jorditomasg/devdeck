/**
 * The ONLY place `@tauri-apps/api` is imported (architecture-v2.md §4,
 * Angular-side dependency rule). Everything else — typed command wrappers,
 * event wrappers, signal stores — talks to Tauri through this injectable, so
 * tests can substitute a structural fake (`tauri-bridge.fake.ts`) without
 * TestBed or module mocking.
 *
 * Deliberately has NO private members: TypeScript structural typing then
 * accepts any object exposing `invoke` + `listen` wherever `TauriBridge` is
 * expected, which is what makes the fake drop-in.
 */
import { Injectable } from '@angular/core';
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type { UnlistenFn };

/** Argument bag of a command invocation (camelCase keys on the wire). */
export type InvokeArgs = Record<string, unknown>;

@Injectable({ providedIn: 'root' })
export class TauriBridge {
  /**
   * Invoke a Rust command. Rejects with an `AppError`-shaped object on
   * command failure (ipc-contract.md §1.3).
   */
  invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    return invoke<T>(command, args);
  }

  /**
   * Subscribe to a Rust-emitted event. The handler receives the payload
   * directly (the Tauri envelope is unwrapped here). Resolves to the
   * unlisten function.
   */
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    return listen<T>(event, (e) => handler(e.payload));
  }

  /**
   * Create a Tauri IPC `Channel` wired to `onMessage`, to be passed as a
   * command argument for point-to-point streaming (e.g. raw PTY output for
   * `attach_terminal`). Confining the `Channel` import here keeps the
   * "@tauri-apps/api only in the bridge" rule intact.
   */
  channel<T>(onMessage: (message: T) => void): Channel<T> {
    const channel = new Channel<T>();
    channel.onmessage = onMessage;
    return channel;
  }

  /**
   * Run `handler` when THIS window is asked to close, before it actually
   * closes (the close waits for the async handler). Used by terminal windows
   * to kill their PTY (`close_terminal`) on close. Resolves to the unlisten.
   */
  onCurrentWindowCloseRequested(
    handler: () => Promise<void> | void,
  ): Promise<UnlistenFn> {
    return getCurrentWindow().onCloseRequested(async () => {
      await handler();
    });
  }

  /**
   * Intercept THIS window's OS close, ALWAYS preventing the default destroy,
   * and run `handler`. Used by dialog windows so the close routes through the
   * dialog's guard and resolves via `resolve_dialog` (Rust destroys the
   * window) — the webview holds no `core:window:*` perms, so it must never
   * call `destroy()` itself (the wrapper would, hence the unconditional
   * `preventDefault`). See docs/migration/dialogs-as-windows.md.
   */
  onWindowClosePrevented(handler: () => void): Promise<UnlistenFn> {
    return getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      handler();
    });
  }

  /**
   * Label of THIS window (`main`, `git-*`, `dlg-*`, …). Detached windows use
   * it as `parentLabel` when opening child dialogs (e.g. the changes window's
   * discard confirm), keeping the `@tauri-apps/api` import confined here.
   */
  currentWindowLabel(): string {
    return getCurrentWindow().label;
  }
}
