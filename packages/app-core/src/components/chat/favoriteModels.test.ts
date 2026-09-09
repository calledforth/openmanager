import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  favoriteModelKey,
  parseFavoriteModelKey,
  readFavoriteModels,
  toggleFavoriteModel,
  writeFavoriteModels,
  FAVORITE_MODELS_STORAGE_KEY,
} from './favoriteModels'

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

describe('favoriteModels', () => {
  let storage: Storage

  beforeEach(() => {
    storage = installMemoryStorage()
  })

  afterEach(() => {
    storage.clear()
  })

  it('round-trips favorite keys through localStorage', () => {
    const keys = [favoriteModelKey('claude', 'opus'), favoriteModelKey('cursor', 'composer-2.5')]
    writeFavoriteModels(keys)
    expect(storage.getItem(FAVORITE_MODELS_STORAGE_KEY)).toBeTruthy()
    expect(readFavoriteModels()).toEqual(keys)
  })

  it('ignores corrupt or unknown provider entries', () => {
    storage.setItem(
      FAVORITE_MODELS_STORAGE_KEY,
      JSON.stringify(['claude:sonnet', 'nope:x', 12, 'missing-sep', ':empty']),
    )
    expect(readFavoriteModels()).toEqual(['claude:sonnet'])
  })

  it('toggles membership without mutating the input', () => {
    const start = [favoriteModelKey('opencode', 'gpt')] as const
    const added = toggleFavoriteModel(start, favoriteModelKey('claude', 'opus'))
    expect(added).toEqual(['opencode:gpt', 'claude:opus'])
    expect(toggleFavoriteModel(added, favoriteModelKey('opencode', 'gpt'))).toEqual(['claude:opus'])
    expect(start).toEqual(['opencode:gpt'])
  })

  it('parses provider and model id at the first colon', () => {
    expect(parseFavoriteModelKey('cursor:composer-2.5')).toEqual({
      providerId: 'cursor',
      modelId: 'composer-2.5',
    })
    expect(parseFavoriteModelKey('opencode:openai/gpt-5')).toEqual({
      providerId: 'opencode',
      modelId: 'openai/gpt-5',
    })
    expect(parseFavoriteModelKey('unknown:x')).toBeNull()
  })
})
