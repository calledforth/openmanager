import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import reactScan from '@react-scan/vite-plugin-react-scan'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(appRoot, '../..')
const sharedRoot = resolve(workspaceRoot, 'packages/shared/src')
const convexRoot = resolve(workspaceRoot, 'packages/convex/convex')
const env = loadEnv('development', workspaceRoot, '')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })],
    build: {
      outDir: resolve(appRoot, 'out/main'),
    },
    define: {
      __CONVEX_URL__: JSON.stringify(env.CONVEX_URL || ''),
    },
    resolve: {
      alias: {
        '@openmanager/shared': sharedRoot,
        '@openmanager/convex': convexRoot,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(appRoot, 'out/preload'),
    },
  },
  renderer: {
    envDir: workspaceRoot,
    envPrefix: ['VITE_', 'CONVEX_'],
    build: {
      outDir: resolve(appRoot, 'out/renderer'),
    },
    resolve: {
      alias: {
        '@renderer': resolve(appRoot, 'src/renderer/src'),
        '@openmanager/shared': sharedRoot,
        '@openmanager/convex': convexRoot,
      },
    },
    plugins: [
      react(),
      reactScan(),
      tailwindcss(),
    ],
  },
})
