/**
 * The ONLY place `@tauri-apps/api` is imported (architecture-v2.md §4,
 * Angular-side dependency rule). Everything else — typed command wrappers,
 * event wrappers, signal stores — talks to Tauri through this injectable, so
 * tests can substitute a structural fake (`tauri-bridge.fake.ts`) without
 * TestBed or module mocking.
 *
 * Deliberately has NO private members: TypeScript structural typing then
 * accepts any object exposing `invoke` + `listen` wherever `TauriBridge` is
 * expected, which is what makes the fake drop-in.
 */
import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type { UnlistenFn };

/** Argument bag of a command invocation (camelCase keys on the wire). */
export type InvokeArgs = Record<string, unknown>;

@Injectable({ providedIn: 'root' })
export class TauriBridge {
  /**
   * Invoke a Rust command. Rejects with an `AppError`-shaped object on
   * command failure (ipc-contract.md §1.3).
   */
  invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    return invoke<T>(command, args);
  }

  /**
   * Subscribe to a Rust-emitted event. The handler receives the payload
   * directly (the Tauri envelope is unwrapped here). Resolves to the
   * unlisten function.
   */
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    return listen<T>(event, (e) => handler(e.payload));
  }
}
