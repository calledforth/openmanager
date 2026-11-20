import { defineConfig } from 'vitest/config'

// The package's own config, so vitest never walks up to the repo root's
// vite.config.ts (the web app's, with plugins a runtime-only install lacks).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
