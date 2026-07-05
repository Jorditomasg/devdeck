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
 * Component-based opens (`open`/`openForResult`/`close`) only happen INSIDE a
 * dialog window (handled by `WindowDialogsApi`); the main window opens dialogs
 * by `kind` only. They exist here solely to satisfy `DialogsApi`.
 *
 * NOT migrated — Instance Conflict dialog (inventory-gui §18): v2 uses
 * `tauri-plugin-single-instance` (forwards argv via `app://single-instance`).
 */
import { Injectable, inject, type Type } from '@angular/core';

import { TranslationService } from '../../core/i18n/translation.service';
import { IpcCommands } from '../../core/ipc/commands';
import { IpcEvents } from '../../core/ipc/events';
import type { RepoOverwriteDiff } from '../../core/state/profiles.store';
import { type DialogsApi } from './dialog-stack';
import { openDialogWindowForResult } from './dialog-window.bridge';
import { type MessageboxKind } from './messagebox/messagebox.component';

@Injectable({ providedIn: 'root' })
export class DialogService implements DialogsApi {
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);
  private readonly i18n = inject(TranslationService);

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
    if (kind === 'command-profile-manager') return this.i18n.t('label.command_profile');
    return 'DevDeck';
  }

  // -- DialogsApi contract: component-based opens are window-only -------------
  // The main window never opens a dialog component in-app — these are reached
  // only via `WindowDialogsApi` inside a dialog window.

  open(_component: Type<unknown>, _inputs?: Record<string, unknown>): number {
    throw new Error('DialogService.open: component dialogs are window-only');
  }

  openForResult<T>(_component: Type<unknown>, _inputs: Record<string, unknown>, _fallback: T): Promise<T> {
    throw new Error('DialogService.openForResult: component dialogs are window-only');
  }

  /** No in-app stack on the main window; dialog windows resolve themselves. */
  close(_id: number, _result?: unknown): void {}

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

  /** Docker Compose manager, locked to the picked compose file (§19). */
  openDockerCompose(
    repoName: string,
    composeFile?: string,
    seed?: { services?: readonly string[]; active?: boolean },
  ): void {
    this.openKind('docker-compose', {
      repoName,
      composeFile: composeFile ?? '',
      selectedServices: seed?.services ?? [],
      active: seed?.active ?? false,
    });
  }

  /** Per-repo saved environments / app configs manager (§23). Resolves when the window closes. */
  openRepoConfigManager(repoName: string): Promise<unknown> {
    return this.openKindForResult('repo-config-manager', { repoName }, null);
  }

  /** Per-repo start-command profiles manager. Resolves when the window closes. */
  openCommandProfileManager(repoName: string): Promise<unknown> {
    return this.openKindForResult('command-profile-manager', { repoName }, null);
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

  /**
   * Second-instance ("already running") prompt. Opened WITHOUT a parent on
   * purpose: dialog windows are owned by `main`, and a Windows owned window is
   * hidden together with its owner — but this fires precisely when `main` may
   * be minimized to the tray. Detached = top-level = visible regardless.
   * Resolves `true` when the user chooses to restore the running window.
   */
  confirmSecondInstance(): Promise<boolean> {
    const title = this.i18n.t('dialog.single_instance.title');
    return openDialogWindowForResult<boolean>(
      this.commands,
      this.events,
      'messagebox',
      title,
      { kind: 'confirm', title, message: this.i18n.t('dialog.single_instance.message') },
      false,
      undefined, // no parent → shows even while main is in the tray
    );
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

  /** Rich save-overwrite confirm (per-repo before→after diff). `true` on confirm. */
  confirmOverwrite(name: string, diff: readonly RepoOverwriteDiff[]): Promise<boolean> {
    return this.openKindForResult<boolean>('overwrite-confirm', { name, diff }, false);
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
