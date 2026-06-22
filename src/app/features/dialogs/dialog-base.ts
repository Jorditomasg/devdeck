/**
 * Shared base for every dialog container. Each dialog renders inside its own
 * native window (`dialog-window-host`), which injects `dialogId` — the id
 * passed to `close()` to resolve the dialog's promise.
 */
import { Directive, inject, input } from '@angular/core';

// Deliberately NOT importing DialogService: dialog.service.ts imports every
// dialog component and they all extend this class — a value import here
// closes an ESM cycle that broke module evaluation order in production
// ("class extends value undefined" at startup). See the DIALOGS token doc.
import { DIALOGS } from './dialog-stack';

@Directive()
export abstract class DialogBase {
  /** Id assigned by the window host; passed to `close()` to resolve. */
  readonly dialogId = input.required<number>();

  protected readonly dialogs = inject(DIALOGS);

  /** Close this dialog, optionally resolving its promise with `result`. */
  protected closeSelf(result?: unknown): void {
    this.dialogs.close(this.dialogId(), result);
  }
}
