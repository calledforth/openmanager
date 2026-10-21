import { defineConfig } from 'vitest/config'

// Pure logic only, no React Native runtime: appearance resolution and token
// derivation, and the connection controller, storage seam, route order,
// runtime fills and Metro resolver. Screens are checked by typecheck and by
// the Expo bundle; see README.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
