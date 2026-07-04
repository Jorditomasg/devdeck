import { describe, expect, it } from 'vitest';
import { clampMenuPosition, nextEnabledIndex } from './context-menu.logic';
import type { MenuEntry } from './context-menu.types';

const entry = (id: string, disabled = false): MenuEntry => ({ id, label: id, disabled });

describe('nextEnabledIndex', () => {
  const items = [entry('a'), entry('b', true), entry('c')];

  it('steps forward skipping disabled entries', () => {
    expect(nextEnabledIndex(items, 0, 1)).toBe(2);
  });

  it('wraps around backwards', () => {
    expect(nextEnabledIndex(items, 0, -1)).toBe(2);
  });

  it('enters the list at the first enabled item from -1', () => {
    expect(nextEnabledIndex(items, -1, 1)).toBe(0);
  });

  it('stays put when every entry is disabled', () => {
    const allOff = [entry('a', true), entry('b', true)];
    expect(nextEnabledIndex(allOff, -1, 1)).toBe(-1);
  });

  it('handles an empty list', () => {
    expect(nextEnabledIndex([], -1, 1)).toBe(-1);
  });
});

describe('clampMenuPosition', () => {
  it('keeps a fitting menu at the pointer', () => {
    expect(clampMenuPosition(100, 100, 200, 150, 800, 600, 4)).toEqual({ x: 100, y: 100 });
  });

  it('flips left when overflowing the right edge', () => {
    expect(clampMenuPosition(700, 100, 200, 150, 800, 600, 4)).toEqual({ x: 500, y: 100 });
  });

  it('flips up when overflowing the bottom edge', () => {
    expect(clampMenuPosition(100, 550, 200, 150, 800, 600, 4)).toEqual({ x: 100, y: 400 });
  });

  it('clamps to the margin when flipping would leave the viewport', () => {
    expect(clampMenuPosition(2, 2, 200, 150, 800, 600, 4)).toEqual({ x: 4, y: 4 });
  });
});
