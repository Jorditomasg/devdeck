import { describe, expect, it } from 'vitest';
import type { GlobalLogLine } from '../../../core/state/services.store';
import { formatGlobalLine, linesAfterMarker } from './global-log.logic';

function entry(name: string, line: string): GlobalLogLine {
  return { name, stream: 'service', line };
}

describe('linesAfterMarker (view-side global log clear, §5)', () => {
  const a = entry('api', 'one');
  const b = entry('api', 'two');
  const c = entry('web', 'three');

  it('returns everything with a null marker', () => {
    expect(linesAfterMarker([a, b, c], null)).toEqual([a, b, c]);
  });

  it('returns only entries after the marker', () => {
    expect(linesAfterMarker([a, b, c], b)).toEqual([c]);
  });

  it('returns empty when the marker is the newest entry', () => {
    expect(linesAfterMarker([a, b, c], c)).toEqual([]);
  });

  it('matches by reference, using the LAST occurrence', () => {
    expect(linesAfterMarker([a, b, a, c], a)).toEqual([c]);
  });

  it('returns everything when the marker was trimmed out of the buffer', () => {
    expect(linesAfterMarker([b, c], a)).toEqual([b, c]);
  });

  it('handles an empty buffer', () => {
    expect(linesAfterMarker([], a)).toEqual([]);
    expect(linesAfterMarker([], null)).toEqual([]);
  });
});

describe('formatGlobalLine', () => {
  it('prefixes the originating service id', () => {
    expect(formatGlobalLine(entry('backend', 'Started in 3.2s'))).toBe(
      '[backend] Started in 3.2s',
    );
  });
});
