/**
 * Shared base for every dialog container rendered by `app-dialog-host`.
 *
 * The host injects two standard inputs into every dialog component:
 * - `dialogId` — the stack id, needed to close oneself / resolve the promise;
 * - `cascadeLevel` — the stack index, forwarded to `ui-dialog-shell` for the
 *   v1 +20px nesting offset (inventory-gui §13.4).
 */
import { Directive, inject, input } from '@angular/core';

// Deliberately NOT importing DialogService: dialog.service.ts imports every
// dialog component and they all extend this class — a value import here
// closes an ESM cycle that broke module evaluation order in production
// ("class extends value undefined" at startup). See the DIALOGS token doc.
import { DIALOGS } from './dialog-stack';

@Directive()
export abstract class DialogBase {
  /** Stack id assigned by `DialogService.open`. */
  readonly dialogId = input.required<number>();
  /** Stack index — drives the dialog-shell cascade offset. */
  readonly cascadeLevel = input(0);

  protected readonly dialogs = inject(DIALOGS);

  /** Close this dialog, optionally resolving its promise with `result`. */
  protected closeSelf(result?: unknown): void {
    this.dialogs.close(this.dialogId(), result);
  }
}
