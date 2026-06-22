/** TestBed-free specs (vitest-style). */
import { describe, expect, it } from 'vitest';

import { clampPage, pageCount, pageSlice } from './pagination.logic';

describe('pageCount', () => {
  it('rounds up partial pages', () => {
    expect(pageCount(25, 12)).toBe(3);
    expect(pageCount(24, 12)).toBe(2);
  });

  it('never returns less than 1, even for an empty list', () => {
    expect(pageCount(0, 12)).toBe(1);
  });

  it('guards against a non-positive size', () => {
    expect(pageCount(10, 0)).toBe(1);
  });
});

describe('clampPage', () => {
  it('keeps an in-range page untouched', () => {
    expect(clampPage(2, 25, 12)).toBe(2);
  });

  it('clamps past-the-end pages to the last page', () => {
    expect(clampPage(99, 25, 12)).toBe(3);
  });

  it('floors fractional and sub-1 pages to 1', () => {
    expect(clampPage(0, 25, 12)).toBe(1);
    expect(clampPage(-5, 25, 12)).toBe(1);
    expect(clampPage(Number.NaN, 25, 12)).toBe(1);
  });
});

describe('pageSlice', () => {
  const items = Array.from({ length: 25 }, (_, i) => i);

  it('returns the requested page window', () => {
    expect(pageSlice(items, 1, 12)).toEqual(items.slice(0, 12));
    expect(pageSlice(items, 2, 12)).toEqual(items.slice(12, 24));
  });

  it('returns the (short) last page for a clamped over-range request', () => {
    expect(pageSlice(items, 3, 12)).toEqual(items.slice(24, 25));
    expect(pageSlice(items, 99, 12)).toEqual(items.slice(24, 25));
  });

  it('returns the whole list for a non-positive size', () => {
    expect(pageSlice(items, 1, 0)).toEqual(items);
  });
});
