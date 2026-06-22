/**
 * `DialogsApi` implementation used INSIDE a native dialog window
 * (docs/migration/dialogs-as-windows.md). Provided by `dialog-window-host`
 * under the `DIALOGS` token, so dialog components keep calling the same API:
 *
 * - `close(id, result)` → `resolve_dialog(token, result)` (this window's own
 *   token), which emits `dialog://resolved` and closes the window Rust-side.
 *   `undefined` result → cancel (`null`); the opener applies its fallback.
 * - EVERY nested dialog (`confirm`/`prompt`/messagebox, feature dialogs, AND
 *   component-based `open()`/`openForResult()`) opens a CHILD window parented
 *   to THIS window. Component-based calls resolve the component to a `kind` via
 *   its class name (the same kinds the window registry maps).
 */
import { Injectable, inject } from '@angular/core';
import type { Type } from '@angular/core';

import { IpcCommands } from '../../core/ipc/commands';
import { IpcEvents } from '../../core/ipc/events';
import type { DialogsApi } from './dialog-stack';
import { openDialogWindowForResult } from './dialog-window.bridge';

/**
 * Components opened from WITHIN a dialog window via the component-based
 * `open()`/`openForResult()` carry a `static dialogKind`. We key off that (NOT
 * `component.name`, which the production minifier mangles) to resolve the
 * child-window kind. Components only ever opened by `kind` (the common case)
 * don't need it.
 */
interface DialogComponentWithKind {
  readonly dialogKind: string;
}

@Injectable()
export class WindowDialogsApi implements DialogsApi {
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);

  /** This dialog window's own token (= its `dlg-*` label), from `?token=`. */
  private readonly token =
    new URLSearchParams(window.location.search).get('token') ?? '';

  // -- generic primitives -----------------------------------------------------

  /** Open a component-based sub-dialog as a child window (fire-and-forget). */
  open(component: Type<unknown>, inputs: Record<string, unknown> = {}): number {
    void this.openKindForResult(this.kindOf(component), inputs, null);
    return 0; // window-based: no in-app stack id
  }

  openForResult<T>(
    component: Type<unknown>,
    inputs: Record<string, unknown>,
    fallback: T,
  ): Promise<T> {
    return this.openKindForResult(this.kindOf(component), inputs, fallback);
  }

  openKind(kind: string, inputs: Record<string, unknown> = {}): void {
    void this.openKindForResult(kind, inputs, null);
  }

  openKindForResult<T>(kind: string, inputs: Record<string, unknown>, fallback: T): Promise<T> {
    return openDialogWindowForResult<T>(
      this.commands,
      this.events,
      kind,
      'DevDeck',
      inputs,
      fallback,
      this.token,
    );
  }

  /** Resolve a component class to its window kind via `static dialogKind`. */
  private kindOf(component: Type<unknown>): string {
    const kind = (component as Partial<DialogComponentWithKind>).dialogKind;
    if (!kind) {
      throw new Error(
        `component '${component.name}' has no static dialogKind (needed to open it as a window)`,
      );
    }
    return kind;
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
    return this.openKindForResult<boolean>('messagebox', { kind, title, message }, false);
  }

  // -- feature dialogs (child windows parented to this one) -------------------

  openClone(): void {
    this.openKind('clone');
  }
  openSettings(): void {
    this.openKind('settings');
  }
  openMergeBranch(repoName: string): void {
    this.openKind('merge-branch', { repoName });
  }
  openStash(repoName: string): void {
    this.openKind('stash', { repoName });
  }
  openBranches(repoName: string): void {
    this.openKind('branch', { repoName });
  }
  openDockerCompose(repoName: string): void {
    this.openKind('docker-compose', { repoName });
  }
  openRepoConfigManager(repoName: string): void {
    this.openKind('repo-config-manager', { repoName });
  }
  openConfigEditor(repoName: string, filePath: string): void {
    this.openKind('config-editor', { repoName, filePath });
  }
  openProfileManager(): void {
    this.openKind('profile-manager');
  }
  openWorkspaceGroups(): void {
    this.openKind('workspace-groups');
  }
  confirmClose(runningCount: number): Promise<boolean> {
    return this.openKindForResult<boolean>('confirm-close', { runningCount }, false);
  }
}
