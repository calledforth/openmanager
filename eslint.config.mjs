import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

export default [
  js.configs.recommended,
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        window: 'readonly',
        document: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: [
      'apps/web/src/**/*.{test,spec}.{ts,tsx}',
      'apps/web/src/test-setup.ts',
      'apps/web/src/test-utils.tsx',
      'apps/web/src/routeTree.gen.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'The web shell must stay browser-safe so Electron can load the same bundle later.',
            },
            {
              name: 'electron-store',
              message: 'Desktop persistence stays outside the web bundle.',
            },
            {
              name: 'electron-updater',
              message: 'Desktop updates stay outside the web bundle.',
            },
            {
              name: 'fs',
              message: 'Node builtins cannot ship in the browser SPA.',
            },
            {
              name: 'path',
              message: 'Node builtins cannot ship in the browser SPA.',
            },
            {
              name: 'os',
              message: 'Node builtins cannot ship in the browser SPA.',
            },
            {
              name: 'child_process',
              message: 'Node builtins cannot ship in the browser SPA.',
            },
          ],
          patterns: [
            {
              group: ['electron/*', 'node:*'],
              message:
                'The web shell must stay browser-safe so Electron can load the same bundle later.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/postcss.config.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
      },
    },
  },
  {
    ignores: [
      'apps/**/out/',
      'apps/**/dist/',
      'apps/web/src/routeTree.gen.ts',
      '**/storybook-static/',
      'dist/',
      'node_modules/',
      'packages/convex/convex/_generated/',
    ],
  },
]
