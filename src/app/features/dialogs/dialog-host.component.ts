/**
 * Renders the open dialog stack (one component per {@link DialogEntry}),
 * passing `dialogId` and `cascadeLevel = stack index` to each. Mount once in
 * the app shell:
 *
 * ```html
 * <app-dialog-host />
 * ```
 *
 * ESC/backdrop behavior and footer buttons live inside each dialog component
 * (they own their `ui-dialog-shell`); the host only materializes the stack.
 */
import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type Type,
} from '@angular/core';

import { DialogService } from './dialog.service';

interface RenderedEntry {
  readonly id: number;
  readonly component: Type<unknown>;
  readonly inputs: Readonly<Record<string, unknown>>;
}

@Component({
  selector: 'app-dialog-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet],
  template: `
    @for (entry of entries(); track entry.id) {
      <ng-container *ngComponentOutlet="entry.component; inputs: entry.inputs" />
    }
  `,
})
export class DialogHostComponent {
  protected readonly dialogs = inject(DialogService);

  /** Input maps are built once per stack change (zoneless-safe, no churn). */
  protected readonly entries = computed<readonly RenderedEntry[]>(() =>
    this.dialogs.stack().map((entry, index) => ({
      id: entry.id,
      component: entry.component,
      inputs: { ...entry.inputs, dialogId: entry.id, cascadeLevel: index },
    })),
  );
}
