import { describe, expect, it } from 'vitest';
import { runBatch } from './batch';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('runBatch (inventory-gui §3 / §28 batch sequencing)', () => {
  it('returns results in input order', async () => {
    const results = await runBatch([3, 1, 2], 2, async (n) => n * 10);
    expect(results.map((r) => r.value)).toEqual([30, 10, 20]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('cap 1 runs strictly sequentially (v1 pull-all, §3)', async () => {
    const order: string[] = [];
    await runBatch(['a', 'b', 'c'], 1, async (item) => {
      order.push(`start:${item}`);
      await Promise.resolve();
      order.push(`end:${item}`);
    });
    expect(order).toEqual([
      'start:a',
      'end:a',
      'start:b',
      'end:b',
      'start:c',
      'end:c',
    ]);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
    const run = runBatch([0, 1, 2, 3, 4], 3, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gates[i]!.promise;
      inFlight--;
    });
    // Release one at a time so stragglers get scheduled.
    for (const gate of gates) {
      await Promise.resolve();
      gate.resolve();
      await Promise.resolve();
    }
    await run;
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // cap > 1 actually parallelizes
  });

  it('folds rejections instead of aborting the batch (v1 §3 missing-branch report)', async () => {
    const results = await runBatch([1, 2, 3], 2, async (n) => {
      if (n === 2) {
        throw new Error('boom');
      }
      return n;
    });
    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[1]!.ok).toBe(false);
    expect((results[1]!.error as Error).message).toBe('boom');
    expect(results[2]).toEqual({ ok: true, value: 3 });
  });

  it('handles an empty item list', async () => {
    expect(await runBatch([], 3, async () => 1)).toEqual([]);
  });
});
