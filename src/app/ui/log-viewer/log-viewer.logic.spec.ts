import { describe, expect, it } from 'vitest';
import {
  BOTTOM_STICK_THRESHOLD_PX,
  DEFAULT_MAX_LINES,
  capLines,
  isNearBottom,
} from './log-viewer.logic';

const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i}`);

describe('log-viewer constants (inventory-gui §8/§28 parity)', () => {
  it('keeps the v1 LOG_MAX_LINES default of 500', () => {
    expect(DEFAULT_MAX_LINES).toBe(500);
  });
});

describe('capLines (head-trim at the cap)', () => {
  it('passes short buffers through untouched (same reference)', () => {
    const input = lines(10);
    const result = capLines(input, 500);
    expect(result.lines).toBe(input);
    expect(result.dropped).toBe(0);
  });

  it('keeps only the newest N lines and reports the dropped count', () => {
    const result = capLines(lines(510), 500);
    expect(result.lines).toHaveLength(500);
    expect(result.dropped).toBe(10);
    expect(result.lines[0]).toBe('line 10'); // oldest 10 trimmed from the head
    expect(result.lines[499]).toBe('line 509'); // newest kept
  });

  it('keeps track keys stable across trims (absolute line numbers)', () => {
    // A line that SURVIVES the trim must map to the same key before and
    // after ("line 150" exists in both windows; "line 42" would be trimmed).
    const before = capLines(lines(200), 500);
    const after = capLines(lines(600), 500);
    const keyBefore = before.dropped + before.lines.indexOf('line 150');
    const keyAfter = after.dropped + after.lines.indexOf('line 150');
    expect(keyBefore).toBe(150);
    expect(keyAfter).toBe(150);
  });

  it('treats a non-positive cap as uncapped', () => {
    const input = lines(50);
    expect(capLines(input, 0).lines).toBe(input);
    expect(capLines(input, -1).dropped).toBe(0);
  });
});

describe('isNearBottom (autoscroll stickiness)', () => {
  it('is true exactly at the bottom', () => {
    expect(isNearBottom(500, 500, 1000)).toBe(true);
  });

  it('tolerates the threshold distance (subpixel/rounding)', () => {
    expect(isNearBottom(500 - BOTTOM_STICK_THRESHOLD_PX, 500, 1000)).toBe(true);
  });

  it('disengages once the user scrolls further up', () => {
    expect(isNearBottom(500 - BOTTOM_STICK_THRESHOLD_PX - 1, 500, 1000)).toBe(false);
    expect(isNearBottom(0, 500, 1000)).toBe(false);
  });

  it('is true for content shorter than the viewport', () => {
    expect(isNearBottom(0, 500, 300)).toBe(true);
  });
});
