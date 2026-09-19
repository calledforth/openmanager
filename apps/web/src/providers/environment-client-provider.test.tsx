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
  const { ui } = useConnection()
  return (
    <p>
      {ui.kind}:{client ? 'client' : 'none'}
    </p>
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

  it('does not create a client without a selected environment', async () => {
    const createClient = vi.fn(() => createFakeClient() as EnvironmentClient)
    renderProvider(createClient)
    await waitFor(() => expect(screen.getByText('no_environment:none')).toBeInTheDocument())
    expect(createClient).not.toHaveBeenCalled()
  })
})
