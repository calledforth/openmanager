import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInitialState,
  type EnvironmentClient,
  type EnvironmentStore,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { useEnvironmentClientOptional } from '@openmanager/app-core/providers/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from '../lib/environment-store'
import { WRONG_ENVIRONMENT_MESSAGE } from '../lib/route-health'
import { createQueryClient } from '../query-client'
import { ConnectionProvider, useConnection } from './connection-provider'
import { WebEnvironmentClientProvider } from './environment-client-provider'

const ENDPOINT = 'http://127.0.0.1:43120'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  setOnline(true)
})

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: online })
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

function bootstrapAnswer() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      environmentId: 'env-local',
      label: 'Local environment',
      capabilities: ['connection.heartbeat'],
    }),
  }
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

function createFakeClient() {
  const client = {
    commands: {} as EnvironmentClient['commands'],
    getState: vi.fn<EnvironmentClient['getState']>(() => ({
      ...createInitialState(),
      connection: { ...createInitialState().connection, phase: 'connected' as const },
    })),
    subscribe: vi.fn(() => () => undefined),
    supports: vi.fn(() => false),
    setActiveSession: vi.fn(),
    setActiveThread: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    dispose: vi.fn(),
  }
  return client as unknown as EnvironmentClient & typeof client
}

function Probe() {
  const client = useEnvironmentClientOptional()
  const { ui, chooseRoute, checkRoutes, connect, removeRoute, removeEnvironment, inUseEndpoint } =
    useConnection()
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
    const createClient = vi.fn(() => createFakeClient() as EnvironmentClient)
    renderProvider(createClient)

    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(createClient).toHaveBeenCalledTimes(1)
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
    expect(createClient).toHaveBeenCalledTimes(1)
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
    act(() => screen.getByRole('button', { name: 'remove other' }).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.getByText('reason: credential_rejected')).toBeInTheDocument()
    expect(createClient).toHaveBeenCalledTimes(1)
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
    const createClient = vi.fn(() => createFakeClient() as EnvironmentClient)
    renderProvider(createClient, { retryDelaysMs: [20] })

    await waitFor(() => expect(screen.getByText('reason: environment_offline')).toBeInTheDocument())
    expect(screen.getByText('unreachable:none')).toBeInTheDocument()
    expect(createClient).not.toHaveBeenCalled()

    up = true
    await waitFor(() => expect(screen.getByText('ready:client')).toBeInTheDocument())
    expect(screen.getByText(`in use: ${ENDPOINT}`)).toBeInTheDocument()
    expect(createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'ws://127.0.0.1:43120/ws' }),
    )
  })

  it('records a route that does not answer and stays on it', async () => {
    seedTwoRoutes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const createClient = vi.fn(() => createFakeClient() as EnvironmentClient)
    renderProvider(createClient)

    await waitFor(() => expect(screen.getByText('unreachable:none')).toBeInTheDocument())
    await waitFor(() => expect(storedRoutes()[0]!.health.status).toBe('unreachable'))
    expect(storedRoutes().map((route) => route.endpoint)).toEqual([ENDPOINT, TUNNEL])
    expect(createClient).not.toHaveBeenCalled()
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
    const createClient = vi.fn(() => createFakeClient() as EnvironmentClient)
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
    expect(createClient).not.toHaveBeenCalled()

    // Offline outranks unreachable in the interface. It must not reopen the
    // door: the address still belongs to someone else.
    transition('offline')
    expect(screen.getByText('offline:none')).toBeInTheDocument()
    expect(createClient).not.toHaveBeenCalled()
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
    expect(probed).toEqual([`${TUNNEL}/bootstrap`])
    expect(storedRoutes()[0]).toMatchObject({ endpoint: ENDPOINT, health: { status: 'available' } })
  })

  it('does not create a client without a selected environment', async () => {
    const createClient = vi.fn(() => createFakeClient() as EnvironmentClient)
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('no_environment:none')).toBeInTheDocument())
    expect(createClient).not.toHaveBeenCalled()
  })
})
