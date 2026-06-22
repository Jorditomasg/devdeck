import { InjectionToken } from '@angular/core';

/**
 * True when a dialog renders inside its OWN native OS window (`?dialog=`),
 * provided by `app-dialog-window-host`. Default `false` → the in-app stack
 * (backdrop + cascade). `ui-dialog-shell` reads this to drop the backdrop /
 * cascade / in-content ✕ (the OS title bar provides the close) and fill the
 * window. See docs/migration/dialogs-as-windows.md.
 *
 * Lives in `ui/` (not `core/`) so the pure `ui-dialog-shell` can inject it
 * without breaking the `ui → nothing` dependency rule; the feature side
 * provides it from the same token.
 */
export const DIALOG_WINDOW_MODE = new InjectionToken<boolean>('DIALOG_WINDOW_MODE', {
  factory: () => false,
});

/**
 * Bridge for the OS window-close request inside a dialog window. The host
 * provides an implementation that intercepts the native ✕ (preventing the
 * default close); `ui-dialog-shell` registers a callback so the OS ✕ routes
 * through the SAME `closed` path as ESC / in-content ✕ — preserving each
 * dialog's close guard (e.g. config-editor's unsaved-changes prompt). Without
 * this, the OS ✕ would close the window and bypass the guard (data loss).
 *
 * Lives in `ui/` so the pure shell can inject it; the feature host provides the
 * Tauri-backed implementation. `null` outside a dialog window (in-app stack).
 */
export interface DialogWindowClose {
  /** Register the handler fired when the OS window close is requested. */
  onRequest(handler: () => void): void;
}

export const DIALOG_WINDOW_CLOSE = new InjectionToken<DialogWindowClose | null>(
  'DIALOG_WINDOW_CLOSE',
  { factory: () => null },
);
