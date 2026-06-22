/**
 * `DialogsApi` implementation used INSIDE a native dialog window
 * (docs/migration/dialogs-as-windows.md). Provided by `dialog-window-host`
 * under the `DIALOGS` token, so dialog components keep calling the same API:
 *
 * - `close(id, result)` → `resolve_dialog(token, result)` (this window's own
 *   token), which emits `dialog://resolved` and closes the window Rust-side.
 *   `undefined` result → cancel (`null`); the opener applies its fallback.
 * - Sub-dialogs (`confirm` / `prompt` / messageboxes) open CHILD windows
 *   parented to THIS window via {@link openDialogWindowForResult}.
 *
 * Feature dialogs (`openSettings`, `openBranches`, …) are not opened from
 * within a dialog window in the migrated phases; they throw until a later
 * phase wires them.
 */
import { Injectable, inject } from '@angular/core';
import type { Type } from '@angular/core';

import { IpcCommands } from '../../core/ipc/commands';
import { IpcEvents } from '../../core/ipc/events';
import type { DialogsApi } from './dialog-stack';
import { openDialogWindowForResult } from './dialog-window.bridge';

function notInWindow(method: string): never {
  throw new Error(`${method}() is not available inside a dialog window`);
}

@Injectable()
export class WindowDialogsApi implements DialogsApi {
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);

  /** This dialog window's own token (= its `dlg-*` label), from `?token=`. */
  private readonly token =
    new URLSearchParams(window.location.search).get('token') ?? '';

  // -- generic primitives -----------------------------------------------------

  open(_component: Type<unknown>, _inputs?: Record<string, unknown>): number {
    return notInWindow('open');
  }

  openForResult<T>(): Promise<T> {
    return notInWindow('openForResult');
  }

  /** Resolve THIS window. `undefined` → cancel (opener applies its fallback). */
  close(_id: number, result?: unknown): void {
    void this.commands.dialog.resolve(this.token, result === undefined ? null : result);
  }

  hasOpenDialogs(): boolean {
    return false;
  }

  // -- messagebox suite (child windows parented to this one) -------------------

  async info(title: string, message: string): Promise<void> {
    await this.box('info', title, message);
  }

  async warning(title: string, message: string): Promise<void> {
    await this.box('warning', title, message);
  }

  async error(title: string, message: string): Promise<void> {
    await this.box('error', title, message);
  }

  confirm(title: string, message: string): Promise<boolean> {
    return this.box('confirm', title, message);
  }

  prompt(
    title: string,
    message: string,
    opts: { initialValue?: string; placeholder?: string } = {},
  ): Promise<string | null> {
    return openDialogWindowForResult<string | null>(
      this.commands,
      this.events,
      'prompt',
      title,
      {
        title,
        message,
        initialValue: opts.initialValue ?? '',
        placeholder: opts.placeholder ?? '',
      },
      null,
      this.token,
    );
  }

  private box(
    kind: 'info' | 'warning' | 'error' | 'confirm',
    title: string,
    message: string,
  ): Promise<boolean> {
    return openDialogWindowForResult<boolean>(
      this.commands,
      this.events,
      'messagebox',
      title,
      { kind, title, message },
      false,
      this.token,
    );
  }

  // -- feature dialogs (wired per migration phase) ----------------------------

  openClone(): void {
    notInWindow('openClone');
  }
  openSettings(): void {
    notInWindow('openSettings');
  }
  openMergeBranch(_repoName: string): void {
    notInWindow('openMergeBranch');
  }
  openStash(_repoName: string): void {
    notInWindow('openStash');
  }
  openBranches(_repoName: string): void {
    notInWindow('openBranches');
  }
  openDockerCompose(_repoName: string): void {
    notInWindow('openDockerCompose');
  }
  openRepoConfigManager(_repoName: string): void {
    notInWindow('openRepoConfigManager');
  }
  openConfigEditor(_repoName: string, _filePath: string): void {
    notInWindow('openConfigEditor');
  }
  openProfileManager(): void {
    notInWindow('openProfileManager');
  }
  openWorkspaceGroups(): void {
    notInWindow('openWorkspaceGroups');
  }
  confirmClose(_runningCount: number): Promise<boolean> {
    return notInWindow('confirmClose');
  }
}
