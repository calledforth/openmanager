import { defineConfig, mergeConfig } from 'vitest/config'

import unit from '../vitest.config'

// The live checks drive the phone's connection controller (and, for the
// sessions check, the shared providers on its client) against a real
// environment server. They never run with the unit tests: start a server,
// set the LIVE_* variables, then `pnpm --filter @openmanager/mobile test:live`.
// The unit config's React resolution carries over.
export default mergeConfig(
  { resolve: unit.resolve },
  defineConfig({
    test: {
      environment: 'node',
      include: ['live/**/*.live.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
)
