import { defineConfig } from 'vitest/config'

// Pure logic only (appearance resolution, token derivation, phone storage): no React
// Native runtime here. Screens are checked by typecheck and by the Expo
// bundle; see README.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
