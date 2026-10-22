import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const app = (name: string) => dirname(require.resolve(`${name}/package.json`))

// Pure logic and the shared providers, no React Native runtime: appearance
// resolution and token derivation, phone storage, the connection controller,
// route order, runtime fills, the Metro resolver, the home's source and the
// read-only thread. Screens are checked by typecheck and by the Expo bundle;
// see README.
export default defineConfig({
  resolve: {
    // The shared packages resolve their own React; the app's copy renders,
    // as Metro pins it on the phone.
    alias: [
      { find: /^react$/, replacement: app('react') },
      { find: /^react\/(.*)$/, replacement: `${app('react')}/$1` },
      { find: /^react-dom$/, replacement: app('react-dom') },
      { find: /^react-dom\/(.*)$/, replacement: `${app('react-dom')}/$1` },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
