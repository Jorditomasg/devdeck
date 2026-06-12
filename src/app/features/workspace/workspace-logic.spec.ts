import { describe, expect, it } from 'vitest';
import {
  composeDisplayName,
  profileDisplayName,
  profileDropdownOptions,
  showGroupSelector,
} from './workspace-logic';

describe('showGroupSelector (topbar swap rule, inventory-gui §2)', () => {
  it('hides the selector for a single group with a single path', () => {
    expect(showGroupSelector(1, 1)).toBe(false);
  });

  it('shows the selector when there is more than one group', () => {
    expect(showGroupSelector(2, 1)).toBe(true);
  });

  it('shows the selector when the active group has more than one path', () => {
    expect(showGroupSelector(1, 2)).toBe(true);
  });

  it('hides the selector when no groups are loaded yet', () => {
    expect(showGroupSelector(0, 0)).toBe(false);
  });
});

describe('profileDisplayName (§26 dirty styling)', () => {
  it('falls back to the no-profile sentinel', () => {
    expect(profileDisplayName(null, false, '— No profile —')).toBe('— No profile —');
  });

  it('shows the plain name while clean', () => {
    expect(profileDisplayName('dev', false, 'x')).toBe('dev');
  });

  it('appends the " *" dirty suffix', () => {
    expect(profileDisplayName('dev', true, 'x')).toBe('dev *');
  });
});

describe('profileDropdownOptions (§26 dropdown values)', () => {
  it('shows only the sentinel when no profiles exist', () => {
    expect(profileDropdownOptions([], null, '—')).toEqual(['—']);
  });

  it('prepends the sentinel while no profile is active', () => {
    expect(profileDropdownOptions(['a', 'b'], null, '—')).toEqual(['—', 'a', 'b']);
  });

  it('hides the sentinel while a profile is active', () => {
    expect(profileDropdownOptions(['a', 'b'], 'a', '—')).toEqual(['a', 'b']);
  });
});

describe('composeDisplayName (§7 docker row naming)', () => {
  it('maps docker-compose.yml to docker-compose', () => {
    expect(composeDisplayName('/repo/docker-compose.yml')).toBe('docker-compose');
  });

  it('maps docker-compose.<x>.yml to <x>', () => {
    expect(composeDisplayName('C:\\repo\\docker-compose.kafka.yml')).toBe('kafka');
  });

  it('falls back to the basename without extension', () => {
    expect(composeDisplayName('/repo/stack.yaml')).toBe('stack');
  });
});
