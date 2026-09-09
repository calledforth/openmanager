import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  COMPOSER_DRAFTS_STORAGE_KEY,
  MAX_DRAFT_TEXT_LENGTH,
  MAX_PERSISTED_DRAFTS,
  pruneComposerDrafts,
  readComposerDrafts,
  writeComposerDrafts,
  type PersistedDraft,
} from './composerDrafts'

function installMemoryStorage() {
  const store = new Map<string, string>()
  const memory: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key)
    },
    setItem: (key, value) => {
      store.set(key, value)
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memory,
  })
  return memory
}

const draft = (text: string, updatedAt = 1): PersistedDraft => ({ text, updatedAt })

describe('composerDrafts', () => {
  let storage: Storage

  beforeEach(() => {
    storage = installMemoryStorage()
  })

  afterEach(() => {
    storage.clear()
  })

  it('round-trips drafts keyed by session', () => {
    const drafts = {
      'session:abc': draft('half a question', 10),
      'draft:C:/repos/openmanager': draft('a new session thought', 20),
    }
    writeComposerDrafts(drafts)
    expect(storage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)).toBeTruthy()
    expect(readComposerDrafts()).toEqual(drafts)
  })

  it('keeps each session draft separate', () => {
    writeComposerDrafts({ 'session:a': draft('alpha', 1), 'session:b': draft('beta', 2) })
    const restored = readComposerDrafts()
    expect(restored['session:a']?.text).toBe('alpha')
    expect(restored['session:b']?.text).toBe('beta')
  })

  it('returns an empty map when nothing is stored', () => {
    expect(readComposerDrafts()).toEqual({})
  })

  it('returns an empty map for corrupt JSON', () => {
    storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, '{not json')
    expect(readComposerDrafts()).toEqual({})
  })

  it('returns an empty map when the payload is not an object', () => {
    storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify(['nope']))
    expect(readComposerDrafts()).toEqual({})
  })

  it('drops entries of the wrong shape but keeps valid siblings', () => {
    storage.setItem(
      COMPOSER_DRAFTS_STORAGE_KEY,
      JSON.stringify({
        'session:good': { text: 'keep me', updatedAt: 5 },
        'session:no-timestamp': { text: 'drop me' },
        'session:wrong-type': { text: 42, updatedAt: 5 },
        'session:null': null,
        'session:string': 'drop me too',
      }),
    )
    expect(readComposerDrafts()).toEqual({ 'session:good': draft('keep me', 5) })
  })

  it('evicts empty and whitespace-only drafts', () => {
    expect(
      pruneComposerDrafts({
        'session:a': draft('real text', 1),
        'session:b': draft('', 2),
        'session:c': draft('   \n\t ', 3),
      }),
    ).toEqual({ 'session:a': draft('real text', 1) })
  })

  it('truncates oversized drafts instead of dropping them', () => {
    const pruned = pruneComposerDrafts({
      'session:a': draft('x'.repeat(MAX_DRAFT_TEXT_LENGTH + 50), 1),
    })
    expect(pruned['session:a']?.text).toHaveLength(MAX_DRAFT_TEXT_LENGTH)
  })

  it('caps stored drafts at the most recently updated', () => {
    const drafts: Record<string, PersistedDraft> = {}
    for (let i = 0; i < MAX_PERSISTED_DRAFTS + 10; i += 1) {
      drafts[`session:${i}`] = draft(`draft ${i}`, i)
    }
    const pruned = pruneComposerDrafts(drafts)
    expect(Object.keys(pruned)).toHaveLength(MAX_PERSISTED_DRAFTS)
    // Newest kept, oldest evicted.
    expect(pruned['session:59']).toBeDefined()
    expect(pruned['session:0']).toBeUndefined()
  })

  it('does not mutate the input', () => {
    const drafts = { 'session:a': draft('keep', 1), 'session:b': draft('', 2) }
    pruneComposerDrafts(drafts)
    expect(Object.keys(drafts)).toEqual(['session:a', 'session:b'])
  })
})
