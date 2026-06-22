/**
 * Tauri-backed implementation of {@link DialogWindowClose} (provided by
 * `dialog-window-host` under the `DIALOG_WINDOW_CLOSE` token). On construction
 * it intercepts THIS window's OS ✕ (always preventing the native destroy) and
 * forwards it to the registered handler — `ui-dialog-shell` registers one so
 * the OS ✕ runs the dialog's close guard, then resolves via `resolve_dialog`.
 *
 * See docs/migration/dialogs-as-windows.md.
 */
import { Injectable, inject } from '@angular/core';

import { TauriBridge } from '../../core/ipc/tauri-bridge';
import type { DialogWindowClose } from '../../ui';

@Injectable()
export class DialogWindowCloseService implements DialogWindowClose {
  private handler: (() => void) | null = null;

  constructor() {
    void inject(TauriBridge).onWindowClosePrevented(() => this.handler?.());
  }

  onRequest(handler: () => void): void {
    this.handler = handler;
  }
}
