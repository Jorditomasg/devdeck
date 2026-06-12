/** TestBed-free specs (vitest-style; runner wiring is a later task). */
import { describe, expect, it } from 'vitest';

import type { WorkspaceGroup } from '../../../core/ipc/tauri.types';
import {
  addGroupPath,
  effectiveActiveName,
  emptyPathGroupNames,
  removeGroupPath,
  renameGroup,
  uniqueGroupName,
} from './workspace-groups.logic';

const groups: readonly WorkspaceGroup[] = [
  { name: 'Default', paths: ['/ws/main'] },
  { name: 'Client A', paths: ['/ws/a', '/ws/a2'] },
  { name: 'Empty', paths: [] },
];

describe('uniqueGroupName', () => {
  it('keeps the base name when free', () => {
    expect(uniqueGroupName(groups, 'New Group')).toBe('New Group');
  });

  it('suffixes " 1", " 2", … on collision (v1 §24)', () => {
    const taken = [
      { name: 'New Group', paths: [] },
      { name: 'New Group 1', paths: [] },
    ];
    expect(uniqueGroupName(taken, 'New Group')).toBe('New Group 2');
  });
});

describe('renameGroup', () => {
  it('renames in place', () => {
    const result = renameGroup(groups, 1, 'Client B');
    expect(result?.[1]).toEqual({ name: 'Client B', paths: ['/ws/a', '/ws/a2'] });
    expect(result?.[0]).toBe(groups[0]); // untouched entries preserved
  });

  it('returns null on empty name', () => {
    expect(renameGroup(groups, 0, '   ')).toBeNull();
  });

  it('returns null on collision with another group', () => {
    expect(renameGroup(groups, 1, 'Default')).toBeNull();
  });

  it('is a no-op when the name is unchanged', () => {
    expect(renameGroup(groups, 0, 'Default')).toBe(groups);
  });

  it('returns null for an out-of-range index', () => {
    expect(renameGroup(groups, 9, 'X')).toBeNull();
  });
});

describe('addGroupPath / removeGroupPath', () => {
  it('appends a new path', () => {
    const result = addGroupPath(groups, 0, '/ws/extra');
    expect(result[0]?.paths).toEqual(['/ws/main', '/ws/extra']);
  });

  it('dedups per group (v1 §24)', () => {
    expect(addGroupPath(groups, 1, '/ws/a')).toBe(groups);
  });

  it('removes an existing path', () => {
    const result = removeGroupPath(groups, 1, '/ws/a');
    expect(result[1]?.paths).toEqual(['/ws/a2']);
  });

  it('remove is a no-op when the path is absent', () => {
    expect(removeGroupPath(groups, 0, '/nope')).toBe(groups);
  });
});

describe('emptyPathGroupNames', () => {
  it('lists only zero-path groups', () => {
    expect(emptyPathGroupNames(groups)).toEqual(['Empty']);
  });

  it('is empty when every group has paths', () => {
    expect(emptyPathGroupNames(groups.slice(0, 2))).toEqual([]);
  });
});

describe('effectiveActiveName', () => {
  it('keeps a still-existing active name', () => {
    expect(effectiveActiveName(groups, 'Client A')).toBe('Client A');
  });

  it('falls back to the first group when the active vanished (§24)', () => {
    expect(effectiveActiveName(groups, 'Deleted')).toBe('Default');
  });

  it('returns empty for an empty list', () => {
    expect(effectiveActiveName([], 'X')).toBe('');
  });
});
