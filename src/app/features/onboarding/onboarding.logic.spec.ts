import { describe, expect, it } from 'vitest';

import { TOUR_STEPS, availableSteps, shouldStartTour, type TourTrigger } from './onboarding.logic';

describe('availableSteps', () => {
  it('drops steps whose anchor is missing but keeps the anchorless last step', () => {
    const present = new Set(['repo-card', 'card-actions', 'card-header', 'profile']);
    const ids = availableSteps(TOUR_STEPS, (a) => present.has(a)).map((s) => s.id);
    expect(ids).toEqual(['repo_card', 'card_actions', 'card_header', 'card_expand', 'profile', 'tray']);
  });

  it('keeps only the tray step when nothing is rendered', () => {
    expect(availableSteps(TOUR_STEPS, () => false).map((s) => s.id)).toEqual(['tray']);
  });
});

describe('shouldStartTour', () => {
  const ready: TourTrigger = {
    configLoaded: true,
    seen: false,
    startupSettled: true,
    scanning: false,
    repoCount: 2,
    armed: true,
  };

  it('starts once everything is ready', () => {
    expect(shouldStartTour(ready)).toBe(true);
  });

  it.each<Partial<TourTrigger>>([
    { configLoaded: false },
    { seen: true },
    { startupSettled: false },
    { scanning: true },
    { repoCount: 0 },
    { armed: false },
  ])('waits while %o', (patch) => {
    expect(shouldStartTour({ ...ready, ...patch })).toBe(false);
  });
});
