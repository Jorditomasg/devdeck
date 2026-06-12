/**
 * Sequential-with-cap batch runner for the GlobalPanel bulk operations
 * (inventory-gui.md §3): pull-all (cap 1 = strictly sequential), apply-branch
 * (cap 3 — §28 `GIT_BADGE_SEMAPHORE_COUNT`), install-all (cap 3 — §28
 * per-card action pool). Pure async helper, unit-tested in `batch.spec.ts`.
 */

/** Settled outcome of one batch item (errors are folded, never thrown). */
export interface BatchResult<R> {
  readonly ok: boolean;
  readonly value?: R;
  readonly error?: unknown;
}

/**
 * Run `task` over `items` with at most `cap` tasks in flight. Results are
 * returned in input order; a rejected task never aborts the batch (v1
 * collected per-repo failures and reported them at the end, §3).
 */
export async function runBatch<T, R>(
  items: readonly T[],
  cap: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<BatchResult<R>[]> {
  const results = new Array<BatchResult<R>>(items.length);
  if (items.length === 0) {
    return results;
  }
  let cursor = 0;
  const workers = Math.max(1, Math.min(Math.floor(cap), items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      const item = items[index] as T;
      try {
        results[index] = { ok: true, value: await task(item, index) };
      } catch (error: unknown) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
