import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import reactScan from '@react-scan/vite-plugin-react-scan'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'

const env = loadEnv('development', process.cwd(), '')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })],
    define: {
      __CONVEX_URL__: JSON.stringify(env.CONVEX_URL || ''),
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@convex': resolve('convex'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    envPrefix: ['VITE_', 'CONVEX_'],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@convex': resolve('convex'),
      },
    },
    plugins: [
      react(),
      reactScan(),
      tailwindcss(),
    ],
  },
})
