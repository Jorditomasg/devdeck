/**
 * Dialog orchestrator — opens every modal as its OWN native OS window
 * (docs/migration/dialogs-as-windows.md). Public API is unchanged for callers
 * (`openSettings`, `confirm`, `prompt`, …); internally each opens a `dlg-*`
 * window via `openKind`/`openKindForResult` and awaits `dialog://resolved`.
 *
 * This service no longer statically imports any dialog component (the window
 * host resolves components lazily by kind), which also removes the historical
 * `dialog.service → profile-manager → repo-actions` ESM cycle.
 *
 * The legacy in-app `stack` primitives (`open`/`openForResult`/`close`) remain
 * for interface compatibility but are unused now that all dialogs are windows.
 *
 * NOT migrated — Instance Conflict dialog (inventory-gui §18): v2 uses
 * `tauri-plugin-single-instance` (forwards argv via `app://single-instance`).
 */
import { Injectable, inject, signal, type Type } from '@angular/core';

import { TranslationService } from '../../core/i18n/translation.service';
import { IpcCommands } from '../../core/ipc/commands';
import { IpcEvents } from '../../core/ipc/events';
import { pushEntry, removeEntry, type DialogEntry, type DialogsApi } from './dialog-stack';
import { openDialogWindowForResult } from './dialog-window.bridge';
import { type MessageboxKind } from './messagebox/messagebox.component';

@Injectable({ providedIn: 'root' })
export class DialogService implements DialogsApi {
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);
  private readonly i18n = inject(TranslationService);

  private readonly _stack = signal<readonly DialogEntry[]>([]);
  private readonly resolvers = new Map<number, (result: unknown) => void>();
  private readonly fallbacks = new Map<number, unknown>();
  private nextId = 1;

  /** Open dialogs, bottom → top. Rendered by `app-dialog-host` (legacy/unused). */
  readonly stack = this._stack.asReadonly();

  // -- generic window openers (every modal is a native window) ----------------

  /** Open a dialog of `kind` as a window (parented to the main window). */
  openKind(kind: string, inputs: Record<string, unknown> = {}): void {
    void this.openKindForResult(kind, inputs, null);
  }

  /** Open a dialog of `kind` as a window and resolve with its result. */
  openKindForResult<T>(kind: string, inputs: Record<string, unknown>, fallback: T): Promise<T> {
    return openDialogWindowForResult<T>(
      this.commands,
      this.events,
      kind,
      this.titleFor(kind),
      inputs,
      fallback,
      'main',
    );
  }

  /** OS title-bar text for a dialog window (content shows its own full title). */
  private titleFor(kind: string): string {
    if (kind === 'settings') return this.i18n.t('dialog.settings.title');
    if (kind === 'workspace-groups') return this.i18n.t('dialog.workspace_groups.title');
    return 'DevDeck';
  }

  // -- legacy in-app stack primitives (unused; kept for DialogsApi) -----------

  open(component: Type<unknown>, inputs: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    this._stack.update((s) => pushEntry(s, { id, component, inputs }));
    return id;
  }

  openForResult<T>(
    component: Type<unknown>,
    inputs: Record<string, unknown>,
    fallback: T,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const id = this.open(component, inputs);
      this.resolvers.set(id, resolve as (result: unknown) => void);
      this.fallbacks.set(id, fallback);
    });
  }

  close(id: number, result?: unknown): void {
    const before = this._stack();
    const after = removeEntry(before, id);
    if (after === before) {
      return;
    }
    this._stack.set(after);
    const resolve = this.resolvers.get(id);
    this.resolvers.delete(id);
    const fallback = this.fallbacks.get(id);
    this.fallbacks.delete(id);
    resolve?.(result === undefined ? fallback : result);
  }

  /** True when an in-app stack dialog is open (windows are tracked by the OS). */
  hasOpenDialogs(): boolean {
    return this._stack().length > 0;
  }

  // -- contract: feature dialogs (workspace feature calls these) --------------

  /** Clone-repository dialog (inventory-gui §15). */
  openClone(): void {
    this.openKind('clone');
  }

  /** Application settings (+ java managers) dialog (§22). */
  openSettings(): void {
    this.openKind('settings');
  }

  /** Merge-branch dialog with revert support (§20). */
  openMergeBranch(repoName: string): void {
    this.openKind('merge-branch', { repoName });
  }

  /** Stash-management dialog (add/list/apply/pop/drop). */
  openStash(repoName: string): void {
    this.openKind('stash', { repoName });
  }

  /** Branch-management dialog (create/checkout/rename/publish/delete). */
  openBranches(repoName: string): void {
    this.openKind('branch', { repoName });
  }

  /** Docker Compose manager for a repo's compose files (§19). */
  openDockerCompose(repoName: string): void {
    this.openKind('docker-compose', { repoName });
  }

  /** Per-repo saved environments / app configs manager (§23). */
  openRepoConfigManager(repoName: string): void {
    this.openKind('repo-config-manager', { repoName });
  }

  /** Raw config-file editor (§16). */
  openConfigEditor(repoName: string, filePath: string): void {
    this.openKind('config-editor', { repoName, filePath });
  }

  /** Profile save/load/manage + import/export dialog (§21). */
  openProfileManager(): void {
    this.openKind('profile-manager');
  }

  /** Workspace groups CRUD dialog (§24). */
  openWorkspaceGroups(): void {
    this.openKind('workspace-groups');
  }

  /**
   * Close-with-running-services guard (§17). Resolves `true` when the user
   * confirms closing everything.
   */
  confirmClose(runningCount: number): Promise<boolean> {
    return this.openKindForResult<boolean>('confirm-close', { runningCount }, false);
  }

  // -- contract: messagebox suite (v1 gui/dialogs/messagebox.py, §14) ---------

  /** Themed `show_info` replacement. */
  async info(title: string, message: string): Promise<void> {
    await this.messagebox('info', title, message);
  }

  /** Themed `show_warning` replacement. */
  async warning(title: string, message: string): Promise<void> {
    await this.messagebox('warning', title, message);
  }

  /** Themed `show_error` replacement. */
  async error(title: string, message: string): Promise<void> {
    await this.messagebox('error', title, message);
  }

  /** Themed `ask_yes_no` replacement — `true` on Yes. */
  confirm(title: string, message: string): Promise<boolean> {
    return this.messagebox('confirm', title, message);
  }

  /**
   * Single-line text prompt. Resolves the entered (trimmed) text, or `null`
   * when cancelled (ESC / ✕ / Cancel — the fallback).
   */
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
      'main',
    );
  }

  /** Messagebox window (explicit title = the message title). */
  private messagebox(kind: MessageboxKind, title: string, message: string): Promise<boolean> {
    return openDialogWindowForResult<boolean>(
      this.commands,
      this.events,
      'messagebox',
      title,
      { kind, title, message },
      false,
      'main',
    );
  }
}
