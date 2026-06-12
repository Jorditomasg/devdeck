import { describe, expect, it } from 'vitest';
import {
  dotStatusFor,
  headerButtonVisibility,
  isActiveStatus,
  visibilityForStatus,
} from './card-visibility';

describe('headerButtonVisibility (inventory-gui §6 matrix)', () => {
  it('installing + running → Stop/Restart visible, all disabled', () => {
    const v = headerButtonVisibility(true, true);
    expect(v.showStart).toBe(false);
    expect(v.showStop).toBe(true);
    expect(v.showRestart).toBe(true);
    expect(v.startEnabled).toBe(false);
    expect(v.stopEnabled).toBe(false);
    expect(v.restartEnabled).toBe(false);
    expect(v.installEnabled).toBe(false);
  });

  it('installing + stopped → Start visible, disabled', () => {
    const v = headerButtonVisibility(true, false);
    expect(v.showStart).toBe(true);
    expect(v.showStop).toBe(false);
    expect(v.showRestart).toBe(false);
    expect(v.startEnabled).toBe(false);
    expect(v.installEnabled).toBe(false);
  });

  it('running/starting → Stop/Restart visible and enabled', () => {
    const v = headerButtonVisibility(false, true);
    expect(v.showStart).toBe(false);
    expect(v.showStop).toBe(true);
    expect(v.showRestart).toBe(true);
    expect(v.stopEnabled).toBe(true);
    expect(v.restartEnabled).toBe(true);
    expect(v.installEnabled).toBe(false); // Install disabled while running (§6)
  });

  it('stopped/error → Start visible and enabled, Install re-enabled', () => {
    const v = headerButtonVisibility(false, false);
    expect(v.showStart).toBe(true);
    expect(v.showStop).toBe(false);
    expect(v.showRestart).toBe(false);
    expect(v.startEnabled).toBe(true);
    expect(v.installEnabled).toBe(true);
  });
});

describe('visibilityForStatus (6-state adapter)', () => {
  it('maps installing to the installing row (cannot overlap running in v2)', () => {
    expect(visibilityForStatus('installing')).toEqual(headerButtonVisibility(true, false));
  });

  it.each(['running', 'starting'] as const)(
    'maps %s to the active row',
    (status) => {
      expect(visibilityForStatus(status)).toEqual(headerButtonVisibility(false, true));
    },
  );

  it('maps stopping to the dedicated disabled row (double-stop guard)', () => {
    expect(visibilityForStatus('stopping')).toEqual({
      showStart: false,
      showStop: true,
      showRestart: true,
      startEnabled: false,
      stopEnabled: false,
      restartEnabled: false,
      installEnabled: false,
    });
  });

  it.each(['stopped', 'error'] as const)('maps %s to the idle row', (status) => {
    expect(visibilityForStatus(status)).toEqual(headerButtonVisibility(false, false));
  });
});

describe('status helpers', () => {
  it('isActiveStatus covers running/starting/stopping only', () => {
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('starting')).toBe(true);
    expect(isActiveStatus('stopping')).toBe(true);
    expect(isActiveStatus('stopped')).toBe(false);
    expect(isActiveStatus('error')).toBe(false);
    expect(isActiveStatus('installing')).toBe(false);
  });

  it('dotStatusFor renders stopping as the transitional starting color', () => {
    expect(dotStatusFor('stopping')).toBe('starting');
    expect(dotStatusFor('running')).toBe('running');
    expect(dotStatusFor('error')).toBe('error');
  });
});
