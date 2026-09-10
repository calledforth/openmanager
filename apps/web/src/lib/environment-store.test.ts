import { describe, expect, it } from 'vitest'
import {
  findStoredEnvironment,
  DEFAULT_ENVIRONMENT_LABEL,
  EMPTY_REGISTRY,
  ENVIRONMENT_STORAGE_KEY,
  LEGACY_ENVIRONMENT_STORAGE_KEY,
  environmentBootstrapUrl,
  parseEnvironmentCredential,
  parseEnvironmentEndpoint,
  parseStoredEnvironment,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  selectStoredEnvironment,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
} from './environment-store'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  }
}

describe('parseEnvironmentEndpoint', () => {
  it('accepts http(s) origins and strips a trailing slash', () => {
    expect(parseEnvironmentEndpoint('http://127.0.0.1:43120/')).toBe('http://127.0.0.1:43120')
    expect(parseEnvironmentEndpoint(' https://env.example/path/ ')).toBe('https://env.example/path')
  })

  it('rejects credentials, non-http schemes, and invalid URLs', () => {
    expect(parseEnvironmentEndpoint('')).toBeNull()
    expect(parseEnvironmentEndpoint('not-a-url')).toBeNull()
    expect(parseEnvironmentEndpoint('ws://127.0.0.1:43120')).toBeNull()
    expect(parseEnvironmentEndpoint('http://user:pass@127.0.0.1:43120')).toBeNull()
  })

  it('joins bootstrap under a stored path prefix', () => {
    const endpoint = parseEnvironmentEndpoint('https://host.example/openmanager/')
    expect(endpoint).toBe('https://host.example/openmanager')
    expect(environmentBootstrapUrl(endpoint!)).toBe('https://host.example/openmanager/bootstrap')
  })
})

describe('parseEnvironmentCredential', () => {
  it('trims a token and rejects whitespace or empty values', () => {
    expect(parseEnvironmentCredential('  abcdef  ')).toBe('abcdef')
    expect(parseEnvironmentCredential('')).toBe('')
    expect(parseEnvironmentCredential('ab cd')).toBe('')
  })
})

describe('upsertStoredEnvironment', () => {
  it('inserts a new record keyed by environment ID', () => {
    const next = upsertStoredEnvironment(EMPTY_REGISTRY, {
      environmentId: 'env-local',
      endpoint: 'http://127.0.0.1:43120/',
      label: 'Local',
      credential: 'token-1',
    })
    expect(next).toEqual({
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Local',
          endpoints: ['http://127.0.0.1:43120'],
          credential: 'token-1',
        },
      ],
    })
  })

  it('merges a second URL into the existing record instead of duplicating', () => {
    const first = upsertStoredEnvironment(EMPTY_REGISTRY, {
      environmentId: 'env-local',
      endpoint: 'http://127.0.0.1:43120',
      label: 'Local',
      credential: 'token-1',
    })!
    const second = upsertStoredEnvironment(first, {
      environmentId: 'env-local',
      endpoint: 'https://tunnel.example',
      label: 'Home lab',
    })
    expect(second?.environments).toHaveLength(1)
    expect(second).toEqual({
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Home lab',
          endpoints: ['https://tunnel.example', 'http://127.0.0.1:43120'],
          credential: 'token-1',
        },
      ],
    })
  })

  it('keeps distinct environment IDs as separate records', () => {
    const first = upsertStoredEnvironment(EMPTY_REGISTRY, {
      environmentId: 'env-a',
      endpoint: 'http://127.0.0.1:43120',
    })!
    const second = upsertStoredEnvironment(first, {
      environmentId: 'env-b',
      endpoint: 'http://127.0.0.1:43121',
      label: 'Other',
    })
    expect(second?.environments.map((item) => item.environmentId)).toEqual(['env-a', 'env-b'])
    expect(second?.selectedId).toBe('env-b')
  })
})

describe('removeStoredEnvironment and selectStoredEnvironment', () => {
  const populated = {
    selectedId: 'env-a',
    environments: [
      {
        environmentId: 'env-a',
        label: 'A',
        endpoints: ['http://127.0.0.1:43120'],
        credential: '',
      },
      {
        environmentId: 'env-b',
        label: 'B',
        endpoints: ['http://127.0.0.1:43121'],
        credential: '',
      },
    ],
  }

  it('clears the selection when the selected environment is removed', () => {
    expect(removeStoredEnvironment(populated, 'env-a')).toEqual({
      selectedId: null,
      environments: [populated.environments[1]],
    })
  })

  it('selects an existing environment by ID', () => {
    expect(selectStoredEnvironment(populated, 'env-b').selectedId).toBe('env-b')
    expect(selectStoredEnvironment(populated, 'missing')).toBe(populated)
  })
})

describe('readEnvironmentRegistry', () => {
  it('round-trips a versioned registry and ignores corrupt records', () => {
    const storage = memoryStorage()
    writeEnvironmentRegistry(
      {
        selectedId: 'env-1',
        environments: [
          {
            environmentId: 'env-1',
            label: 'Local',
            endpoints: ['http://127.0.0.1:43120'],
            credential: 'token-1',
          },
        ],
      },
      storage,
    )
    expect(readEnvironmentRegistry(storage)).toEqual({
      selectedId: 'env-1',
      environments: [
        {
          environmentId: 'env-1',
          label: 'Local',
          endpoints: ['http://127.0.0.1:43120'],
          credential: 'token-1',
        },
      ],
    })
    expect(readEnvironmentRegistry({ getItem: () => 'not-json' })).toEqual(EMPTY_REGISTRY)
  })

  it('migrates the CAL-21 single-endpoint record into an ID-keyed registry', () => {
    const storage = memoryStorage({
      [LEGACY_ENVIRONMENT_STORAGE_KEY]: JSON.stringify({
        endpoint: 'http://127.0.0.1:43120/',
        environmentId: 'env-local',
        label: 'Local',
      }),
    })
    expect(readEnvironmentRegistry(storage)).toEqual({
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Local',
          endpoints: ['http://127.0.0.1:43120'],
          credential: '',
        },
      ],
    })
    expect(storage.getItem(LEGACY_ENVIRONMENT_STORAGE_KEY)).toBeNull()
    expect(JSON.parse(storage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}')).toMatchObject({
      version: 1,
      selectedId: 'env-local',
    })
  })

  it('returns empty when the default storage access throws', () => {
    const original = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    try {
      expect(readEnvironmentRegistry()).toEqual(EMPTY_REGISTRY)
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: original })
    }
  })
})

describe('parseStoredEnvironment', () => {
  it('requires an ID and at least one valid endpoint', () => {
    expect(
      parseStoredEnvironment({
        environmentId: 'env-1',
        label: 'Local',
        endpoints: ['http://127.0.0.1:43120'],
        credential: '',
      }),
    ).toEqual({
      environmentId: 'env-1',
      label: 'Local',
      endpoints: ['http://127.0.0.1:43120'],
      credential: '',
    })
    expect(parseStoredEnvironment({ environmentId: 'env-1', endpoints: [] })).toBeNull()
    expect(
      parseStoredEnvironment({ environmentId: 'env-1', endpoints: ['ftp://x'] }),
    ).toBeNull()
    expect(parseStoredEnvironment({ endpoints: ['http://127.0.0.1:43120'] })).toBeNull()
    expect(
      parseStoredEnvironment({
        environmentId: 'env-1',
        endpoints: ['http://127.0.0.1:43120'],
        label: '   ',
      }),
    ).toMatchObject({ label: DEFAULT_ENVIRONMENT_LABEL })
  })
})

describe('findStoredEnvironment', () => {
  const shared = 'http://127.0.0.1:4321'
  const a = { environmentId: 'env-a', label: 'A', endpoints: [shared], credential: 'a'.repeat(64) }
  const b = { environmentId: 'env-b', label: 'B', endpoints: [shared], credential: 'b'.repeat(64) }

  it('prefers the selected environment ID when several records share an endpoint', () => {
    expect(findStoredEnvironment([a, b], shared, 'env-b')).toBe(b)
  })

  it('falls back to the endpoint match when no ID is known yet', () => {
    expect(findStoredEnvironment([a, b], shared)).toBe(a)
    expect(findStoredEnvironment([a, b], shared, null)).toBe(a)
  })

  it('falls back to the endpoint match when the ID is not stored', () => {
    expect(findStoredEnvironment([a], shared, 'env-unknown')).toBe(a)
  })
})
