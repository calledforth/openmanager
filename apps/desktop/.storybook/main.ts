import { resolve } from 'path'
import { fileURLToPath } from 'url'
import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'

const here = fileURLToPath(new URL('.', import.meta.url))

const config: StorybookConfig = {
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  stories: ['../src/renderer/src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-links', '@storybook/addon-docs', '@storybook/addon-a11y'],
  docs: {
    autodocs: 'tag',
  },
  async viteFinal(config) {
    const alias = {
      '@renderer': resolve(here, '../src/renderer/src'),
      '@openmanager/shared': resolve(here, '../../../packages/shared/src'),
      '@openmanager/convex': resolve(here, '../../../packages/convex/convex'),
    }
    return {
      ...config,
      plugins: [...(config.plugins ?? []), tailwindcss()],
      resolve: {
        ...(config.resolve ?? {}),
        alias: {
          ...(config.resolve && !Array.isArray(config.resolve.alias) ? config.resolve.alias : {}),
          ...alias,
        },
      },
    }
  },
}

export default config
