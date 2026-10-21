import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import { builtinModules } from 'node:module'
import {
  LOGIC_DOM_GLOBALS as domGlobals,
  LOGIC_FORBIDDEN_PACKAGES,
  logicGraphFiles,
} from './packages/app-core/scripts/logic-graph.mjs'

const browserSafeMessage =
  'app-core must remain browser-safe. Supply data/actions from the host through props or context.'
const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_'))
const browserSafePattern = {
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
  message: browserSafeMessage,
}
const electronSyntax = [
  {
    selector: "Identifier[name='electronAPI']",
    message: 'Electron capabilities belong in the desktop host.',
  },
  {
    selector: "MemberExpression[computed=true][property.value='electronAPI']",
    message: 'Electron capabilities belong in the desktop host.',
  },
]
const requireSyntax = {
  selector: "CallExpression[callee.name='require']",
  message: 'Use browser-safe static imports in app-core.',
}

// `@openmanager/app-core/logic` is what React Native loads: every file its
// entry reaches (walked afresh on each lint run, type-only imports included)
// must stay free of the web UI's stack and of browser globals.
const logicFiles = logicGraphFiles(import.meta.dirname)
const logicMessage =
  "Reachable from app-core's DOM-free entry (src/logic.ts), which React Native loads. Take browser APIs from the host (DeviceHost, props or context), or import this from a module the entry does not reach."
const domGlobalPattern = `/^(${domGlobals.join('|')})$/`
const globalThisSyntax = [
  `MemberExpression[object.name='globalThis'][property.name=${domGlobalPattern}]`,
  `MemberExpression[object.name='globalThis'][property.value=${domGlobalPattern}]`,
  `MemberExpression[object.expression.name='globalThis'][property.name=${domGlobalPattern}]`,
  `MemberExpression[object.expression.name='globalThis'][property.value=${domGlobalPattern}]`,
].map((selector) => ({ selector, message: logicMessage }))
// `globalThis` only as `globalThis.name` or `globalThis['name']`, where the
// selectors above can read the name: not destructured, aliased, passed on or
// indexed by an expression.
const globalThisEscapes = [
  {
    selector:
      "Identifier[name='globalThis']:not(MemberExpression > Identifier.object, MemberExpression > TSAsExpression.object > Identifier.expression, MemberExpression > TSNonNullExpression.object > Identifier.expression)",
    message: `${logicMessage} Read \`globalThis\` only as \`globalThis.name\`, so the lint can see which global.`,
  },
  {
    selector:
      "MemberExpression[computed=true]:matches([object.name='globalThis'], [object.expression.name='globalThis']):not([property.type='Literal'])",
    message: `${logicMessage} Read \`globalThis\` only as \`globalThis.name\`, so the lint can see which global.`,
  },
]
const logicSyntax = [
  ...electronSyntax,
  requireSyntax,
  {
    selector: 'ImportExpression',
    message: `${logicMessage} Static imports only, so the entry's graph can be walked.`,
  },
]
// Packages the logic graph may import. Anything else (a new UI library, a
// DOM helper) has to be added here on purpose.
const logicPackageAllowlist = [
  'react$',
  'react/jsx-runtime$',
  '@agentpack/contract(/|$)',
  '@agentpack/view(/|$)',
  '@openmanager/protocol(/|$)',
  '@openmanager/shared(/|$)',
  '@openmanager/environment-client(/|$)',
  // Type-only today (`VirtualItem`); the virtualizer itself stays in the UI.
  '@tanstack/react-virtual$',
]

// The connection stack runs in the browser and in React Native, which has
// none of these. Whatever it needs from the host comes in as a parameter.
const HOST_GLOBALS = ['window', 'document', 'localStorage', 'navigator', 'indexedDB', 'location']
const HOST_GLOBAL_MESSAGE =
  'packages/environment-client/src/connection must stay host-neutral (the phone imports it). Take the browser value as a parameter that apps/web supplies.'

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
    files: ['packages/app-core/src/**/*.{ts,tsx}', 'packages/environment-client/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: nodeBuiltins, patterns: [browserSafePattern] }],
      'no-restricted-syntax': [
        'error',
        ...electronSyntax,
        {
          selector: 'ImportExpression:not([source.value=/^@shikijs/]):not([source.value=/^shiki/])',
          message: 'Use static imports in app-core, except for the curated Shiki loader.',
        },
        requireSyntax,
      ],
    },
  },
  {
    // A later block replaces a rule's options rather than adding to them, so
    // these restate app-core's browser-safe restrictions and add the entry's.
    files: logicFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...nodeBuiltins,
            ...LOGIC_FORBIDDEN_PACKAGES.map((name) => ({ name, message: logicMessage })),
          ],
          patterns: [
            browserSafePattern,
            {
              group: [
                '**/*.css',
                ...LOGIC_FORBIDDEN_PACKAGES.map((name) => `${name}/*`),
                '@shikijs/*',
                '@radix-ui/*',
                '@base-ui/*',
                '@phosphor-icons/*',
              ],
              message: logicMessage,
            },
            {
              regex: `^(?!\\.|${logicPackageAllowlist.join('|')})`,
              message: `${logicMessage} A new package joins the allowlist in eslint.config.mjs on purpose.`,
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...domGlobals.map((name) => ({ name, message: logicMessage })),
      ],
      'no-restricted-syntax': ['error', ...logicSyntax, ...globalThisSyntax, ...globalThisEscapes],
    },
  },
  {
    // The browser's side of `DeviceHost`: the one module in the graph that may
    // name a browser global, each use feature-detected (see the file).
    files: ['packages/app-core/src/lib/browser-device.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': ['error', ...logicSyntax],
    },
  },
  {
    files: ['packages/environment-client/src/connection/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...HOST_GLOBALS.map((name) => ({ name, message: HOST_GLOBAL_MESSAGE })),
      ],
      'no-restricted-properties': [
        'error',
        ...HOST_GLOBALS.flatMap((property) =>
          ['globalThis', 'self'].map((object) => ({
            object,
            property,
            message: HOST_GLOBAL_MESSAGE,
          })),
        ),
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
      // Vendored Fluid Functionalism components: re-pull, don't hand-edit.
      'packages/app-core/src/components/fluid/',
    ],
  },
]
