import { describe, expect, it } from 'vitest';

import { coercePalette, coercePattern } from './theme.service';

describe('theme coercion', () => {
  it('keeps known palettes', () => {
    expect(coercePalette('slate')).toBe('slate');
    expect(coercePalette('light')).toBe('light');
  });

  it('falls back to the default palette for unknown/absent values', () => {
    expect(coercePalette('neon')).toBe('indigo');
    expect(coercePalette(null)).toBe('indigo');
    expect(coercePalette('')).toBe('indigo');
  });

  it('keeps known patterns', () => {
    expect(coercePattern('none')).toBe('none');
    expect(coercePattern('dots')).toBe('dots');
    expect(coercePattern('cubes')).toBe('cubes');
    expect(coercePattern('moroccan')).toBe('moroccan');
  });

  it('falls back to the default pattern for unknown/absent/removed values', () => {
    expect(coercePattern('zigzag')).toBe('cubes');
    expect(coercePattern('triangular')).toBe('cubes'); // removed pattern
    expect(coercePattern(null)).toBe('cubes');
  });
});
