import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'

const env = loadEnv('development', process.cwd(), '')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
    plugins: [react(), tailwindcss()],
  },
})
