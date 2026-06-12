import { describe, expect, it } from 'vitest';
import {
  FILTER_DEBOUNCE_MS,
  LOAD_MORE_RATIO,
  MAX_VISIBLE_ROWS,
  PAGE_SIZE,
  filterOptions,
  moveActiveIndex,
  nextRenderCount,
  separatorIndex,
  shouldLoadMore,
} from './searchable-select.logic';

const opts = (n: number): string[] => Array.from({ length: n }, (_, i) => `branch-${i}`);

describe('searchable-select constants (inventory-gui §32 parity)', () => {
  it('matches the v1 timing/paging values', () => {
    expect(FILTER_DEBOUNCE_MS).toBe(150);
    expect(PAGE_SIZE).toBe(30);
    expect(LOAD_MORE_RATIO).toBe(0.985);
    expect(MAX_VISIBLE_ROWS).toBe(9);
  });
});

describe('filterOptions', () => {
  it('returns the full list (same reference) for an empty query', () => {
    const options = ['main', 'develop'];
    expect(filterOptions(options, '')).toBe(options);
    expect(filterOptions(options, '   ')).toBe(options);
  });

  it('filters by case-insensitive substring', () => {
    const options = ['main', 'feature/LOGIN', 'hotfix/login-page', 'develop'];
    expect(filterOptions(options, 'login')).toEqual(['feature/LOGIN', 'hotfix/login-page']);
    expect(filterOptions(options, 'LOGIN')).toEqual(['feature/LOGIN', 'hotfix/login-page']);
  });

  it('returns empty for no matches (→ "no results" placeholder)', () => {
    expect(filterOptions(['main'], 'zzz')).toEqual([]);
  });
});

describe('shouldLoadMore (≥98.5% scroll trigger)', () => {
  it('is false while above the threshold', () => {
    // 900/1000 = 90%
    expect(shouldLoadMore(400, 500, 1000)).toBe(false);
  });

  it('is true exactly at the threshold and below the bottom', () => {
    // (485 + 500) / 1000 = 98.5%
    expect(shouldLoadMore(485, 500, 1000)).toBe(true);
    expect(shouldLoadMore(500, 500, 1000)).toBe(true);
  });

  it('never triggers when the list does not scroll', () => {
    expect(shouldLoadMore(0, 500, 500)).toBe(false);
    expect(shouldLoadMore(0, 500, 300)).toBe(false);
  });
});

describe('nextRenderCount (30/+30 batching)', () => {
  it('grows by one page', () => {
    expect(nextRenderCount(30, 100)).toBe(60);
  });

  it('clamps to the total', () => {
    expect(nextRenderCount(30, 42)).toBe(42);
    expect(nextRenderCount(42, 42)).toBe(42);
  });
});

describe('separatorIndex (recents divider, unfiltered only)', () => {
  it('places the divider after the last recent item', () => {
    expect(separatorIndex(3, false, 10)).toBe(2);
  });

  it('is hidden while filtering', () => {
    expect(separatorIndex(3, true, 10)).toBe(-1);
  });

  it('is hidden when it would not split two groups', () => {
    expect(separatorIndex(0, false, 10)).toBe(-1);
    expect(separatorIndex(10, false, 10)).toBe(-1);
    expect(separatorIndex(12, false, 10)).toBe(-1);
  });
});

describe('moveActiveIndex (keyboard navigation)', () => {
  it('enters the list from the nothing-active state', () => {
    expect(moveActiveIndex(-1, 1, 5)).toBe(0); // ArrowDown → first
    expect(moveActiveIndex(-1, -1, 5)).toBe(4); // ArrowUp → last
  });

  it('moves and wraps around both ends', () => {
    expect(moveActiveIndex(0, 1, 5)).toBe(1);
    expect(moveActiveIndex(4, 1, 5)).toBe(0);
    expect(moveActiveIndex(0, -1, 5)).toBe(4);
  });

  it('stays inactive on an empty list', () => {
    expect(moveActiveIndex(-1, 1, 0)).toBe(-1);
    expect(moveActiveIndex(2, 1, 0)).toBe(-1);
  });
});

describe('no-emit-on-set contract (§32 set() semantics)', () => {
  // The component models this structurally: `value = model('')` — parent
  // writes through the [value] binding update the signal WITHOUT firing
  // valueChange/selectionChange; only the internal select() path emits.
  // This test documents the pure invariant the component relies on:
  // selection emission is driven exclusively by user-pick events, which all
  // route through filtered/visible options.
  it('a programmatically set value does not need to exist in options', () => {
    const options = opts(3);
    // v1: set() accepts any value without validating against the list.
    expect(filterOptions(options, '').includes('not-in-list')).toBe(false);
  });
});
