import { describe, expect, it } from 'vitest';

import { coercePalette, coercePattern } from './theme.service';

describe('theme coercion', () => {
  it('keeps known palettes', () => {
    expect(coercePalette('slate')).toBe('slate');
    expect(coercePalette('light')).toBe('light');
  });

  it('falls back to the default palette for unknown/absent values', () => {
    expect(coercePalette('neon')).toBe('slate');
    expect(coercePalette(null)).toBe('slate');
    expect(coercePalette('')).toBe('slate');
  });

  it('keeps known patterns', () => {
    expect(coercePattern('none')).toBe('none');
    expect(coercePattern('dots')).toBe('dots');
    expect(coercePattern('cubes')).toBe('cubes');
    expect(coercePattern('moroccan')).toBe('moroccan');
  });

  it('falls back to the default pattern for unknown/absent/removed values', () => {
    expect(coercePattern('zigzag')).toBe('none');
    expect(coercePattern('triangular')).toBe('none'); // removed pattern
    expect(coercePattern(null)).toBe('none');
  });
});
