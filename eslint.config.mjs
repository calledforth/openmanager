import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import { builtinModules } from 'node:module'

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
    files: ['packages/app-core/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.filter((name) => !name.startsWith('_')),
          patterns: [
            {
              group: [
                'node:*',
                'electron',
                'electron/*',
                'electron-*',
                'convex',
                'convex/*',
                '@openmanager/convex',
                '@openmanager/convex/*',
                '@openmanager/desktop',
                '@openmanager/desktop/*',
                '@agentpack/runtime',
                '@agentpack/runtime/*',
                '@renderer/*',
                '**/apps/**',
                '../../../*',
              ],
              message:
                'app-core must remain browser-safe. Supply data/actions from the host through props or context.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Identifier[name='electronAPI']",
          message: 'Electron capabilities belong in the desktop host.',
        },
        {
          selector: "MemberExpression[computed=true][property.value='electronAPI']",
          message: 'Electron capabilities belong in the desktop host.',
        },
        {
          selector: 'ImportExpression:not([source.value=/^@shikijs/]):not([source.value=/^shiki/])',
          message: 'Use static imports in app-core, except for the curated Shiki loader.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: 'Use browser-safe static imports in app-core.',
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
      'packages/**/dist/',
      'apps/web/src/routeTree.gen.ts',
      '**/storybook-static/',
      'dist/',
      'node_modules/',
      'packages/convex/convex/_generated/',
    ],
  },
]
