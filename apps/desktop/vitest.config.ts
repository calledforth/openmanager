import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      '../../packages/agent-runtime/src/**/*.{test,spec}.{ts,tsx}',
      '../../packages/shared/src/**/*.{test,spec}.{ts,tsx}',
      '../../packages/convex/convex/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/out/**',
      '**/.git/**',
      '**/.tmp/**',
      '**/tmp/**',
      '**/opencode.ref/**',
    ],
  },
  resolve: {
    alias: {
      '@openmanager/shared': resolve(__dirname, '../../packages/shared/src'),
      '@openmanager/convex': resolve(__dirname, '../../packages/convex/convex'),
    },
  },
})
