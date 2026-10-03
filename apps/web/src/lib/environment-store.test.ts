import { describe, expect, it } from 'vitest'
import {
  adoptPersistedCredentials,
  classifyDiscoveredRoute,
  findStoredEnvironment,
  DEFAULT_ENVIRONMENT_LABEL,
  EMPTY_REGISTRY,
  ENVIRONMENT_STORAGE_KEY,
  LEGACY_ENVIRONMENT_STORAGE_KEY,
  environmentBootstrapUrl,
  environmentLocalOwnerUrl,
  isLoopbackEnvironmentEndpoint,
  parseEnvironmentCredential,
  parseEnvironmentEndpoint,
  parseStoredEnvironment,
  preferredRoute,
  preferStoredRoute,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  removeStoredRoute,
  routeInUse,
  routeSearchOrder,
  routeTypeForEndpoint,
  routeTypeLabel,
  selectStoredEnvironment,
  setStoredCredential,
  setStoredRouteHealth,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
  type EnvironmentRoute,
  type StoredEnvironment,
} from './environment-store'

const LOCAL = 'http://127.0.0.1:43120'
const TUNNEL = 'https://tunnel.example'
const NOW = new Date('2026-09-30T10:00:00.000Z')
const LATER = new Date('2026-09-30T11:00:00.000Z')

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  }
}

function route(
  endpoint: string,
  priority = 0,
  overrides: Partial<EnvironmentRoute> = {},
): EnvironmentRoute {
  return {
    type: routeTypeForEndpoint(endpoint),
    endpoint,
    priority,
    health: { status: 'unknown' },
    ...overrides,
  }
}

function environment(
  environmentId: string,
  routes: EnvironmentRoute[],
  overrides: Partial<StoredEnvironment> = {},
): StoredEnvironment {
  return { environmentId, label: 'Local', routes, credential: '', ...overrides }
}

/** One environment reachable on localhost and through a tunnel, localhost in use. */
function twoRoutes(): EnvironmentRegistry {
  return {
    selectedId: 'env-local',
    environments: [
      environment('env-local', [route(LOCAL, 0), route(TUNNEL, 1)], { credential: 'token-1' }),
    ],
  }
}

describe('parseEnvironmentEndpoint', () => {
  it('accepts http(s) origins and strips a trailing slash', () => {
    expect(parseEnvironmentEndpoint('http://127.0.0.1:43120/')).toBe('http://127.0.0.1:43120')
    expect(parseEnvironmentEndpoint(' https://env.example/path/ ')).toBe('https://env.example/path')
  })

  it('treats only loopback HTTP endpoints as local-owner eligible', () => {
    expect(isLoopbackEnvironmentEndpoint('http://127.0.0.1:43120')).toBe(true)
    expect(isLoopbackEnvironmentEndpoint('http://localhost:43120')).toBe(true)
    expect(isLoopbackEnvironmentEndpoint('https://tunnel.example')).toBe(false)
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
    expect(environmentLocalOwnerUrl(endpoint!)).toBe('https://host.example/openmanager/local-owner')
  })
})

describe('parseEnvironmentCredential', () => {
  it('trims a token and rejects whitespace or empty values', () => {
    expect(parseEnvironmentCredential('  abcdef  ')).toBe('abcdef')
    expect(parseEnvironmentCredential('')).toBe('')
    expect(parseEnvironmentCredential('ab cd')).toBe('')
  })

  it('rejects characters the WebSocket subprotocol grammar forbids', () => {
    expect(parseEnvironmentCredential('abc=')).toBe('')
    expect(parseEnvironmentCredential('a,b')).toBe('')
    expect(parseEnvironmentCredential('"abc"')).toBe('')
    expect(parseEnvironmentCredential('a'.repeat(64))).toBe('a'.repeat(64))
    expect(parseEnvironmentCredential('client-token_1.x~')).toBe('client-token_1.x~')
  })
})

describe('route types', () => {
  it('calls a loopback endpoint local and everything else remote', () => {
    expect(routeTypeForEndpoint('http://127.0.0.1:43120')).toBe('local')
    expect(routeTypeForEndpoint('http://localhost:43120')).toBe('local')
    expect(routeTypeForEndpoint('https://tunnel.example')).toBe('remote')
    expect(routeTypeForEndpoint('http://192.168.1.20:43120')).toBe('remote')
  })

  it('names the types it knows and shows any other as written', () => {
    expect(routeTypeLabel('local')).toBe('Local')
    expect(routeTypeLabel('cloudflare')).toBe('Cloudflare')
    expect(routeTypeLabel('wireguard')).toBe('wireguard')
  })
})

describe('upsertStoredEnvironment', () => {
  it('records an answer on a route the client picked without reordering', () => {
    const next = upsertStoredEnvironment(
      twoRoutes(),
      {
        environmentId: 'env-local',
        endpoint: TUNNEL,
        label: 'Studio',
        health: { status: 'available' },
        keepOrder: true,
      },
      NOW,
    )!
    expect(next.environments[0]!.routes).toEqual([
      route(LOCAL, 0),
      route(TUNNEL, 1, { health: { status: 'available', changedAt: NOW.toISOString() } }),
    ])
    expect(next.environments[0]!.label).toBe('Studio')
  })

  it('inserts a new record keyed by environment ID, with one route', () => {
    const next = upsertStoredEnvironment(EMPTY_REGISTRY, {
      environmentId: 'env-local',
      endpoint: 'http://127.0.0.1:43120/',
      label: 'Local',
      credential: 'token-1',
    })
    expect(next).toEqual({
      selectedId: 'env-local',
      environments: [environment('env-local', [route(LOCAL)], { credential: 'token-1' })],
    })
  })

  it('adds a second URL as another route to the same record instead of duplicating it', () => {
    const first = upsertStoredEnvironment(EMPTY_REGISTRY, {
      environmentId: 'env-local',
      endpoint: LOCAL,
      label: 'Local',
      credential: 'token-1',
    })!
    const second = upsertStoredEnvironment(first, {
      environmentId: 'env-local',
      endpoint: TUNNEL,
      label: 'Home lab',
    })
    expect(second).toEqual({
      selectedId: 'env-local',
      environments: [
        environment('env-local', [route(TUNNEL, 0), route(LOCAL, 1)], {
          label: 'Home lab',
          credential: 'token-1',
        }),
      ],
    })
  })

  it('adding the same environment twice by the same URL changes nothing', () => {
    const input = { environmentId: 'env-local', endpoint: LOCAL, label: 'Local' }
    const first = upsertStoredEnvironment(EMPTY_REGISTRY, input)!
    expect(upsertStoredEnvironment(first, input)).toEqual(first)
  })

  it('keeps identity and the credential when only the endpoint changes', () => {
    const moved = upsertStoredEnvironment(twoRoutes(), {
      environmentId: 'env-local',
      endpoint: 'https://new-tunnel.example',
    })!
    expect(moved.environments).toHaveLength(1)
    expect(moved.environments[0]).toMatchObject({
      environmentId: 'env-local',
      credential: 'token-1',
    })
    expect(moved.environments[0]!.routes.map((item) => item.endpoint)).toEqual([
      'https://new-tunnel.example',
      LOCAL,
      TUNNEL,
    ])
  })

  it('keeps what is known about a route when it is used again', () => {
    const known = setStoredRouteHealth(
      twoRoutes(),
      'env-local',
      TUNNEL,
      { status: 'unreachable', message: 'Tunnel down.' },
      NOW,
    )
    const next = upsertStoredEnvironment(known, { environmentId: 'env-local', endpoint: TUNNEL })!
    expect(next.environments[0]!.routes).toEqual([
      route(TUNNEL, 0, {
        health: { status: 'unreachable', changedAt: NOW.toISOString(), message: 'Tunnel down.' },
      }),
      route(LOCAL, 1),
    ])
  })

  it('records the health that reaching the endpoint showed', () => {
    const next = upsertStoredEnvironment(
      EMPTY_REGISTRY,
      { environmentId: 'env-local', endpoint: LOCAL, health: { status: 'available' } },
      NOW,
    )!
    expect(preferredRoute(next.environments[0]!).health).toEqual({
      status: 'available',
      changedAt: NOW.toISOString(),
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

describe('classifyDiscoveredRoute', () => {
  const OTHER = 'https://other.example'

  it('calls an unknown environment ID a new environment, whatever the address', () => {
    expect(
      classifyDiscoveredRoute(twoRoutes(), { environmentId: 'env-other', endpoint: LOCAL }),
    ).toEqual({ kind: 'new_environment' })
  })

  it('recognises an address the environment already has, however it is written', () => {
    expect(
      classifyDiscoveredRoute(twoRoutes(), {
        environmentId: 'env-local',
        endpoint: `${TUNNEL}/`,
      }),
    ).toMatchObject({ kind: 'known_route', environment: { environmentId: 'env-local' } })
  })

  it('says a new address would be sent the saved token when the connect brings none', () => {
    expect(
      classifyDiscoveredRoute(twoRoutes(), { environmentId: 'env-local', endpoint: OTHER }),
    ).toMatchObject({ kind: 'new_route', sendsSavedCredential: true })
    // A value that is not a usable token is no token.
    expect(
      classifyDiscoveredRoute(twoRoutes(), {
        environmentId: 'env-local',
        endpoint: OTHER,
        credential: 'not a token',
      }),
    ).toMatchObject({ kind: 'new_route', sendsSavedCredential: true })
  })

  it('has no saved token to send when the connect brings its own, or none is saved', () => {
    expect(
      classifyDiscoveredRoute(twoRoutes(), {
        environmentId: 'env-local',
        endpoint: OTHER,
        credential: 'token-2',
      }),
    ).toMatchObject({ kind: 'new_route', sendsSavedCredential: false })
    const tokenless: EnvironmentRegistry = {
      selectedId: 'env-local',
      environments: [environment('env-local', [route(LOCAL)])],
    }
    expect(
      classifyDiscoveredRoute(tokenless, { environmentId: 'env-local', endpoint: OTHER }),
    ).toMatchObject({ kind: 'new_route', sendsSavedCredential: false })
  })
})

describe('preferStoredRoute', () => {
  it('moves the chosen route to the front and renumbers the rest', () => {
    const next = preferStoredRoute(twoRoutes(), 'env-local', TUNNEL)
    expect(next.environments[0]!.routes).toEqual([route(TUNNEL, 0), route(LOCAL, 1)])
    expect(preferredRoute(next.environments[0]!).endpoint).toBe(TUNNEL)
  })

  it('selects the environment the route belongs to', () => {
    const registry = { ...twoRoutes(), selectedId: null }
    expect(preferStoredRoute(registry, 'env-local', LOCAL).selectedId).toBe('env-local')
  })

  it('returns the same registry for the route already in use or one it does not have', () => {
    const registry = twoRoutes()
    expect(preferStoredRoute(registry, 'env-local', LOCAL)).toBe(registry)
    expect(preferStoredRoute(registry, 'env-local', 'https://elsewhere.example')).toBe(registry)
    expect(preferStoredRoute(registry, 'env-missing', LOCAL)).toBe(registry)
  })
})

describe('routeSearchOrder and routeInUse', () => {
  const LAN = 'http://box.lan:43120'

  it("tries local routes first and keeps the person's order within each group", () => {
    const record = environment('env-local', [route(TUNNEL, 0), route(LAN, 1), route(LOCAL, 2)])
    expect(routeSearchOrder(record).map((item) => item.endpoint)).toEqual([LOCAL, TUNNEL, LAN])
  })

  it('leaves the order alone when every route is of one kind', () => {
    const record = environment('env-local', [route(TUNNEL, 0), route(LAN, 1)])
    expect(routeSearchOrder(record)).toBe(record.routes)
  })

  it('uses the route the client switched to while it is still saved', () => {
    const record = environment('env-local', [route(TUNNEL, 0), route(LOCAL, 1)])
    expect(routeInUse(record).endpoint).toBe(LOCAL)
    expect(routeInUse(record, TUNNEL).endpoint).toBe(TUNNEL)
    expect(routeInUse(record, 'https://forgotten.example').endpoint).toBe(LOCAL)
  })
})

describe('removeStoredRoute', () => {
  it('forgets one route and lets the next take its place', () => {
    const next = removeStoredRoute(twoRoutes(), 'env-local', LOCAL)
    expect(next.environments[0]!.routes).toEqual([route(TUNNEL, 0)])
    expect(next.environments[0]!.credential).toBe('token-1')
    expect(next.selectedId).toBe('env-local')
  })

  it('never forgets the last route of an environment', () => {
    const single = removeStoredRoute(twoRoutes(), 'env-local', LOCAL)
    expect(removeStoredRoute(single, 'env-local', TUNNEL)).toBe(single)
  })
})

describe('setStoredRouteHealth', () => {
  it('records a status with the time it changed', () => {
    const next = setStoredRouteHealth(
      twoRoutes(),
      'env-local',
      TUNNEL,
      { status: 'unauthorized', message: 'Access denied.' },
      NOW,
    )
    expect(next.environments[0]!.routes[1]!.health).toEqual({
      status: 'unauthorized',
      changedAt: NOW.toISOString(),
      message: 'Access denied.',
    })
    expect(next.environments[0]!.routes[0]!.health).toEqual({ status: 'unknown' })
  })

  it('treats a repeated report as no change, keeping the first time', () => {
    const first = setStoredRouteHealth(
      twoRoutes(),
      'env-local',
      LOCAL,
      { status: 'available' },
      NOW,
    )
    expect(setStoredRouteHealth(first, 'env-local', LOCAL, { status: 'available' }, LATER)).toBe(
      first,
    )
  })

  it('ignores a report for a route or an environment it does not have', () => {
    const registry = twoRoutes()
    const report = { status: 'unreachable' } as const
    expect(setStoredRouteHealth(registry, 'env-local', 'https://elsewhere.example', report)).toBe(
      registry,
    )
    expect(setStoredRouteHealth(registry, 'env-missing', LOCAL, report)).toBe(registry)
  })
})

describe('setStoredCredential', () => {
  it('replaces only the token, and refuses unknown environments and unsendable tokens', () => {
    const registry = twoRoutes()
    const next = setStoredCredential(registry, 'env-local', 'token-2')
    expect(next.environments[0]).toEqual({ ...registry.environments[0], credential: 'token-2' })
    expect(setStoredCredential(registry, 'env-other', 'token-2')).toBe(registry)
    expect(setStoredCredential(registry, 'env-local', 'has space')).toBe(registry)
    expect(setStoredCredential(registry, 'env-local', 'token-1')).toBe(registry)
  })
})

describe('adoptPersistedCredentials', () => {
  it('keeps a token another tab saved unless this tab changed the token itself', () => {
    const base = twoRoutes()
    const rotatedElsewhere = setStoredCredential(base, 'env-local', 'token-rotated')
    // This tab only recorded health; the other tab's rotation must survive.
    const healthOnly = setStoredRouteHealth(
      base,
      'env-local',
      LOCAL,
      { status: 'unauthorized' },
      NOW,
    )
    const merged = adoptPersistedCredentials(healthOnly, base, rotatedElsewhere)
    expect(merged.environments[0]!.credential).toBe('token-rotated')
    expect(merged.environments[0]!.routes[0]!.health.status).toBe('unauthorized')
    // Nothing changed elsewhere: the registry is returned as is.
    expect(adoptPersistedCredentials(healthOnly, base, base)).toBe(healthOnly)
    // This tab's own new token wins.
    const mine = setStoredCredential(base, 'env-local', 'token-mine')
    expect(
      adoptPersistedCredentials(mine, base, rotatedElsewhere).environments[0]!.credential,
    ).toBe('token-mine')
  })
})

describe('removeStoredEnvironment and selectStoredEnvironment', () => {
  const populated = {
    selectedId: 'env-a',
    environments: [
      environment('env-a', [route('http://127.0.0.1:43120')], { label: 'A' }),
      environment('env-b', [route('http://127.0.0.1:43121')], { label: 'B' }),
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
  it('round-trips routes, their order and their health, and ignores corrupt records', () => {
    const storage = memoryStorage()
    const registry = setStoredRouteHealth(
      twoRoutes(),
      'env-local',
      TUNNEL,
      { status: 'unreachable', message: 'Tunnel down.' },
      NOW,
    )
    writeEnvironmentRegistry(registry, storage)
    expect(JSON.parse(storage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}')).toMatchObject({
      version: 2,
    })
    expect(readEnvironmentRegistry(storage)).toEqual(registry)
    expect(readEnvironmentRegistry({ getItem: () => 'not-json' })).toEqual(EMPTY_REGISTRY)
  })

  it('upgrades a version 1 endpoint list into routes, keeping order, selection and token', () => {
    const storage = memoryStorage({
      [ENVIRONMENT_STORAGE_KEY]: JSON.stringify({
        version: 1,
        selectedId: 'env-local',
        environments: [
          {
            environmentId: 'env-local',
            label: 'Local',
            endpoints: [TUNNEL, LOCAL],
            credential: 'token-1',
          },
        ],
      }),
    })
    const upgraded = {
      selectedId: 'env-local',
      environments: [
        environment('env-local', [route(TUNNEL, 0), route(LOCAL, 1)], { credential: 'token-1' }),
      ],
    }
    expect(readEnvironmentRegistry(storage)).toEqual(upgraded)
    const written = JSON.parse(storage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}')
    expect(written).toEqual({ version: 2, ...upgraded })
  })

  it('ignores a registry from a version it does not know', () => {
    const storage = memoryStorage({
      [ENVIRONMENT_STORAGE_KEY]: JSON.stringify({
        version: 99,
        selectedId: null,
        environments: [],
      }),
    })
    expect(readEnvironmentRegistry(storage)).toEqual(EMPTY_REGISTRY)
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
      environments: [environment('env-local', [route(LOCAL)])],
    })
    expect(storage.getItem(LEGACY_ENVIRONMENT_STORAGE_KEY)).toBeNull()
    expect(JSON.parse(storage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}')).toMatchObject({
      version: 2,
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
  it('requires an ID and at least one valid route', () => {
    expect(
      parseStoredEnvironment({
        environmentId: 'env-1',
        label: 'Local',
        routes: [route(LOCAL)],
        credential: '',
      }),
    ).toEqual(environment('env-1', [route(LOCAL)]))
    expect(parseStoredEnvironment({ environmentId: 'env-1', routes: [] })).toBeNull()
    expect(
      parseStoredEnvironment({ environmentId: 'env-1', routes: [{ endpoint: 'ftp://x' }] }),
    ).toBeNull()
    expect(parseStoredEnvironment({ routes: [route(LOCAL)] })).toBeNull()
    expect(
      parseStoredEnvironment({ environmentId: 'env-1', routes: [route(LOCAL)], label: '   ' }),
    ).toMatchObject({ label: DEFAULT_ENVIRONMENT_LABEL })
  })

  it('orders routes by priority, drops a repeated endpoint and renumbers from zero', () => {
    const parsed = parseStoredEnvironment({
      environmentId: 'env-1',
      routes: [
        route(TUNNEL, 7),
        route(LOCAL, 3),
        route(TUNNEL, 1),
        { endpoint: 'https://b.example' },
      ],
    })
    expect(parsed?.routes.map((item) => [item.endpoint, item.priority])).toEqual([
      [LOCAL, 0],
      [TUNNEL, 1],
      ['https://b.example', 2],
    ])
  })

  it('keeps a route type it does not know and repairs one it cannot read', () => {
    const parsed = parseStoredEnvironment({
      environmentId: 'env-1',
      routes: [
        route(TUNNEL, 0, { type: 'cloudflare' }),
        { endpoint: LOCAL, priority: 1, type: 'Not A Type', health: { status: 'melting' } },
      ],
    })
    expect(parsed?.routes).toEqual([route(TUNNEL, 0, { type: 'cloudflare' }), route(LOCAL, 1)])
  })
})

describe('findStoredEnvironment', () => {
  const shared = 'http://127.0.0.1:4321'
  const a = environment('env-a', [route(shared)], { label: 'A', credential: 'a'.repeat(64) })
  const b = environment('env-b', [route(shared)], { label: 'B', credential: 'b'.repeat(64) })

  it('matches by environment ID even when several records share an endpoint', () => {
    expect(findStoredEnvironment([a, b], 'env-b')).toBe(b)
  })

  it('returns nothing without an ID or for an unknown ID; the endpoint is never consulted', () => {
    expect(findStoredEnvironment([a, b], undefined)).toBeUndefined()
    expect(findStoredEnvironment([a, b], null)).toBeUndefined()
    expect(findStoredEnvironment([a, b], 'env-unknown')).toBeUndefined()
    expect(shared).toBe(preferredRoute(a).endpoint)
  })
})
