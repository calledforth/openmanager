import { defineConfig } from 'vitest/config'

/**
 * The convergence harness (docs/sync-foundations.md §8): real server child
 * processes, a link proxy and real clients. One scenario at a time, because
 * each owns a server process and real timers decide its outcome.
 *
 * `--mode nightly` adds the long scenarios and the larger seed set.
 */
export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['tests/convergence/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    env: mode === 'nightly' ? { CONVERGENCE_NIGHTLY: '1' } : {},
  },
}))
