/**
 * The `DIALOGS` injection token and the `DialogsApi` contract both providers
 * fulfil — `DialogService` (main window) and `WindowDialogsApi` (inside each
 * native dialog window).
 */
import { InjectionToken, type Type } from '@angular/core';

/**
 * Injection token for the dialog orchestrator, typed by {@link DialogsApi}.
 *
 * Dialog components (via `DialogBase`) inject THIS token instead of the
 * concrete `DialogService` class: `dialog.service.ts` statically imports
 * every dialog component, and every component imports `dialog-base.ts` — if
 * dialog-base imported the service back, the bundler would have to break the
 * ESM cycle somewhere and `XDialogComponent extends DialogBase` can then
 * evaluate before DialogBase's module body runs ("class extends value
 * undefined" at startup — observed in production, 2026-06-12). The alias
 * `{ provide: DIALOGS, useExisting: DialogService }` lives in `app.config.ts`
 * (composition root, outside every cycle).
 */
export const DIALOGS = new InjectionToken<DialogsApi>('DIALOGS');

/**
 * Public surface of the dialog orchestrator — mirror of `DialogService`
 * (which `implements` it; keep both in sync).
 */
export interface DialogsApi {
  open(component: Type<unknown>, inputs?: Record<string, unknown>): number;
  openForResult<T>(
    component: Type<unknown>,
    inputs: Record<string, unknown>,
    fallback: T,
  ): Promise<T>;
  /**
   * Open a dialog by `kind` as a native window (docs/migration/dialogs-as-windows.md).
   * Fire-and-forget — the window owns its lifecycle.
   */
  openKind(kind: string, inputs?: Record<string, unknown>): void;
  /** Open a dialog by `kind` as a native window and resolve with its result. */
  openKindForResult<T>(kind: string, inputs: Record<string, unknown>, fallback: T): Promise<T>;
  close(id: number, result?: unknown): void;
  openClone(): void;
  openSettings(): void;
  openMergeBranch(repoName: string): void;
  openStash(repoName: string): void;
  openBranches(repoName: string): void;
  openDockerCompose(repoName: string, composeFile?: string): void;
  /** Per-repo saved environments / app configs manager. Resolves when the window closes. */
  openRepoConfigManager(repoName: string): Promise<unknown>;
  /** Per-repo start-command profiles manager. Resolves when the window closes. */
  openCommandProfileManager(repoName: string): Promise<unknown>;
  openConfigEditor(repoName: string, filePath: string): void;
  openProfileManager(): void;
  openWorkspaceGroups(): void;
  confirmClose(runningCount: number): Promise<boolean>;
  info(title: string, message: string): Promise<void>;
  warning(title: string, message: string): Promise<void>;
  error(title: string, message: string): Promise<void>;
  confirm(title: string, message: string): Promise<boolean>;
  prompt(
    title: string,
    message: string,
    opts?: { initialValue?: string; placeholder?: string },
  ): Promise<string | null>;
}
