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
