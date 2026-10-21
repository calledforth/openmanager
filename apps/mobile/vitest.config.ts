import { defineConfig } from 'vitest/config'

// The controller, storage seam, route order, runtime fills and Metro resolver
// are plain TypeScript (or CommonJS) with no React Native import, so they run
// under Node. Anything that needs React Native stays out of `tests/`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
