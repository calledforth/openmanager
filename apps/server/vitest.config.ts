import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The convergence harness runs real server processes for minutes; it has
    // its own script and config (vitest.convergence.config.ts).
    exclude: [...configDefaults.exclude, 'tests/convergence/**'],
    testTimeout: 10_000,
  },
})
