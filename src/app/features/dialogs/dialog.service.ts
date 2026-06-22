/**
 * Stack-based dialog orchestrator — the v2 replacement for the v1
 * `BaseDialog` zoo (inventory-gui §13-§24).
 *
 * Design:
 * - `stack` is a signal array of {@link DialogEntry}; `app-dialog-host`
 *   renders each entry with `cascadeLevel = index` (the v1 +20px nesting
 *   offset). Multiple dialogs may layer (messagebox over settings, etc.).
 * - Promise-based dialogs (`confirm`, `confirmClose`, prompt, java editor…)
 *   register a resolver; `close(id, result)` resolves it. Closing without an
 *   explicit result resolves the registered fallback (e.g. `false` for
 *   confirms) so ESC/✕ behave like the v1 WM-close → cancel path.
 *
 * NOT migrated — Instance Conflict dialog (inventory-gui §18): v2 uses
 * `tauri-plugin-single-instance`, which prevents a second process from ever
 * reaching the UI and forwards its argv via the `app://single-instance`
 * event instead. There is no "close the others / open anyway" choice to
 * present anymore, so the dialog is intentionally dropped.
 */
import { Injectable, inject, signal, type Type } from '@angular/core';

import { TranslationService } from '../../core/i18n/translation.service';
import { IpcCommands } from '../../core/ipc/commands';
import { IpcEvents } from '../../core/ipc/events';
import { CloneDialogComponent } from './clone/clone-dialog.component';
import { ConfigEditorDialogComponent } from './config-editor/config-editor-dialog.component';
import { ConfirmCloseDialogComponent } from './confirm-close/confirm-close-dialog.component';
import {
  pushEntry,
  removeEntry,
  type DialogEntry,
  type DialogsApi,
} from './dialog-stack';
import { DockerComposeDialogComponent } from './docker-compose/docker-compose-dialog.component';
import { MergeBranchDialogComponent } from './merge-branch/merge-branch-dialog.component';
import { type MessageboxKind } from './messagebox/messagebox.component';
import { openDialogWindowForResult } from './dialog-window.bridge';
// NOTE: ProfileManagerDialogComponent is intentionally NOT imported here —
// see openProfileManager() for the cycle-breaking lazy import.
import { BranchDialogComponent } from './branch/branch-dialog.component';
import { RepoConfigManagerDialogComponent } from './repo-config-manager/repo-config-manager-dialog.component';
import { SettingsDialogComponent } from './settings/settings-dialog.component';
import { StashDialogComponent } from './stash/stash-dialog.component';

@Injectable({ providedIn: 'root' })
export class DialogService implements DialogsApi {
  // Openers for native dialog windows (docs/migration/dialogs-as-windows.md):
  // migrated dialog kinds open a `dlg-*` window instead of pushing the stack.
  private readonly commands = inject(IpcCommands);
  private readonly events = inject(IpcEvents);
  private readonly i18n = inject(TranslationService);

  private readonly _stack = signal<readonly DialogEntry[]>([]);
  private readonly resolvers = new Map<number, (result: unknown) => void>();
  private readonly fallbacks = new Map<number, unknown>();
  private nextId = 1;

  /** Open dialogs, bottom → top. `app-dialog-host` renders this. */
  readonly stack = this._stack.asReadonly();

  // -- generic primitives -----------------------------------------------------

  /** Push a dialog; returns its id (for programmatic `close`). */
  open(component: Type<unknown>, inputs: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    this._stack.update((s) => pushEntry(s, { id, component, inputs }));
    return id;
  }

  /**
   * Push a dialog and resolve when it closes. Closing without an explicit
   * result (ESC / ✕ / backdrop) resolves `fallback`.
   */
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

  /**
   * Close a dialog. `result` (when given) resolves the dialog's promise;
   * otherwise the registered fallback does.
   */
  close(id: number, result?: unknown): void {
    const before = this._stack();
    const after = removeEntry(before, id);
    if (after === before) {
      return; // not open — double-close is a no-op
    }
    this._stack.set(after);
    const resolve = this.resolvers.get(id);
    this.resolvers.delete(id);
    const fallback = this.fallbacks.get(id);
    this.fallbacks.delete(id);
    resolve?.(result === undefined ? fallback : result);
  }

  /** True when any dialog is open (workspace may gate shortcuts on it). */
  hasOpenDialogs(): boolean {
    return this._stack().length > 0;
  }

  // -- contract: feature dialogs (workspace feature calls these) --------------

  /**
   * Open a migrated feature dialog as its own native window
   * (docs/migration/dialogs-as-windows.md). Fire-and-forget — the window owns
   * its lifecycle; cross-window state stays in sync via `config://changed`.
   */
  private openWindow(kind: string, title: string, args: unknown = {}): void {
    void openDialogWindowForResult(
      this.commands,
      this.events,
      kind,
      title,
      args,
      null,
      'main',
    );
  }

  /** Clone-repository dialog (inventory-gui §15). */
  openClone(): void {
    this.open(CloneDialogComponent);
  }

  /**
   * Application settings (+ java managers) dialog (§22). Still in-app: it opens
   * the Java manager and changelog via `dialogs.open()`, which a dialog window
   * cannot do yet — migrate alongside those in a later phase.
   */
  openSettings(): void {
    this.open(SettingsDialogComponent);
  }

  /** Merge-branch dialog with revert support (§20). */
  openMergeBranch(repoName: string): void {
    this.open(MergeBranchDialogComponent, { repoName });
  }

  /** Stash-management dialog (add/list/apply/pop/drop). */
  openStash(repoName: string): void {
    this.open(StashDialogComponent, { repoName });
  }

  /** Branch-management dialog (create/checkout/rename/publish/delete). */
  openBranches(repoName: string): void {
    this.open(BranchDialogComponent, { repoName });
  }

  /** Docker Compose manager for a repo's compose files (§19). */
  openDockerCompose(repoName: string): void {
    this.open(DockerComposeDialogComponent, { repoName });
  }

  /** Per-repo saved environments / app configs manager (§23). */
  openRepoConfigManager(repoName: string): void {
    this.open(RepoConfigManagerDialogComponent, { repoName });
  }

  /**
   * Raw config-file editor (§16). Still in-app: its unsaved-changes guard must
   * intercept the close, which a native window's OS ✕ would bypass — needs the
   * window close-guard mechanism (later phase).
   */
  openConfigEditor(repoName: string, filePath: string): void {
    this.open(ConfigEditorDialogComponent, { repoName, filePath });
  }

  /**
   * Profile save/load/manage + import/export dialog (§21).
   *
   * Loaded LAZILY on purpose — this is the minimal break of the static
   * import cycle `dialog.service → profile-manager-dialog →
   * repo-actions.service / workspace.store → dialog.service`. The dialog
   * class is only needed at runtime when the user opens it, so a dynamic
   * import here removes the cycle edge without touching the workspace
   * services (whose DialogService injection is genuinely runtime).
   * `import type` was not an option: `open()` needs the runtime class.
   */
  openProfileManager(): void {
    void import('./profile-manager/profile-manager-dialog.component').then(
      ({ ProfileManagerDialogComponent }) => this.open(ProfileManagerDialogComponent),
    );
  }

  /** Workspace groups CRUD dialog (§24) — native window. */
  openWorkspaceGroups(): void {
    this.openWindow('workspace-groups', this.i18n.t('dialog.workspace_groups.title'));
  }

  /**
   * Close-with-running-services guard (§17). Resolves `true` when the user
   * confirms closing everything.
   */
  confirmClose(runningCount: number): Promise<boolean> {
    return this.openForResult<boolean>(
      ConfirmCloseDialogComponent,
      { runningCount },
      false,
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

  /**
   * Single-line text prompt. Resolves the entered (trimmed) text, or `null`
   * when cancelled (ESC / ✕ / Cancel — the fallback).
   */
  prompt(
    title: string,
    message: string,
    opts: { initialValue?: string; placeholder?: string } = {},
  ): Promise<string | null> {
    // Migrated to a native window (Phase 2, docs/migration/dialogs-as-windows.md).
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

  /**
   * Messagebox suite — migrated to a native window (Phase 1,
   * docs/migration/dialogs-as-windows.md). Opens a `dlg-messagebox-*` window
   * parented to the main window; resolves via `dialog://resolved` (cancel →
   * the `false` fallback).
   */
  private messagebox(
    kind: MessageboxKind,
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
      'main',
    );
  }
}
