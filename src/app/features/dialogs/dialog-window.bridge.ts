/**
 * Opener-side helper for native dialog windows
 * (docs/migration/dialogs-as-windows.md).
 *
 * Opens a `dlg-*` window and resolves when it emits `dialog://resolved` for
 * its token. A `null` result means the dialog was cancelled (✕ / ESC) → the
 * registered `fallback` is returned, mirroring the in-app stack's
 * `close(id, result?)` fallback semantics.
 *
 * Used by BOTH openers: `DialogService` (main window, `parentLabel: 'main'`)
 * and `WindowDialogsApi` (a dialog window opening a child sub-dialog, parented
 * to itself).
 */
import type { IpcCommands } from '../../core/ipc/commands';
import type { IpcEvents } from '../../core/ipc/events';

export function openDialogWindowForResult<T>(
  commands: IpcCommands,
  events: IpcEvents,
  kind: string,
  title: string,
  args: unknown,
  fallback: T,
  parentLabel?: string,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let token: string | null = null;
    let unlisten: (() => void) | null = null;
    let settled = false;

    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      unlisten?.();
      resolve(value);
    };

    // Subscribe BEFORE opening so a fast resolution cannot be missed; the
    // handler is inert until `token` is known (set right after the window is
    // created, well before it can load + resolve).
    void (async () => {
      unlisten = await events.onDialogResolved((event) => {
        if (token !== null && event.token === token) {
          finish(event.result === null ? fallback : (event.result as T));
        }
      });
      try {
        token = await commands.dialog.openWindow(kind, title, args, parentLabel);
      } catch (err: unknown) {
        console.error(`open dialog window '${kind}' failed`, err);
        finish(fallback);
      }
    })();
  });
}
