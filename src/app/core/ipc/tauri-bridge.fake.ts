/**
 * Test double for `TauriBridge` — structurally compatible, no Angular/Tauri
 * imports beyond types. Used by the .spec files of the signal stores to
 * (a) stub command results and (b) drive event-based store transitions.
 *
 * NOT shipped: only .spec.ts files may import this module.
 */
import type { InvokeArgs, TauriBridge, UnlistenFn } from './tauri-bridge';

interface RecordedInvoke {
  readonly command: string;
  readonly args?: InvokeArgs;
}

type Responder = (args?: InvokeArgs) => unknown;

export class FakeTauriBridge implements TauriBridge {
  /** Every `invoke` call, in order. */
  readonly invokes: RecordedInvoke[] = [];

  private readonly responders = new Map<string, Responder>();
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

  /** Stub the result of a command (static value or per-call function). */
  whenInvoked(command: string, result: unknown | Responder): this {
    this.responders.set(
      command,
      typeof result === 'function' ? (result as Responder) : () => result,
    );
    return this;
  }

  /** Commands invoked with the given name (for assertions). */
  invokesOf(command: string): RecordedInvoke[] {
    return this.invokes.filter((i) => i.command === command);
  }

  /** Emit a fake Rust event to every registered listener. */
  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  /** Number of active listeners for an event (unlisten-awareness). */
  listenerCount(event: string): number {
    return (this.handlers.get(event) ?? []).length;
  }

  // -- TauriBridge surface --------------------------------------------------

  invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    this.invokes.push({ command, args });
    const responder = this.responders.get(command);
    if (!responder) {
      return Promise.resolve(undefined as T);
    }
    try {
      return Promise.resolve(responder(args) as T);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    const list = this.handlers.get(event) ?? [];
    const wrapped = handler as (payload: unknown) => void;
    list.push(wrapped);
    this.handlers.set(event, list);
    return Promise.resolve(() => {
      const current = this.handlers.get(event) ?? [];
      const idx = current.indexOf(wrapped);
      if (idx >= 0) {
        current.splice(idx, 1);
      }
    });
  }
}
