/**
 * Pure dialog-stack primitives — the testable core of `DialogService`.
 *
 * The stack is an ordered list (bottom → top) of open dialogs; the index of
 * an entry IS its cascade level (v1 BaseDialog nesting offset, inventory-gui
 * §13.4). Multiple dialogs may layer (e.g. a messagebox over settings over
 * nothing), each rendered by `app-dialog-host` with `cascadeLevel = index`.
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
  close(id: number, result?: unknown): void;
  hasOpenDialogs(): boolean;
  openClone(): void;
  openSettings(): void;
  openMergeBranch(repoName: string): void;
  openStash(repoName: string): void;
  openBranches(repoName: string): void;
  openDockerCompose(repoName: string): void;
  openRepoConfigManager(repoName: string): void;
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

/** One open dialog: component class + its inputs. */
export interface DialogEntry {
  /** Monotonic id — stable across stack mutations (used for `track`). */
  readonly id: number;
  readonly component: Type<unknown>;
  /** Extra inputs forwarded to the component (besides dialogId/cascadeLevel). */
  readonly inputs: Readonly<Record<string, unknown>>;
}

/** Push a dialog on top of the stack. */
export function pushEntry(
  stack: readonly DialogEntry[],
  entry: DialogEntry,
): readonly DialogEntry[] {
  return [...stack, entry];
}

/** Remove a dialog by id (no-op when absent). */
export function removeEntry(
  stack: readonly DialogEntry[],
  id: number,
): readonly DialogEntry[] {
  return stack.some((e) => e.id === id) ? stack.filter((e) => e.id !== id) : stack;
}

/** Cascade level (= stack index) of a dialog; -1 when not open. */
export function cascadeLevelOf(stack: readonly DialogEntry[], id: number): number {
  return stack.findIndex((e) => e.id === id);
}

/** The topmost dialog (`undefined` on an empty stack). */
export function topEntry(stack: readonly DialogEntry[]): DialogEntry | undefined {
  return stack[stack.length - 1];
}
