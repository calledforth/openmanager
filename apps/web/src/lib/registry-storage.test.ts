import {
  EMPTY_REGISTRY,
  ENVIRONMENT_STORAGE_KEY,
  readEnvironmentRegistry,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
} from '@openmanager/environment-client/connection'
import { afterEach, describe, expect, it } from 'vitest'
import { browserRegistryStorage } from './registry-storage'

const registry: EnvironmentRegistry = {
  selectedId: 'env-local',
  environments: [
    {
      environmentId: 'env-local',
      label: 'Local',
      credential: 'token',
      routes: [
        {
          type: 'local',
          endpoint: 'http://127.0.0.1:43120',
          priority: 0,
          health: { status: 'unknown' },
        },
      ],
    },
  ],
}

afterEach(() => {
  window.localStorage.clear()
})

describe('browserRegistryStorage', () => {
  it('keeps the registry in localStorage', () => {
    writeEnvironmentRegistry(registry, browserRegistryStorage)
    expect(window.localStorage.getItem(ENVIRONMENT_STORAGE_KEY)).not.toBeNull()
    expect(readEnvironmentRegistry(browserRegistryStorage)).toEqual(registry)
  })

  it('reads an empty registry when the browser refuses storage', () => {
    const original = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    try {
      expect(readEnvironmentRegistry(browserRegistryStorage)).toEqual(EMPTY_REGISTRY)
      expect(() => writeEnvironmentRegistry(registry, browserRegistryStorage)).not.toThrow()
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: original })
    }
  })
})
