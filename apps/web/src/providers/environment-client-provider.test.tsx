import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInitialState,
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
  type EnvironmentState,
  type EnvironmentStore,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { useEnvironmentClientOptional } from '@openmanager/app-core/providers/environment-client'
import { readEnvironmentCache, writeEnvironmentCache } from '../lib/environment-cache'
import { ENVIRONMENT_STORAGE_KEY } from '../lib/environment-store'
import { WRONG_ENVIRONMENT_MESSAGE } from '../lib/route-health'
import { createQueryClient } from '../query-client'
import { ConnectionProvider, useConnection } from './connection-provider'
import { WebEnvironmentClientProvider } from './environment-client-provider'

const ENDPOINT = 'http://127.0.0.1:43120'

afterEach(() => {
  cleanup()
  lastClient = null
  localStorage.clear()
  vi.unstubAllGlobals()
  setOnline(true)
  delete (window.navigator as { permissions?: unknown }).permissions
})

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: online })
}

/** The browser refused this page its `loopback-network` permission. */
function blockLoopbackAccess() {
  Object.defineProperty(window.navigator, 'permissions', {
    configurable: true,
    value: { query: async () => ({ state: 'denied' }) },
  })
}

function transition(type: 'online' | 'offline') {
  setOnline(type === 'online')
  act(() => {
    window.dispatchEvent(new Event(type))
  })
}

function seedEnvironment() {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Local environment',
          endpoints: [ENDPOINT],
          credential: '',
        },
      ],
    }),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        environmentId: 'env-local',
        label: 'Local environment',
        capabilities: ['connection.heartbeat'],
      }),
    })),
  )
}

const TUNNEL = 'https://tunnel.example'

/** One environment with a token, reachable on localhost (in use) and through a tunnel. */
function seedTwoRoutes() {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Local environment',
          routes: [
            { type: 'local', endpoint: ENDPOINT, priority: 0, health: { status: 'unknown' } },
            { type: 'remote', endpoint: TUNNEL, priority: 1, health: { status: 'unknown' } },
          ],
          credential: 'client-token',
        },
      ],
    }),
  )
}

const OTHER = 'https://other.example'

/** `env-local` as in `seedTwoRoutes`, and `env-other` on an address of its own. */
function seedTwoEnvironments() {
  seedTwoRoutes()
  const registry = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as {
    environments: unknown[]
  }
  registry.environments.push({
    environmentId: 'env-other',
    label: 'Other',
    routes: [{ type: 'remote', endpoint: OTHER, priority: 0, health: { status: 'unknown' } }],
    credential: 'other-token',
  })
  localStorage.setItem(ENVIRONMENT_STORAGE_KEY, JSON.stringify(registry))
}

function bootstrapAnswer(environmentId = 'env-local') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      environmentId,
      label: environmentId === 'env-local' ? 'Local environment' : 'Other',
      capabilities: ['connection.heartbeat'],
    }),
  }
}

function askedOf(endpoint: string) {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith(endpoint)).length
}

function storedRoutes() {
  const registry = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}') as {
    environments: Array<{
      routes: Array<{ endpoint: string; health: { status: string; message?: string } }>
    }>
  }
  expect(registry.environments).toHaveLength(1)
  return registry.environments[0]!.routes
}

/** Idle until dialled, as a real client is, and connected straight after. */
function createFakeClient() {
  let dialled = false
  const client = {
    commands: {} as EnvironmentClient['commands'],
    getState: vi.fn<EnvironmentClient['getState']>(() => ({
      ...createInitialState(),
      connection: {
        ...createInitialState().connection,
        phase: dialled ? ('connected' as const) : ('idle' as const),
      },
    })),
    listeners: new Set<() => void>(),
    subscribe: vi.fn((listener: () => void) => {
      client.listeners.add(listener)
      return () => client.listeners.delete(listener)
    }),
    supports: vi.fn(() => false),
    setActiveSession: vi.fn(),
    setActiveThread: vi.fn(),
    connect: vi.fn(() => {
      dialled = true
      for (const listener of client.listeners) listener()
    }),
    disconnect: vi.fn(),
    dispose: vi.fn(),
  }
  return client as unknown as EnvironmentClient & typeof client
}

/** A client factory that notes the address of every client that dials. */
function trackDials() {
  const dials: string[] = []
  const clients: Array<ReturnType<typeof createFakeClient>> = []
  const createClient = vi.fn((options: WebSocketEnvironmentClientOptions) => {
    const client = createFakeClient()
    const dial = client.connect.getMockImplementation()!
    client.connect.mockImplementation(() => {
      dials.push(options.url)
      dial()
    })
    clients.push(client)
    return client as EnvironmentClient
  })
  return { createClient, dials, clients }
}

let lastClient: EnvironmentClient | null = null

function Probe() {
  const client = useEnvironmentClientOptional()
  lastClient = client
  const {
    ui,
    chooseRoute,
    checkRoutes,
    connect,
    removeRoute,
    removeEnvironment,
    replaceCredential,
    selectEnvironment,
    addPairedEnvironment,
    retry,
    inUseEndpoint,
  } = useConnection()
  return (
    <>
      <p>
        {ui.kind}:{client ? 'client' : 'none'}
      </p>
      <p>in use: {inUseEndpoint}</p>
      {ui.reason ? <p>reason: {ui.reason}</p> : null}
      <button type="button" onClick={() => chooseRoute('env-local', TUNNEL)}>
        use tunnel
      </button>
      <button type="button" onClick={checkRoutes}>
        check routes
      </button>
      <button type="button" onClick={() => connect(ENDPOINT, 'new-token')}>
        reconnect local
      </button>
      <button type="button" onClick={() => connect(TUNNEL, 'new-token')}>
        connect tunnel
      </button>
      <button type="button" onClick={() => removeRoute('env-local', TUNNEL)}>
        forget tunnel
      </button>
      <button type="button" onClick={() => removeEnvironment('env-other')}>
        remove other
      </button>
      <button type="button" onClick={() => selectEnvironment('env-local')}>
        select local
      </button>
      <button type="button" onClick={() => selectEnvironment('env-other')}>
        select other
      </button>
      <button
        type="button"
        onClick={() =>
          addPairedEnvironment({
            environmentId: 'env-other',
            endpoint: OTHER,
            label: 'Other',
            credential: 'other-token',
          })
        }
      >
        pair other
      </button>
      <button type="button" onClick={retry}>
        retry
      </button>
      <button type="button" onClick={() => replaceCredential('env-local', 'rotated-token')}>
        rotate token
      </button>
    </>
  )
}

function renderProvider(
  createClient: (options: WebSocketEnvironmentClientOptions) => EnvironmentClient,
  options: { retryDelaysMs?: number[] } = {},
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ConnectionProvider retryDelaysMs={options.retryDelaysMs}>
        <WebEnvironmentClientProvider createClient={createClient as never}>
          <Probe />
        </WebEnvironmentClientProvider>
      </ConnectionProvider>
    </QueryClientProvider>,
  )
}

describe('WebEnvironmentClientProvider', () => {
  it('keeps the client through an offline blip and dials again when the network returns', async () => {
    seedEnvironment()
    const clients: Array<ReturnType<typeof createFakeClient>> = []
    renderProvider(() => {
      const client = createFakeClient()
      clients.push(client)
      return client
    })

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const client = clients[0]!
    expect(client.connect).toHaveBeenCalledTimes(1)

    transition('offline')
    expect(screen.getByText('offline:client')).toBeInTheDocument()
    expect(client.dispose).not.toHaveBeenCalled()
    expect(clients).toHaveLength(1)

    transition('online')
    await waitFor(() => expect(client.connect.mock.calls.length).toBeGreaterThan(1))
    expect(clients).toHaveLength(1)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
  })

  it('dials another route with the same environment identity and credential', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bootstrapAnswer()),
    )
    const clients: Array<ReturnType<typeof createFakeClient>> = []
    const stores: EnvironmentStore[] = []
    const createClient = vi.fn((options: WebSocketEnvironmentClientOptions) => {
      stores.push(options.store!)
      const client = createFakeClient()
      clients.push(client)
      return client as EnvironmentClient
    })
    renderProvider(createClient)

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(createClient).toHaveBeenLastCalledWith({
      url: 'ws://127.0.0.1:43120/ws',
      credential: 'client-token',
      environmentId: 'env-local',
      store: expect.any(Object),
    })

    stores[0]!.update(() => ({ ...createInitialState(), activeSessionId: 'cached-session' }))
    act(() => screen.getByRole('button', { name: 'use tunnel' }).click())
    await waitFor(() =>
      expect(createClient).toHaveBeenLastCalledWith({
        url: 'wss://tunnel.example/ws',
        credential: 'client-token',
        environmentId: 'env-local',
        store: expect.any(Object),
      }),
    )
    // The old socket is gone, and the environment is still one record.
    expect(stores[1]).toBe(stores[0])
    expect(stores[1]!.getState().activeSessionId).toBe('cached-session')
    expect(clients[0]!.dispose).toHaveBeenCalled()
    expect(storedRoutes().map((route) => route.endpoint)).toEqual([TUNNEL, ENDPOINT])
  })

  it('files what the socket learns on the route in use', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bootstrapAnswer()),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    renderProvider(() => client)

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    // Bootstrap answered through localhost, so that route is available.
    expect(storedRoutes()[0]).toMatchObject({ endpoint: ENDPOINT, health: { status: 'available' } })

    connection = {
      phase: 'reconnecting',
      failure: { code: 'unavailable', message: 'Connection closed.' },
    }
    act(() => notify())
    expect(storedRoutes()[0]).toMatchObject({
      endpoint: ENDPOINT,
      health: { status: 'unreachable', message: 'Connection closed.' },
    })
    // Reported, not acted on: the route in use is still the one the user chose.
    expect(storedRoutes().map((route) => route.endpoint)).toEqual([ENDPOINT, TUNNEL])

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    expect(storedRoutes()[0]!.health).toMatchObject({ status: 'unauthorized' })

    connection = { phase: 'connected', failure: null }
    act(() => notify())
    expect(storedRoutes()[0]!.health).toMatchObject({ status: 'available' })
    expect(storedRoutes()[1]!.health).toEqual({ status: 'unknown' })
  })

  it('withholds cached data until authentication and hides it on authorization failure', async () => {
    seedEnvironment()
    let notify = () => {}
    const initial = createInitialState()
    let connection: ReturnType<EnvironmentClient['getState']>['connection'] = {
      ...initial.connection,
      phase: 'connecting' as 'connecting' | 'connected' | 'closed',
    }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({ ...initial, connection }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    renderProvider(() => client)
    await waitFor(() => expect(client.connect).toHaveBeenCalled())
    expect(screen.getByText('ready:none')).toBeInTheDocument()
    act(() => {
      connection = { ...connection, phase: 'connected' }
      notify()
    })
    expect(screen.getByText('ready:client')).toBeInTheDocument()
    act(() => {
      connection = { ...connection, phase: 'closed', failure: { code: 'auth', message: 'Revoked' } }
      notify()
    })
    expect(screen.getByText('unauthorized:none')).toBeInTheDocument()
  })

  it('falls back to the next route that answers and keeps one record in the same order', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(ENDPOINT)) throw new TypeError('Failed to fetch')
        return bootstrapAnswer()
      }),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient)

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(dials).toEqual(['wss://tunnel.example/ws'])
    expect(createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'wss://tunnel.example/ws', credential: 'client-token' }),
    )
    // The person's order is theirs: localhost is still the first choice.
    expect(storedRoutes().map((route) => [route.endpoint, route.health.status])).toEqual([
      [ENDPOINT, 'unreachable'],
      [TUNNEL, 'available'],
    ])
    expect(screen.getByText(`in use: ${TUNNEL}`)).toBeInTheDocument()

    // Making the route that took over the first choice reorders and nothing
    // else: the working socket stays.
    act(() => screen.getByRole('button', { name: 'use tunnel' }).click())
    await waitFor(() =>
      expect(storedRoutes().map((route) => route.endpoint)).toEqual([TUNNEL, ENDPOINT]),
    )
    expect(dials).toEqual(['wss://tunnel.example/ws'])
    expect(screen.getByText('ready:client')).toBeInTheDocument()
    expect(screen.getByText(`in use: ${TUNNEL}`)).toBeInTheDocument()
  })

  it('prefers a local route that answers over a first choice that is not local', async () => {
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectedId: 'env-local',
        environments: [
          {
            environmentId: 'env-local',
            label: 'Local environment',
            endpoints: [TUNNEL, ENDPOINT],
            credential: 'client-token',
          },
        ],
      }),
    )
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => bootstrapAnswer())
    vi.stubGlobal('fetch', fetchMock)
    const createClient = vi.fn(() => createFakeClient() as EnvironmentClient)
    renderProvider(createClient)

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'ws://127.0.0.1:43120/ws' }),
    )
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([`${ENDPOINT}/bootstrap`])
    expect(storedRoutes().map((route) => route.endpoint)).toEqual([TUNNEL, ENDPOINT])
  })

  it('moves to the next route when the socket drops and its route stops answering', async () => {
    seedTwoRoutes()
    let localUp = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(ENDPOINT) && !localUp) throw new TypeError('Failed to fetch')
        return bootstrapAnswer()
      }),
    )
    const sockets: Array<{ client: ReturnType<typeof createFakeClient>; drop: () => void }> = []
    const createClient = vi.fn((options: WebSocketEnvironmentClientOptions) => {
      const client = createFakeClient()
      let connection: unknown = { phase: 'connected', failure: null }
      let notify = () => {}
      client.getState.mockImplementation(() => ({
        ...createInitialState(),
        connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
      }))
      client.subscribe.mockImplementation(((listener: () => void) => {
        notify = listener
        return () => undefined
      }) as never)
      sockets.push({
        client,
        drop: () => {
          connection = {
            phase: 'reconnecting',
            hasConnected: true,
            failure: { code: 'unavailable', message: 'Connection closed.' },
          }
          notify()
        },
      })
      void options
      return client as EnvironmentClient
    })
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    localUp = false
    act(() => sockets[0]!.drop())
    await waitFor(() => expect(createClient).toHaveBeenCalledTimes(2))
    expect(createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'wss://tunnel.example/ws', environmentId: 'env-local' }),
    )
    expect(sockets[0]!.client.dispose).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(storedRoutes().map((route) => route.endpoint)).toEqual([ENDPOINT, TUNNEL])
  })

  it('leaves a socket blip on a route that still answers to the socket', async () => {
    seedTwoRoutes()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => bootstrapAnswer())
    vi.stubGlobal('fetch', fetchMock)
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    const createClient = vi.fn(() => client as EnvironmentClient)
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const before = fetchMock.mock.calls.length

    connection = { phase: 'reconnecting', failure: { code: 'unavailable', message: 'Closed.' } }
    act(() => notify())
    // Localhost alone is asked; it still answers, so nothing moves.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1))
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`${ENDPOINT}/bootstrap`)
    await act(async () => {
      await Promise.resolve()
    })
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(client.dispose).not.toHaveBeenCalled()
    expect(screen.getByText(`in use: ${ENDPOINT}`)).toBeInTheDocument()
    // The bootstrap answering does not paper over the socket that is still down.
    expect(storedRoutes()[0]!.health).toMatchObject({ status: 'unreachable', message: 'Closed.' })
  })

  it('stops on a refused token without trying the other routes', async () => {
    seedTwoRoutes()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => bootstrapAnswer())
    vi.stubGlobal('fetch', fetchMock)
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    renderProvider(() => client)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const before = fetchMock.mock.calls.length

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    expect(screen.getByText('unauthorized:none')).toBeInTheDocument()
    expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('redials with a rotated token, and the old socket being cut does not refuse it', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bootstrapAnswer()),
    )
    const clients: Array<{ client: ReturnType<typeof createFakeClient>; notify: () => void }> = []
    const createClient = vi.fn((options: WebSocketEnvironmentClientOptions) => {
      const client = createFakeClient()
      const entry = { client, notify: () => {}, credential: options.credential }
      let connection: unknown = { phase: 'connected', failure: null }
      client.getState.mockImplementation(() => ({
        ...createInitialState(),
        connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
      }))
      client.subscribe.mockImplementation(((listener: () => void) => {
        entry.notify = () => {
          connection = { phase: 'closed', failure: { code: 'auth', message: 'Revoked.' } }
          listener()
        }
        return () => undefined
      }) as never)
      clients.push(entry)
      return client as EnvironmentClient
    })
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    // The rotation answer is saved first; the old socket's 4401 lands after.
    act(() => screen.getByRole('button', { name: 'rotate token' }).click())
    act(() => clients[0]!.notify())
    await waitFor(() =>
      expect(createClient).toHaveBeenLastCalledWith(
        expect.objectContaining({ credential: 'rotated-token' }),
      ),
    )
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(screen.queryByText('reason: credential_rejected')).toBeNull()
    expect(storedRoutes()[0]!.health.status).not.toBe('unauthorized')
  })

  it('takes a token another tab rotated, and its stale socket does not undo the rotation', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bootstrapAnswer()),
    )
    const notifiers: Array<() => void> = []
    const createClient = vi.fn((_options: WebSocketEnvironmentClientOptions) => {
      const client = createFakeClient()
      let connection: unknown = { phase: 'connected', failure: null }
      client.getState.mockImplementation(() => ({
        ...createInitialState(),
        connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
      }))
      client.subscribe.mockImplementation(((listener: () => void) => {
        notifiers.push(() => {
          connection = { phase: 'closed', failure: { code: 'auth', message: 'Revoked.' } }
          listener()
        })
        return () => undefined
      }) as never)
      return client as EnvironmentClient
    })
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    // Another tab rotates and saves the new token before this tab hears of it.
    const registry = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as {
      environments: Array<{ credential: string }>
    }
    registry.environments[0]!.credential = 'rotated-elsewhere'
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, JSON.stringify(registry))
    // This tab's old socket is cut first: its report must not write the old token back.
    act(() => notifiers[0]!())
    const saved = () =>
      (JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as typeof registry)
        .environments[0]!.credential
    expect(saved()).toBe('rotated-elsewhere')

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: ENVIRONMENT_STORAGE_KEY }))
    })
    await waitFor(() =>
      expect(createClient).toHaveBeenLastCalledWith(
        expect.objectContaining({ credential: 'rotated-elsewhere' }),
      ),
    )
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(saved()).toBe('rotated-elsewhere')
  })

  it('lifts a refusal when an unrelated write picks up a token another tab rotated', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bootstrapAnswer()),
    )
    const notifiers: Array<() => void> = []
    const createClient = vi.fn((_options: WebSocketEnvironmentClientOptions) => {
      const client = createFakeClient()
      let connection: unknown = { phase: 'connected', failure: null }
      client.getState.mockImplementation(() => ({
        ...createInitialState(),
        connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
      }))
      client.subscribe.mockImplementation(((listener: () => void) => {
        notifiers.push(() => {
          connection = { phase: 'closed', failure: { code: 'auth', message: 'Revoked.' } }
          listener()
        })
        return () => undefined
      }) as never)
      return client as EnvironmentClient
    })
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    // The old socket is cut before the other tab has saved the new token.
    act(() => notifiers[0]!())
    expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument()
    const registry = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as {
      environments: Array<{ credential: string }>
    }
    registry.environments[0]!.credential = 'rotated-elsewhere'
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, JSON.stringify(registry))
    // A route check lands before the storage event does, and its write takes the new token.
    act(() => screen.getByRole('button', { name: 'check routes' }).click())
    await waitFor(() =>
      expect(createClient).toHaveBeenLastCalledWith(
        expect.objectContaining({ credential: 'rotated-elsewhere' }),
      ),
    )
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(screen.queryByText('reason: credential_rejected')).toBeNull()
  })

  it('keeps a refused token refused when the network comes back', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL) => bootstrapAnswer()),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    const createClient = vi.fn(() => client as EnvironmentClient)
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    expect(screen.getByText('unauthorized:none')).toBeInTheDocument()

    transition('offline')
    transition('online')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument()
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('does not send a refused token through another route on its own', async () => {
    seedTwoRoutes()
    let localUp = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(ENDPOINT) && !localUp) throw new TypeError('Failed to fetch')
        return bootstrapAnswer()
      }),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    const createClient = vi.fn(() => client as EnvironmentClient)
    renderProvider(createClient, { retryDelaysMs: [10] })
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument()

    // Localhost goes away while offline; the tunnel would still answer.
    transition('offline')
    localUp = false
    transition('online')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument()
    expect(screen.getByText(`in use: ${ENDPOINT}`)).toBeInTheDocument()

    // Forgetting a route is not asking to try the token again either.
    localUp = true
    act(() => screen.getByRole('button', { name: 'forget tunnel' }).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument()
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('keeps a refused token refused when another environment is removed', async () => {
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectedId: 'env-local',
        environments: [
          {
            environmentId: 'env-local',
            label: 'Local environment',
            endpoints: [ENDPOINT],
            credential: 'client-token',
          },
          { environmentId: 'env-other', label: 'Other', endpoints: [TUNNEL], credential: '' },
        ],
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        bootstrapAnswer(String(input).startsWith(TUNNEL) ? 'env-other' : 'env-local'),
      ),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    renderProvider((options) =>
      options.environmentId === 'env-local' ? client : createFakeClient(),
    )
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    await waitFor(() =>
      expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument(),
    )
    const dialled = client.connect.mock.calls.length
    act(() => screen.getByRole('button', { name: 'remove other' }).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument()
    expect(client.connect).toHaveBeenCalledTimes(dialled)
  })

  it('lets a typed connect with a new token through after a refusal', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL) => bootstrapAnswer()),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const createClient = vi.fn((_options: WebSocketEnvironmentClientOptions) => {
      const client = createFakeClient()
      client.getState.mockImplementation(() => ({
        ...createInitialState(),
        connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
      }))
      client.subscribe.mockImplementation(((listener: () => void) => {
        notify = listener
        return () => undefined
      }) as never)
      return client as EnvironmentClient
    })
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    expect(screen.getByText('unauthorized:none')).toBeInTheDocument()

    connection = { phase: 'connected', failure: null }
    act(() => screen.getByRole('button', { name: 'reconnect local' }).click())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'ws://127.0.0.1:43120/ws', credential: 'new-token' }),
    )
  })

  it('does not let a search outlive a socket that came back on its own', async () => {
    seedTwoRoutes()
    let localUp = true
    let answerTunnel = (): void => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith(ENDPOINT) && !localUp) throw new TypeError('Failed to fetch')
        if (url.startsWith(TUNNEL)) {
          await new Promise<void>((resolve) => {
            answerTunnel = resolve
          })
          throw new TypeError('Failed to fetch')
        }
        return bootstrapAnswer()
      }),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    const createClient = vi.fn(() => client as EnvironmentClient)
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    // The socket drops and localhost fails its check, so the tunnel is asked.
    localUp = false
    connection = { phase: 'reconnecting', failure: { code: 'unavailable', message: 'Closed.' } }
    act(() => notify())
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith(TUNNEL))).toBe(
        true,
      ),
    )

    // The socket reconnects by itself before the tunnel answers.
    connection = { phase: 'connected', failure: null }
    act(() => notify())
    await act(async () => {
      answerTunnel()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(screen.getByText('ready:client')).toBeInTheDocument()
    expect(client.dispose).not.toHaveBeenCalled()
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it("does not carry one environment's refused token over to another", async () => {
    seedTwoEnvironments()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        bootstrapAnswer(String(input).startsWith(OTHER) ? 'env-other' : 'env-local'),
      ),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const refused = createFakeClient()
    refused.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    refused.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    const createClient = vi
      .fn<(options: WebSocketEnvironmentClientOptions) => EnvironmentClient>()
      .mockImplementationOnce(() => refused)
      .mockImplementation(() => createFakeClient())
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    await waitFor(() =>
      expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument(),
    )

    act(() => screen.getByRole('button', { name: 'select other' }).click())

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(screen.queryByText('reason: credential_rejected')).not.toBeInTheDocument()
  })

  it('lets a search finish for an environment that was left, without touching the selected one', async () => {
    seedTwoEnvironments()
    let localUp = true
    let answerTunnel = (): void => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith(OTHER)) return bootstrapAnswer('env-other')
        if (url.startsWith(ENDPOINT) && !localUp) throw new TypeError('Failed to fetch')
        if (url.startsWith(TUNNEL)) {
          await new Promise<void>((resolve) => {
            answerTunnel = resolve
          })
        }
        return bootstrapAnswer()
      }),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    const createClient = vi
      .fn<(options: WebSocketEnvironmentClientOptions) => EnvironmentClient>()
      .mockImplementationOnce(() => client)
      .mockImplementation(() => createFakeClient())
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    // The socket drops and localhost fails its check, so the tunnel is asked.
    localUp = false
    connection = { phase: 'reconnecting', failure: { code: 'unavailable', message: 'Closed.' } }
    act(() => notify())
    await waitFor(() => expect(askedOf(TUNNEL)).toBeGreaterThan(0))

    act(() => screen.getByRole('button', { name: 'select other' }).click())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const asked = askedOf(OTHER)

    // The search moves its own environment's route and asks that route again.
    await act(async () => {
      answerTunnel()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(askedOf(OTHER)).toBe(asked)
    expect(screen.getByText(`in use: ${OTHER}`)).toBeInTheDocument()
    expect(screen.getByText('ready:client')).toBeInTheDocument()
    expect(createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentId: 'env-local', url: 'wss://tunnel.example/ws' }),
    )
  })

  it('leaves a working connection alone when coming back to it', async () => {
    seedTwoEnvironments()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        bootstrapAnswer(String(input).startsWith(OTHER) ? 'env-other' : 'env-local'),
      ),
    )
    const { createClient, dials, clients } = trackDials()
    renderProvider(createClient)
    await waitFor(() => expect(dials).toHaveLength(2))
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const asked = askedOf(ENDPOINT)

    act(() => screen.getByRole('button', { name: 'select other' }).click())
    expect(screen.getByText(`in use: ${OTHER}`)).toBeInTheDocument()
    act(() => screen.getByRole('button', { name: 'select local' }).click())

    expect(screen.getByText('ready:client')).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(dials).toHaveLength(2)
    expect(askedOf(ENDPOINT)).toBe(asked)
    expect(clients[0]!.dispose).not.toHaveBeenCalled()
  })

  it('starts over when selecting an environment that is not through', async () => {
    seedTwoEnvironments()
    let localUp = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith(OTHER)) return bootstrapAnswer('env-other')
        if (url.startsWith(ENDPOINT) && localUp) return bootstrapAnswer()
        throw new TypeError('Failed to fetch')
      }),
    )
    const { createClient, dials } = trackDials()
    // Long enough that only selecting it can be what asks again.
    renderProvider(createClient, { retryDelaysMs: [60_000] })
    await waitFor(() => expect(screen.getByText('reason: environment_offline')).toBeInTheDocument())

    act(() => screen.getByRole('button', { name: 'select other' }).click())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    localUp = true
    act(() => screen.getByRole('button', { name: 'select local' }).click())
    await waitFor(() => expect(dials).toContain('ws://127.0.0.1:43120/ws'))
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
  })

  it('lets a search finish while pairing moves to another environment', async () => {
    seedTwoRoutes()
    let localUp = true
    let answerTunnel = (): void => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith(OTHER)) return bootstrapAnswer('env-other')
        if (url.startsWith(ENDPOINT) && !localUp) throw new TypeError('Failed to fetch')
        if (url.startsWith(TUNNEL)) {
          await new Promise<void>((resolve) => {
            answerTunnel = resolve
          })
        }
        return bootstrapAnswer()
      }),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    const createClient = vi
      .fn<(options: WebSocketEnvironmentClientOptions) => EnvironmentClient>()
      .mockImplementationOnce(() => client)
      .mockImplementation(() => createFakeClient())
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    localUp = false
    connection = { phase: 'reconnecting', failure: { code: 'unavailable', message: 'Closed.' } }
    act(() => notify())
    await waitFor(() => expect(askedOf(TUNNEL)).toBeGreaterThan(0))

    act(() => screen.getByRole('button', { name: 'pair other' }).click())
    await waitFor(() => expect(screen.getByText(`in use: ${OTHER}`)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const asked = askedOf(OTHER)

    await act(async () => {
      answerTunnel()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(askedOf(OTHER)).toBe(asked)
  })

  it('leaves a refused token behind when pairing moves to another environment', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        bootstrapAnswer(String(input).startsWith(OTHER) ? 'env-other' : 'env-local'),
      ),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const refused = createFakeClient()
    refused.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    refused.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    const createClient = vi
      .fn<(options: WebSocketEnvironmentClientOptions) => EnvironmentClient>()
      .mockImplementationOnce(() => refused)
      .mockImplementation(() => createFakeClient())
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    await waitFor(() =>
      expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument(),
    )

    act(() => screen.getByRole('button', { name: 'pair other' }).click())
    await waitFor(() => expect(screen.getByText(`in use: ${OTHER}`)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    // Selecting it again is a person's action, so its token may be tried again.
    act(() => screen.getByRole('button', { name: 'select local' }).click())
    await waitFor(() => expect(screen.getByText(`in use: ${ENDPOINT}`)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(screen.queryByText('reason: credential_rejected')).not.toBeInTheDocument()
  })

  it('reads a typed connect as connecting, not as a reconnect', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(TUNNEL)) await new Promise(() => undefined)
        return bootstrapAnswer()
      }),
    )
    renderProvider(vi.fn(() => createFakeClient() as EnvironmentClient))
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    act(() => screen.getByRole('button', { name: 'connect tunnel' }).click())

    await waitFor(() => expect(screen.getByText('connecting:none')).toBeInTheDocument())
  })

  it('does not let a search answer after a retry replaced it', async () => {
    seedTwoRoutes()
    let localUp = true
    let answerTunnel = (): void => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith(ENDPOINT) && !localUp) throw new TypeError('Failed to fetch')
        if (url.startsWith(TUNNEL)) {
          await new Promise<void>((resolve) => {
            answerTunnel = resolve
          })
        }
        return bootstrapAnswer()
      }),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    renderProvider(vi.fn(() => client as EnvironmentClient))
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    localUp = false
    connection = { phase: 'reconnecting', failure: { code: 'unavailable', message: 'Closed.' } }
    act(() => notify())
    await waitFor(() => expect(askedOf(TUNNEL)).toBeGreaterThan(0))

    // The route is back and a person asks again before the tunnel answers.
    localUp = true
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await act(async () => {
      answerTunnel()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(screen.getByText(`in use: ${ENDPOINT}`)).toBeInTheDocument()
  })

  it('says why no route answers and reconnects once one does', async () => {
    seedTwoRoutes()
    let up = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (!up) {
          if (String(input).startsWith(TUNNEL)) {
            return { ok: false, status: 502, json: async () => Promise.reject(new Error('html')) }
          }
          throw new TypeError('Failed to fetch')
        }
        return bootstrapAnswer()
      }),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient, { retryDelaysMs: [20] })

    await waitFor(() => expect(screen.getByText('reason: environment_offline')).toBeInTheDocument())
    expect(screen.getByText('unreachable:none')).toBeInTheDocument()
    expect(dials).toEqual([])

    up = true
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(screen.getByText(`in use: ${ENDPOINT}`)).toBeInTheDocument()
    expect(createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'ws://127.0.0.1:43120/ws' }),
    )
  })

  it('keeps searching for the tunnel while the browser blocks the local route', async () => {
    seedTwoRoutes()
    blockLoopbackAccess()
    let tunnelUp = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (tunnelUp && String(input).startsWith(TUNNEL)) return bootstrapAnswer()
        throw new TypeError('Failed to fetch')
      }),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient, { retryDelaysMs: [20] })

    // The blocked route is the one named, since a person can act on it.
    await waitFor(() =>
      expect(screen.getByText('reason: local_access_blocked')).toBeInTheDocument(),
    )
    expect(dials).toEqual([])

    // The tunnel comes back; nobody pressed anything.
    tunnelUp = true
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(screen.getByText(`in use: ${TUNNEL}`)).toBeInTheDocument()
  })

  it('leaves a blocked local route alone when it is the only one', async () => {
    seedEnvironment()
    blockLoopbackAccess()
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)
    const { createClient, dials } = trackDials()
    renderProvider(createClient, { retryDelaysMs: [20] })

    await waitFor(() =>
      expect(screen.getByText('reason: local_access_blocked')).toBeInTheDocument(),
    )
    const asked = fetchMock.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    // Waiting changes no browser setting, so the strip's "then retry" is true.
    expect(fetchMock.mock.calls.length).toBe(asked)
    expect(dials).toEqual([])
  })

  it('says a tunnel is down, or that the environment shut down when it said so', async () => {
    // Only the tunnel route, as on a phone away from the computer.
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        selectedId: 'env-local',
        environments: [
          {
            environmentId: 'env-local',
            label: 'Local environment',
            routes: [
              { type: 'remote', endpoint: TUNNEL, priority: 0, health: { status: 'unknown' } },
            ],
            credential: 'client-token',
          },
        ],
      }),
    )
    let up = true
    // What a browser sees of Cloudflare's 530 and 502 alike: the readable
    // request fails as if nothing answered, a no-cors one comes back opaque.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (up) return bootstrapAnswer()
        if (init?.mode === 'no-cors') return { type: 'opaque', ok: false, status: 0 }
        throw new TypeError('Failed to fetch')
      }),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    renderProvider(
      vi.fn(() => client as EnvironmentClient),
      { retryDelaysMs: [20] },
    )
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    // The environment closes the socket as it shuts down.
    up = false
    connection = {
      phase: 'reconnecting',
      failure: { code: 'unavailable', message: 'The environment shut down.', serverStopped: true },
    }
    act(() => notify())
    await waitFor(() => expect(screen.getByText('reason: environment_offline')).toBeInTheDocument())

    // The redials since say nothing new; it is still stopped.
    connection = { phase: 'reconnecting', failure: { code: 'unavailable', message: 'Closed.' } }
    act(() => notify())
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(screen.getByText('reason: environment_offline')).toBeInTheDocument()

    // It comes back, then the tunnel drops without a word from the server.
    up = true
    connection = { phase: 'connected', failure: null }
    act(() => notify())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    up = false
    connection = { phase: 'reconnecting', failure: { code: 'unavailable', message: 'Closed.' } }
    act(() => notify())
    await waitFor(() => expect(screen.getByText('reason: tunnel_down')).toBeInTheDocument())
  })

  it('records a route that does not answer and stays on it', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient)

    await waitFor(() => expect(screen.getByText('unreachable:none')).toBeInTheDocument())
    await waitFor(() => expect(storedRoutes()[0]!.health.status).toBe('unreachable'))
    expect(storedRoutes().map((route) => route.endpoint)).toEqual([ENDPOINT, TUNNEL])
    expect(dials).toEqual([])
  })

  it('stays on the selected environment when its route answers as another one', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          environmentId: 'env-other',
          label: 'Someone else',
          capabilities: ['connection.heartbeat'],
        }),
      })),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient)

    await waitFor(() => expect(screen.getByText('unreachable:none')).toBeInTheDocument())
    await waitFor(() =>
      expect(storedRoutes()[0]).toMatchObject({
        endpoint: ENDPOINT,
        health: { status: 'unreachable', message: WRONG_ENVIRONMENT_MESSAGE },
      }),
    )
    // Nothing was adopted: still one record, still selected, and no socket
    // carried its token to whatever answered.
    const registry = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}')
    expect(registry.selectedId).toBe('env-local')
    expect(
      registry.environments.map((item: { environmentId: string }) => item.environmentId),
    ).toEqual(['env-local'])
    expect(dials).toEqual([])

    // Offline outranks unreachable in the interface. It must not reopen the
    // door: the address still belongs to someone else.
    transition('offline')
    expect(screen.getByText('offline:none')).toBeInTheDocument()
    expect(dials).toEqual([])
    transition('online')
  })

  it('records a failed reconnect to the route in use', async () => {
    seedTwoRoutes()
    let up = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!up) throw new TypeError('Failed to fetch')
        return bootstrapAnswer()
      }),
    )
    renderProvider(() => createFakeClient())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(storedRoutes()[0]!.health.status).toBe('available')

    up = false
    act(() => screen.getByRole('button', { name: 'reconnect local' }).click())
    await waitFor(() => expect(storedRoutes()[0]!.health.status).toBe('unreachable'))
    expect(storedRoutes().map((route) => route.endpoint)).toEqual([ENDPOINT, TUNNEL])
  })

  it('does not bring back a route forgotten while a connect to it was in flight', async () => {
    seedTwoRoutes()
    let answerTunnel = (): void => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(TUNNEL)) {
          await new Promise<void>((resolve) => {
            answerTunnel = resolve
          })
        }
        return bootstrapAnswer()
      }),
    )
    renderProvider(() => createFakeClient())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    act(() => screen.getByRole('button', { name: 'connect tunnel' }).click())
    act(() => screen.getByRole('button', { name: 'forget tunnel' }).click())
    await act(async () => {
      answerTunnel()
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(storedRoutes().map((route) => route.endpoint)).toEqual([ENDPOINT])
  })

  it('does not bring a forgotten route back through an address another environment shares', async () => {
    // Two environments saved the tunnel address; env-local is selected on localhost.
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectedId: 'env-local',
        environments: [
          {
            environmentId: 'env-local',
            label: 'Local environment',
            endpoints: [ENDPOINT, TUNNEL],
            credential: 'client-token',
          },
          { environmentId: 'env-other', label: 'Other', endpoints: [TUNNEL], credential: '' },
        ],
      }),
    )
    let answerTunnel = (): void => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(TUNNEL)) {
          await new Promise<void>((resolve) => {
            answerTunnel = resolve
          })
        }
        // The tunnel answers as env-local: the one whose route is forgotten.
        return bootstrapAnswer()
      }),
    )
    renderProvider(() => createFakeClient())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    act(() => screen.getByRole('button', { name: 'connect tunnel' }).click())
    act(() => screen.getByRole('button', { name: 'forget tunnel' }).click())
    await act(async () => {
      answerTunnel()
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const registry = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}') as {
      selectedId: string
      environments: Array<{ environmentId: string; routes: Array<{ endpoint: string }> }>
    }
    expect(registry.selectedId).toBe('env-local')
    expect(
      registry.environments.map((item) => [
        item.environmentId,
        item.routes.map((route) => route.endpoint),
      ]),
    ).toEqual([
      ['env-local', [ENDPOINT]],
      ['env-other', [TUNNEL]],
    ])
  })

  it('checks the routes that are not in use and leaves the live one alone', async () => {
    seedTwoRoutes()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith(TUNNEL)) throw new TypeError('Failed to fetch')
      return bootstrapAnswer()
    })
    vi.stubGlobal('fetch', fetchMock)
    renderProvider(() => createFakeClient())

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const before = fetchMock.mock.calls.length
    act(() => screen.getByRole('button', { name: 'check routes' }).click())

    await waitFor(() => expect(storedRoutes()[1]!.health.status).toBe('unreachable'))
    const probed = fetchMock.mock.calls.slice(before).map(([input]) => String(input))
    // Asked twice: the failed fetch is followed by a no-cors one, to tell an
    // answer the page may not read from silence.
    expect([...new Set(probed)]).toEqual([`${TUNNEL}/bootstrap`])
    expect(storedRoutes()[0]).toMatchObject({ endpoint: ENDPOINT, health: { status: 'available' } })
  })

  it('does not create a client without a saved environment', async () => {
    const createClient = vi.fn(() => createFakeClient() as EnvironmentClient)
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('no_environment:none')).toBeInTheDocument())
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('every saved environment at once', () => {
  it('connects each one on load, each with its own token', async () => {
    seedTwoEnvironments()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        bootstrapAnswer(String(input).startsWith(OTHER) ? 'env-other' : 'env-local'),
      ),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient)

    await waitFor(() =>
      expect([...dials].sort()).toEqual(['ws://127.0.0.1:43120/ws', 'wss://other.example/ws']),
    )
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env-local', credential: 'client-token' }),
    )
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env-other', credential: 'other-token' }),
    )
    // An answer from the other environment does not move the selection.
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    const registry = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}')
    expect(registry.selectedId).toBe('env-local')
  })

  it('keeps one failing from touching the others, and finds it again when it returns', async () => {
    seedTwoEnvironments()
    let otherUp = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).startsWith(OTHER)) return bootstrapAnswer()
        if (!otherUp) throw new TypeError('Failed to fetch')
        return bootstrapAnswer('env-other')
      }),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient, { retryDelaysMs: [20] })

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    await waitFor(() => expect(askedOf(OTHER)).toBeGreaterThan(2))
    expect(dials).toEqual(['ws://127.0.0.1:43120/ws'])
    expect(screen.getByText('ready:client')).toBeInTheDocument()

    // Nobody selected it: it is retried on its own and dials on its own.
    otherUp = true
    await waitFor(() => expect(dials).toContain('wss://other.example/ws'))
    expect(screen.getByText('ready:client')).toBeInTheDocument()
    expect(screen.getByText(`in use: ${ENDPOINT}`)).toBeInTheDocument()
  })

  it('files what an unselected socket says on its own environment', async () => {
    seedTwoEnvironments()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        bootstrapAnswer(String(input).startsWith(OTHER) ? 'env-other' : 'env-local'),
      ),
    )
    const { createClient, clients } = trackDials()
    renderProvider(createClient)
    await waitFor(() => expect(clients).toHaveLength(2))
    await waitFor(() => expect(clients[1]!.connect).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    const other = clients[1]!
    other.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: {
        ...createInitialState().connection,
        phase: 'closed',
        failure: { code: 'auth', message: 'Token revoked.' },
      },
    }))
    act(() => {
      for (const listener of other.listeners) listener()
    })

    // Refused where it happened, and nowhere else.
    await waitFor(() => expect(other.dispose).toHaveBeenCalled())
    expect(screen.getByText('ready:client')).toBeInTheDocument()
    expect(screen.queryByText('reason: credential_rejected')).not.toBeInTheDocument()
    act(() => screen.getByRole('button', { name: 'select other' }).click())
    await waitFor(() => expect(screen.getByText(`in use: ${OTHER}`)).toBeInTheDocument())
  })

  it('does not dial a refused token again when a typed connect goes elsewhere', async () => {
    seedTwoRoutes()
    let notify = () => {}
    let connection: unknown = { phase: 'connected', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(TUNNEL)) await new Promise(() => undefined)
        return bootstrapAnswer()
      }),
    )
    const createClient = vi.fn(() => client as EnvironmentClient)
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } }
    act(() => notify())
    await waitFor(() => expect(client.dispose).toHaveBeenCalled())
    const dialled = client.connect.mock.calls.length

    // The address answers nothing yet, so nothing has answered the refusal.
    act(() => screen.getByRole('button', { name: 'connect tunnel' }).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(client.connect).toHaveBeenCalledTimes(dialled)
  })
})

describe('what may open a socket', () => {
  /** A client that says what it is told, so no socket report outranks bootstrap. */
  function scriptedClient() {
    let notify = () => {}
    const script = {
      connection: { phase: 'connected', failure: null } as unknown,
      tell: () => act(() => notify()),
    }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      connection: script.connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    return { client, script }
  }

  it('never dials a route that was verified and now answers as another environment', async () => {
    seedTwoRoutes()
    let answering = 'env-local'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bootstrapAnswer(answering)),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient, { retryDelaysMs: [60_000] })
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(dials).toEqual(['ws://127.0.0.1:43120/ws'])

    // The port was handed to something else.
    answering = 'env-other'
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    // Retry nudges the client it already has, which is a no-op on a live socket.
    const before = dials.length
    await waitFor(() =>
      expect(storedRoutes()[0]!.health).toMatchObject({ message: WRONG_ENVIRONMENT_MESSAGE }),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(dials).toHaveLength(before)
  })

  it('does not take an earlier answer as leave to dial again after a refusal', async () => {
    seedTwoRoutes()
    let hang = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (hang) await new Promise(() => undefined)
        return bootstrapAnswer()
      }),
    )
    const { client, script } = scriptedClient()
    const next = createFakeClient()
    const createClient = vi
      .fn<(options: WebSocketEnvironmentClientOptions) => EnvironmentClient>()
      .mockImplementationOnce(() => client)
      .mockImplementation(() => next)
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    script.connection = { phase: 'closed', failure: { code: 'auth', message: 'Revoked.' } }
    script.tell()
    await waitFor(() => expect(client.dispose).toHaveBeenCalled())

    // Asked again, with nothing back yet: the last answer is all there is.
    hang = true
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(next.connect).not.toHaveBeenCalled()
  })

  it('keeps the last answer on screen while the same route is asked again', async () => {
    seedTwoRoutes()
    let hang = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (hang) await new Promise(() => undefined)
        return bootstrapAnswer()
      }),
    )
    const { client } = scriptedClient()
    renderProvider(() => client)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    hang = true
    act(() => screen.getByRole('button', { name: 'retry' }).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByText('ready:client')).toBeInTheDocument()
  })

  it('does not read one route as answering for another', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(TUNNEL)) await new Promise(() => undefined)
        return bootstrapAnswer()
      }),
    )
    const { createClient, dials } = trackDials()
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    act(() => screen.getByRole('button', { name: 'use tunnel' }).click())
    await waitFor(() => expect(screen.getByText(`in use: ${TUNNEL}`)).toBeInTheDocument())
    expect(screen.queryByText(/^ready:/)).not.toBeInTheDocument()
    expect(dials).toEqual(['ws://127.0.0.1:43120/ws'])
  })

  it('gets through as soon as a typed connect reaches a route that was failing', async () => {
    seedTwoRoutes()
    let up = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!up) throw new TypeError('Failed to fetch')
        return bootstrapAnswer()
      }),
    )
    const { createClient, dials } = trackDials()
    // Too long to wait out: only the connect can be what gets it through.
    renderProvider(createClient, { retryDelaysMs: [60_000] })
    await waitFor(() => expect(screen.getByText('reason: environment_offline')).toBeInTheDocument())

    up = true
    act(() => screen.getByRole('button', { name: 'reconnect local' }).click())
    await waitFor(() => expect(dials).toContain('ws://127.0.0.1:43120/ws'))
  })
})

describe('an environment this browser has a cache of', () => {
  const CACHED: EnvironmentState = {
    ...createInitialState(),
    environment: { environmentId: 'env-local', name: 'Local environment' },
  }

  /** A real client on a socket that counts its openings and never connects. */
  function realClients() {
    const opened: string[] = []
    class CountingSocket extends EventTarget {
      readonly readyState = 0
      constructor(url: string) {
        super()
        opened.push(url)
      }
      send() {}
      close() {}
    }
    const createClient = (options: WebSocketEnvironmentClientOptions) =>
      createWebSocketEnvironmentClient({ ...options, WebSocket: CountingSocket as never })
    return { createClient, opened }
  }

  it('shows it after a reload with no route answering, and opens no socket', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await writeEnvironmentCache('env-local', CACHED)
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { createClient, opened } = realClients()
    renderProvider(createClient, { retryDelaysMs: [20] })

    await waitFor(() => expect(screen.getByText('unreachable:client')).toBeInTheDocument())
    expect(lastClient?.getState().environment?.environmentId).toBe('env-local')
    expect(opened).toEqual([])
  })

  it('offers nothing that would carry the token until the socket has got through', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await writeEnvironmentCache('env-local', CACHED)
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { createClient } = realClients()
    renderProvider(createClient, { retryDelaysMs: [20] })

    await waitFor(() => expect(screen.getByText('unreachable:client')).toBeInTheDocument())
    expect(lastClient?.fetchArtifact).toBeUndefined()
    expect(lastClient?.uploadArtifact).toBeUndefined()
  })

  it('saves an environment off screen less often, and at the latest on leaving', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await writeEnvironmentCache('env-other', {
      ...CACHED,
      environment: { environmentId: 'env-other', name: 'Other' },
    })
    seedTwoEnvironments()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const stores = new Map<string, EnvironmentStore>()
    renderProvider((options) => {
      stores.set(options.environmentId!, options.store!)
      return createFakeClient()
    })
    await waitFor(() => expect(stores.has('env-other')).toBe(true))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const changed = (state: EnvironmentState) => ({ ...state, activeSessionId: 'typed' })
    stores.get('env-other')!.update(changed)
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect((await readEnvironmentCache('env-other'))?.activeSessionId).toBeNull()

    window.dispatchEvent(new Event('pagehide'))
    await waitFor(async () =>
      expect((await readEnvironmentCache('env-other'))?.activeSessionId).toBe('typed'),
    )
  })

  it('dials the moment a route answers as it', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await writeEnvironmentCache('env-local', CACHED)
    seedTwoRoutes()
    let up = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!up) throw new TypeError('Failed to fetch')
        return bootstrapAnswer()
      }),
    )
    const { createClient, opened } = realClients()
    renderProvider(createClient, { retryDelaysMs: [20] })
    await waitFor(() => expect(screen.getByText('unreachable:client')).toBeInTheDocument())

    up = true
    await waitFor(() => expect(opened).toEqual(['ws://127.0.0.1:43120/ws']))
  })

  it('hides it once the environment refuses the token', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await writeEnvironmentCache('env-local', CACHED)
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bootstrapAnswer()),
    )
    let notify = () => {}
    let connection: unknown = { phase: 'connecting', failure: null }
    let cachedEnvironment: EnvironmentState['environment'] = null
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({
      ...createInitialState(),
      environment: cachedEnvironment,
      connection: connection as ReturnType<EnvironmentClient['getState']>['connection'],
    }))
    client.subscribe.mockImplementation(((listener: () => void) => {
      notify = listener
      return () => undefined
    }) as never)
    renderProvider((options) => {
      cachedEnvironment = options.store!.getState().environment
      return client
    })
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())

    connection = { phase: 'closed', failure: { code: 'auth', message: 'Revoked' } }
    act(() => notify())
    expect(screen.getByText('unauthorized:none')).toBeInTheDocument()
  })
})
