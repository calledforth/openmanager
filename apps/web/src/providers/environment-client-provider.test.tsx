import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { useEnvironmentClientOptional } from '@openmanager/app-core/providers/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from '../lib/environment-store'
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
    getState: vi.fn(),
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
  const { ui, chooseRoute, checkRoutes } = useConnection()
  return (
    <>
      <p>
        {ui.kind}:{client ? 'client' : 'none'}
      </p>
      <button type="button" onClick={() => chooseRoute('env-local', TUNNEL)}>
        use tunnel
      </button>
      <button type="button" onClick={checkRoutes}>
        check routes
      </button>
    </>
  )
}

function renderProvider(createClient: () => EnvironmentClient) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ConnectionProvider>
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
    const createClient = vi.fn(() => {
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
    })

    act(() => screen.getByRole('button', { name: 'use tunnel' }).click())
    await waitFor(() =>
      expect(createClient).toHaveBeenLastCalledWith({
        url: 'wss://tunnel.example/ws',
        credential: 'client-token',
        environmentId: 'env-local',
      }),
    )
    // The old socket is gone, and the environment is still one record.
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
    let connection: unknown = { phase: 'connecting', failure: null }
    const client = createFakeClient()
    client.getState.mockImplementation(() => ({ connection }))
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
