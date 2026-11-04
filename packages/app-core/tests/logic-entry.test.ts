// @vitest-environment node
//
// `@openmanager/app-core/logic` is what React Native (Metro) loads. It must
// load with no DOM: no browser global touched while it imports, and nothing in
// its graph that is CSS or the web UI's stack. ESLint holds each file of the
// graph to the same (`eslint.config.mjs`); this proves the entry as a whole.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOGIC_DOM_GLOBALS,
  LOGIC_ENTRY,
  LOGIC_FORBIDDEN_PACKAGES,
  walkLogicGraph,
} from '../scripts/logic-graph.mjs'

const packageDir = dirname(dirname(LOGIC_ENTRY))
// The first import transforms the whole graph; on a cold cache that is slow.
const IMPORT_TIMEOUT_MS = 60_000
const restore: Array<() => void> = []

afterEach(() => {
  while (restore.length > 0) restore.pop()?.()
})

/**
 * Third-party reads that are feature detection, not a dependency on the DOM:
 * each is guarded and works on with the global absent (the trap reads as
 * `undefined`, and the import must still succeed). Anything else that touches
 * a browser global while the entry loads fails the test, ours or a library's.
 */
const TOLERATED_TOUCHES: ReadonlyArray<{ global: string; from: RegExp; why: string }> = [
  {
    global: 'navigator',
    from: /[\\/]zod@[^\\/]+[\\/]node_modules[\\/]zod[\\/]v4[\\/]core[\\/]util\.js:/,
    why: "zod's `allowsEval` probe: `typeof navigator !== 'undefined'` to spot Cloudflare Workers",
  },
]

/** Replaces each browser global with a getter that records who touched it. */
function trapBrowserGlobals(): string[] {
  const touched: string[] = []
  const record = (name: string, how: string) => {
    // [0] is "Error", [1] `record`, [2] the trap; [3] the code that touched it.
    const frames = (new Error().stack ?? '').split('\n')
    const from = frames[3] ?? ''
    const tolerated = TOLERATED_TOUCHES.some(
      (entry) => entry.global === name && entry.from.test(from),
    )
    if (!tolerated) touched.push(`${how} ${name}\n${frames.slice(3, 13).join('\n')}`)
  }
  for (const name of LOGIC_DOM_GLOBALS) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    if (previous && !previous.configurable) {
      throw new Error(`cannot trap globalThis.${name}: it is not configurable`)
    }
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        record(name, 'read')
        return undefined
      },
      set() {
        record(name, 'assigned')
      },
    })
    restore.push(() => {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else delete (globalThis as Record<string, unknown>)[name]
    })
  }
  return touched
}

describe('@openmanager/app-core/logic', () => {
  it('is the package export that names src/logic.ts', () => {
    const require = createRequire(import.meta.url)
    expect(require.resolve('@openmanager/app-core/logic')).toBe(LOGIC_ENTRY)
    const exports = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).exports
    expect(exports['./logic']).toBe('./src/logic.ts')
  })

  it(
    'loads under Node without touching a browser global',
    async () => {
      const touched = trapBrowserGlobals()
      const logic = await import('@openmanager/app-core/logic')
      expect(touched).toEqual([])

      // A sample from each part, so a broken re-export is caught too.
      expect(typeof logic.EnvironmentApplicationProviders).toBe('function')
      expect(typeof logic.EnvironmentClientProvider).toBe('function')
      expect(typeof logic.useActiveThreadState).toBe('function')
      expect(typeof logic.createLocalComposerDraftStore).toBe('function')
      expect(typeof logic.StreamingMessagesStore).toBe('function')
      expect(typeof logic.formatRelativeTime).toBe('function')
      expect(typeof logic.useDeviceStorage).toBe('function')
      expect(Array.isArray(logic.THEME_FAMILIES)).toBe(true)
    },
    IMPORT_TIMEOUT_MS,
  )

  it(
    'runs its storage on what the host hands it, not on the browser',
    async () => {
      const touched = trapBrowserGlobals()
      const { createLocalComposerDraftStore, readFavoriteModels, writeFavoriteModels } =
        await import('@openmanager/app-core/logic')
      const memory = new Map<string, string>()
      const storage = {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => void memory.set(key, value),
        removeItem: (key: string) => void memory.delete(key),
      }
      writeFavoriteModels(['claude:opus'], undefined, storage)
      expect(readFavoriteModels(undefined, storage)).toEqual(['claude:opus'])
      const drafts = createLocalComposerDraftStore(storage)
      expect(drafts.getText('session:a')).toBe('')
      expect(touched).toEqual([])
    },
    IMPORT_TIMEOUT_MS,
  )

  it('reaches no CSS and none of the web UI stack', () => {
    const forbidden = new RegExp(
      `^(${[...LOGIC_FORBIDDEN_PACKAGES, '@radix-ui', '@base-ui', '@shikijs', '@phosphor-icons']
        .map((name) => name.replace(/[/@.-]/g, '\\$&'))
        .join('|')})(/|$)`,
    )
    const offenders: string[] = []
    for (const [file, specifiers] of walkLogicGraph()) {
      const at = relative(packageDir, file).split(sep).join('/')
      if (/\.css$/.test(file)) offenders.push(at)
      for (const specifier of specifiers) {
        if (forbidden.test(specifier) || /\.css(\?|$)/.test(specifier)) {
          offenders.push(`${at} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
