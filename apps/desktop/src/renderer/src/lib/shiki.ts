import { useSyncExternalStore } from 'react'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

/**
 * Languages we bundle. Shiki loads a full TextMate grammar per entry, so this
 * list is deliberately curated to what agent output actually contains rather
 * than shiki's ~200-language default bundle.
 */
const LANGS = [
  import('@shikijs/langs/typescript'),
  import('@shikijs/langs/tsx'),
  import('@shikijs/langs/javascript'),
  import('@shikijs/langs/jsx'),
  import('@shikijs/langs/json'),
  import('@shikijs/langs/python'),
  import('@shikijs/langs/rust'),
  import('@shikijs/langs/go'),
  import('@shikijs/langs/java'),
  import('@shikijs/langs/c'),
  // Deliberately no `cpp`: its grammar is ~800kB, and every entry here loads at
  // boot (the sync render path can't lazy-load). Add it back if it shows up.
  import('@shikijs/langs/shellscript'),
  import('@shikijs/langs/bash'),
  import('@shikijs/langs/html'),
  import('@shikijs/langs/css'),
  import('@shikijs/langs/markdown'),
  import('@shikijs/langs/sql'),
  import('@shikijs/langs/yaml'),
  import('@shikijs/langs/toml'),
  import('@shikijs/langs/diff'),
]

/** Aliases so common fence tags resolve instead of falling back to plaintext. */
export const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  md: 'markdown',
  jsonc: 'json',
  json5: 'json',
  text: 'plaintext',
  txt: 'plaintext',
  '': 'plaintext',
}

export const SHIKI_THEMES = { light: 'github-light', dark: 'github-dark' } as const

let highlighter: HighlighterCore | null = null
let loadPromise: Promise<HighlighterCore> | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/**
 * Creates the highlighter once, lazily. react-markdown runs unified
 * *synchronously*, so we can't use an async rehype plugin — the instance has to
 * exist up front and be handed to `rehypeShikiFromHighlighter`. Until it
 * resolves, code blocks render unhighlighted (still styled) and re-render once
 * this lands.
 */
export function ensureShiki(): Promise<HighlighterCore> {
  if (loadPromise) return loadPromise
  loadPromise = createHighlighterCore({
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
    langs: LANGS,
    engine: createOnigurumaEngine(import('shiki/wasm')),
  }).then((created) => {
    highlighter = created
    emit()
    return created
  })
  return loadPromise
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  void ensureShiki()
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return highlighter
}

/** Null until the grammars finish loading; re-renders the caller when ready. */
export function useShikiHighlighter(): HighlighterCore | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Normalizes a fence tag to a language shiki has loaded. */
export function resolveLang(raw: string | undefined, loaded: HighlighterCore | null): string {
  const tag = (raw ?? '').trim().toLowerCase()
  const mapped = LANG_ALIASES[tag] ?? tag
  if (!mapped || mapped === 'plaintext') return 'plaintext'
  if (!loaded) return 'plaintext'
  return loaded.getLoadedLanguages().includes(mapped) ? mapped : 'plaintext'
}
