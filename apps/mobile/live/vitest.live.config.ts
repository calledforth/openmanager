import { defineConfig } from 'vitest/config'

// The live check drives the phone's connection controller against a real
// environment server. It never runs with the unit tests: start a server, set
// the LIVE_* variables, then `pnpm --filter @openmanager/mobile test:live`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['live/**/*.live.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
