/**
 * Host rendered when the SPA boots as a native dialog window
 * (`index.html?dialog=<kind>&token=<token>` — see `app.component`). It:
 *
 * 1. provides `DIALOG_WINDOW_MODE = true` (so `ui-dialog-shell` drops the
 *    backdrop / cascade / in-content ✕ and fills the OS window) and aliases
 *    `DIALOGS` to {@link WindowDialogsApi} (so the dialog's `closeSelf(result)`
 *    resolves the window instead of popping an in-app stack);
 * 2. fetches the window's inputs via `get_dialog_args(token)`;
 * 3. instantiates the component mapped from `<kind>` with those inputs.
 *
 * See docs/migration/dialogs-as-windows.md.
 */
import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  type Type,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';

import { IpcCommands } from '../../core/ipc/commands';
import { DIALOG_WINDOW_CLOSE, DIALOG_WINDOW_MODE } from '../../ui';
import { DialogWindowCloseService } from './dialog-window-close.service';
import { DIALOGS } from './dialog-stack';
import { DIALOG_WINDOW_COMPONENTS } from './dialog-window-registry';
import { WindowDialogsApi } from './window-dialogs-api';

interface RenderedDialog {
  readonly component: Type<unknown>;
  readonly inputs: Readonly<Record<string, unknown>>;
}

@Component({
  selector: 'app-dialog-window-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet],
  providers: [
    { provide: DIALOGS, useClass: WindowDialogsApi },
    { provide: DIALOG_WINDOW_MODE, useValue: true },
    DialogWindowCloseService,
    { provide: DIALOG_WINDOW_CLOSE, useExisting: DialogWindowCloseService },
  ],
  template: `
    @if (rendered(); as r) {
      <ng-container *ngComponentOutlet="r.component; inputs: r.inputs" />
    }
  `,
})
export class DialogWindowHostComponent {
  private readonly commands = inject(IpcCommands);
  private readonly params = new URLSearchParams(window.location.search);
  private readonly kind = this.params.get('dialog') ?? '';
  private readonly token = this.params.get('token') ?? '';

  protected readonly rendered = signal<RenderedDialog | null>(null);

  constructor() {
    afterNextRender(() => void this.load());
  }

  private async load(): Promise<void> {
    const loader = DIALOG_WINDOW_COMPONENTS[this.kind];
    if (!loader) {
      console.error(`unknown dialog kind '${this.kind}'`);
      return;
    }
    const [component, args] = await Promise.all([
      loader(),
      this.commands.dialog.getArgs<Record<string, unknown>>(this.token).catch((err: unknown) => {
        console.error('get_dialog_args failed', err);
        return {} as Record<string, unknown>;
      }),
    ]);
    // dialogId satisfies DialogBase's required input; the window host owns
    // close via WindowDialogsApi, so the numeric id is unused.
    this.rendered.set({
      component,
      inputs: { ...(args ?? {}), dialogId: 0 },
    });
  }
}
