// Vitest runner for the frontend specs (`npm test`).
//
// All specs are deliberately TestBed-free (pure logic + manually constructed
// stores with fake bridges — see the header comment of any *.spec.ts), so the
// plain `node` environment suffices: no jsdom, no Angular build plugin.
// If a future spec needs the DOM, add `jsdom` to devDependencies and switch
// `environment` to 'jsdom'.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
