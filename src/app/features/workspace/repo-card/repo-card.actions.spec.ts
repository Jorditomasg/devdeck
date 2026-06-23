import { describe, expect, it } from 'vitest';

import { CMD } from '../../../core/ipc/commands';
import { REPO_CARD_ACTIONS, resolveActions } from './repo-card.actions';

describe('repo-card action registry', () => {
  it('maps the seed action to the run_flyway_seeds command', () => {
    const seed = REPO_CARD_ACTIONS['seed'];
    expect(seed).toBeDefined();
    expect(seed.command).toBe(CMD.runFlywaySeeds);
    expect(seed.command).toBe('run_flyway_seeds');
    expect(seed.icon).toBe('sprout');
    expect(seed.labelKey).toBe('repo.action.seed');
  });

  it('resolves declared keys to their metadata (e.g. uiConfig.actions: ["seed"])', () => {
    const resolved = resolveActions(['seed']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].key).toBe('seed');
    expect(resolved[0].command).toBe('run_flyway_seeds');
  });

  it('skips unknown keys and tolerates an absent list', () => {
    expect(resolveActions(['seed', 'nope'])).toHaveLength(1);
    expect(resolveActions(['nope'])).toEqual([]);
    expect(resolveActions(undefined)).toEqual([]);
    expect(resolveActions([])).toEqual([]);
  });
});
