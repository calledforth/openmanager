import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInitialState,
  EnvironmentClientError,
  type EnvironmentClient,
  type EnvironmentState,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from '../lib/environment-store'
import { createQueryClient } from '../query-client'
import { addressOf, useFindAddress, type Address } from './address-environment'
import { ConnectionProvider, useConnection } from './connection-provider'
import { WebEnvironmentClientProvider } from './environment-client-provider'

const A = 'http://127.0.0.1:43120'
const B = 'https://b.example'
const SESSION: Address = { kind: 'session', id: 'session-1' }
const DRAFT: Address = { kind: 'draft', id: 'draft-1' }

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function seed(selectedId: string | null = 'env-a', extra: Record<string, unknown> = {}) {
  const environment = (environmentId: string, label: string, endpoint: string) => ({
    environmentId,
    label,
    routes: [{ type: 'remote', endpoint, priority: 0, health: { status: 'unknown' } }],
    credential: `${environmentId}-token`,
  })
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      selectedId,
      environments: [
        environment('env-a', 'Desk', A),
        { ...environment('env-b', 'Laptop', B), ...extra },
      ],
    }),
  )
}

/** Answers for each environment that is up; the rest cannot be reached. */
function answering(up: { a?: boolean; b?: boolean } = { a: true, b: true }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const isB = String(input).startsWith(B)
      if (!(isB ? up.b : up.a)) throw new TypeError('Failed to fetch')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          environmentId: isB ? 'env-b' : 'env-a',
          label: isB ? 'Laptop' : 'Desk',
          capabilities: ['connection.heartbeat'],
        }),
      }
    }),
  )
}

/** Idle until dialled. A `cached` one already knows its environment. */
function fakeClient(
  environmentId: string,
  { cached = false, state: given = {} }: { cached?: boolean; state?: Partial<EnvironmentState> },
) {
  const listeners = new Set<() => void>()
  let state: EnvironmentState = {
    ...createInitialState(),
    ...(cached ? { environment: { environmentId, name: environmentId } } : {}),
    ...given,
  }
  const tell = () => {
    for (const listener of [...listeners]) listener()
  }
  const change = (next: Partial<EnvironmentState>) => {
    state = { ...state, ...next }
    tell()
  }
  const client = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commands: {
      openSession: vi.fn<() => Promise<void>>(async () => {
        throw new EnvironmentClientError('not_found', 'Session not found.')
      }),
    },
    drafts: undefined,
    supports: () => false,
    setActiveSession: vi.fn(),
    setActiveThread: vi.fn(),
    connect: () =>
      change({
        environment: { environmentId, name: environmentId },
        connection: { ...state.connection, phase: 'connected' },
      }),
    disconnect: vi.fn(),
    dispose: vi.fn(),
    change,
  }
  return client
}

type Fake = ReturnType<typeof fakeClient>

function has(sessionId: string) {
  return { sessions: { [sessionId]: { sessionId } } } as unknown as Partial<EnvironmentState>
}

function Probe({ address }: { address: Address }) {
  const [current, setCurrent] = useState<Address | null>(address)
  const memoized = useMemo(() => current, [current])
  const lookup = useFindAddress(memoized)
  const { selectedId, selectEnvironment } = useConnection()
  return (
    <>
      <p>owner: {lookup.owner ?? 'none'}</p>
      <p>status: {lookup.status}</p>
      <p>offline: {lookup.offline.join(', ')}</p>
      <p>selected: {selectedId ?? 'none'}</p>
      <button type="button" onClick={() => address.id && lookup.reportAbsent(address.id)}>
        report absent
      </button>
      <button type="button" onClick={() => selectEnvironment('env-a')}>
        pick a
      </button>
      <button type="button" onClick={() => setCurrent(null)}>
        leave
      </button>
      <button type="button" onClick={() => setCurrent(address)}>
        come back
      </button>
    </>
  )
}

function renderLookup(address: Address, clients: { a: Fake; b: Fake }) {
  const createClient = (options: WebSocketEnvironmentClientOptions) =>
    (options.environmentId === 'env-b' ? clients.b : clients.a) as unknown as EnvironmentClient
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ConnectionProvider retryDelaysMs={[60_000]}>
        <WebEnvironmentClientProvider createClient={createClient as never}>
          <Probe address={address} />
        </WebEnvironmentClientProvider>
      </ConnectionProvider>
    </QueryClientProvider>,
  )
}

const shows = (text: string) =>
  waitFor(() => expect(screen.getByText(text)).toBeInTheDocument())
const click = (name: string) => act(() => screen.getByRole('button', { name }).click())
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

describe('addressOf', () => {
  it('reads what a session or draft address names, and nothing else', () => {
    expect(addressOf('/sessions/a%20b')).toEqual({ kind: 'session', id: 'a b' })
    expect(addressOf('/drafts/d')).toEqual({ kind: 'draft', id: 'd' })
    expect(addressOf('/')).toBeNull()
    expect(addressOf('/settings')).toBeNull()
    expect(addressOf('/sessions/')).toBeNull()
    expect(addressOf('/sessions/a/b')).toBeNull()
    expect(addressOf('/sessions/%')).toBeNull()
  })
})

describe('finding the environment of an address', () => {
  it('stays in the selected environment when it has the session, asking nobody', async () => {
    // Not the first saved, so it is the selection that decides.
    seed('env-b')
    answering()
    const clients = {
      a: fakeClient('env-a', { state: has('session-1') }),
      b: fakeClient('env-b', { state: has('session-1') }),
    }
    renderLookup(SESSION, clients)

    await shows('status: settled')
    await settle()
    expect(screen.getByText('selected: env-b')).toBeInTheDocument()
    expect(clients.a.commands.openSession).not.toHaveBeenCalled()
    expect(clients.b.commands.openSession).not.toHaveBeenCalled()
  })

  it('moves the selection to the environment that has it loaded, asking nobody', async () => {
    seed()
    answering()
    const clients = { a: fakeClient('env-a', {}), b: fakeClient('env-b', { state: has('session-1') }) }
    renderLookup(SESSION, clients)

    await shows('selected: env-b')
    await settle()
    expect(screen.getByText('owner: none')).toBeInTheDocument()
    expect(clients.a.commands.openSession).not.toHaveBeenCalled()
    expect(clients.b.commands.openSession).not.toHaveBeenCalled()
    const saved = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as {
      selectedId: string
    }
    expect(saved.selectedId).toBe('env-b')
  })

  it('finds it in the cache of an environment that cannot be reached', async () => {
    seed()
    answering({ a: true })
    renderLookup(SESSION, {
      a: fakeClient('env-a', {}),
      b: fakeClient('env-b', { cached: true, state: has('session-1') }),
    })

    await shows('selected: env-b')
  })

  it('finds it with no selection at all', async () => {
    seed(null)
    answering()
    renderLookup(SESSION, {
      a: fakeClient('env-a', {}),
      b: fakeClient('env-b', { state: has('session-1') }),
    })

    await shows('selected: env-b')
  })

  it('leaves what the selected environment is creating alone until it has said no', async () => {
    seed()
    answering()
    const clients = { a: fakeClient('env-a', {}), b: fakeClient('env-b', {}) }
    renderLookup(SESSION, clients)
    await shows('status: searching')
    await settle()
    expect(clients.b.commands.openSession).not.toHaveBeenCalled()

    click('report absent')
    await waitFor(() => expect(clients.b.commands.openSession).toHaveBeenCalledWith('session-1'))
  })

  it('asks the others past what is loaded, and follows the one that has it', async () => {
    seed()
    answering()
    const clients = { a: fakeClient('env-a', {}), b: fakeClient('env-b', {}) }
    clients.b.commands.openSession.mockImplementation(async () => {
      clients.b.change(has('session-1'))
    })
    renderLookup(SESSION, clients)
    await shows('status: searching')

    click('report absent')
    await shows('selected: env-b')
  })

  it('asks the others straight away when the selected environment cannot say', async () => {
    seed()
    answering({ b: true })
    const clients = {
      a: fakeClient('env-a', { cached: true }),
      b: fakeClient('env-b', {}),
    }
    renderLookup(SESSION, clients)

    await waitFor(() => expect(clients.b.commands.openSession).toHaveBeenCalledWith('session-1'))
  })

  it('says nobody has it once everybody has said so', async () => {
    seed()
    answering()
    renderLookup(SESSION, { a: fakeClient('env-a', {}), b: fakeClient('env-b', {}) })
    await shows('status: searching')

    click('report absent')
    await shows('status: absent')
  })

  it('names who cannot say, rather than saying nobody has it', async () => {
    seed()
    answering({ a: true })
    renderLookup(SESSION, { a: fakeClient('env-a', {}), b: fakeClient('env-b', {}) })
    await shows('status: searching')

    click('report absent')
    await shows('status: offline')
    expect(screen.getByText('offline: Laptop')).toBeInTheDocument()
  })

  it('does not call an environment offline that is still connecting', async () => {
    seed()
    answering()
    const clients = { a: fakeClient('env-a', {}), b: fakeClient('env-b', {}) }
    // Its route has answered, and its socket has yet to get through.
    clients.b.connect = () => undefined
    renderLookup(SESSION, clients)
    await shows('status: searching')

    click('report absent')
    await settle()
    expect(screen.getByText('status: searching')).toBeInTheDocument()
  })

  it('looks past an environment that refused the token, whose cache is hidden', async () => {
    seed('env-a', { tokenRefused: true })
    answering({ a: true })
    renderLookup(SESSION, {
      a: fakeClient('env-a', {}),
      b: fakeClient('env-b', { cached: true, state: has('session-1') }),
    })
    await shows('status: searching')

    click('report absent')
    await shows('status: offline')
    expect(screen.getByText('selected: env-a')).toBeInTheDocument()
  })

  it('asks again when the socket went down before answering', async () => {
    seed()
    answering({ a: true, b: true })
    const clients = { a: fakeClient('env-a', {}), b: fakeClient('env-b', {}) }
    clients.b.commands.openSession.mockImplementationOnce(async () => {
      clients.b.change({ connection: { ...clients.b.getState().connection, phase: 'reconnecting' } })
      throw new EnvironmentClientError('unavailable', 'Not connected to the environment.')
    })
    renderLookup(SESSION, clients)
    await shows('status: searching')
    click('report absent')
    await waitFor(() => expect(clients.b.commands.openSession).toHaveBeenCalledTimes(1))

    act(() => clients.b.connect())
    await waitFor(() => expect(clients.b.commands.openSession).toHaveBeenCalledTimes(2))
    await shows('status: absent')
  })

  it('leaves a session it asked for unselected when nobody is looking any more', async () => {
    seed()
    answering()
    const clients = { a: fakeClient('env-a', {}), b: fakeClient('env-b', {}) }
    let answer = (): void => undefined
    clients.b.commands.openSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answer = () => {
            clients.b.change({ activeSessionId: 'session-1' })
            resolve()
          }
        }),
    )
    renderLookup(SESSION, clients)
    await shows('status: searching')
    click('report absent')
    await waitFor(() => expect(clients.b.commands.openSession).toHaveBeenCalled())

    click('leave')
    await act(async () => answer())

    await waitFor(() => expect(clients.b.setActiveSession).toHaveBeenCalledWith(null))
  })

  it('does not pull someone back who chose another environment on the address', async () => {
    seed()
    answering()
    renderLookup(SESSION, {
      a: fakeClient('env-a', {}),
      b: fakeClient('env-b', { state: has('session-1') }),
    })
    await shows('selected: env-b')

    click('pick a')
    await shows('selected: env-a')
    await settle()
    expect(screen.getByText('selected: env-a')).toBeInTheDocument()

    // And there, only that environment's word counts.
    click('report absent')
    await shows('status: absent')
  })

  it('follows the address again on coming back to it', async () => {
    seed()
    answering()
    renderLookup(SESSION, {
      a: fakeClient('env-a', {}),
      b: fakeClient('env-b', { state: has('session-1') }),
    })
    await shows('selected: env-b')
    click('leave')
    click('pick a')
    await shows('selected: env-a')

    click('come back')
    await shows('selected: env-b')
  })
})

describe('finding the environment of a draft', () => {
  const holding = (draftId: string) =>
    ({
      drafts: { [draftId]: { target: { type: 'new_session', sessionId: 's', workspaceId: 'w' } } },
    }) as unknown as Partial<EnvironmentState>

  it('follows the environment that has it', async () => {
    seed()
    answering()
    renderLookup(DRAFT, {
      a: fakeClient('env-a', { state: { draftsListed: true } }),
      b: fakeClient('env-b', { state: { ...holding('draft-1'), draftsListed: true } }),
    })

    await shows('selected: env-b')
  })

  it('waits for an environment that has not listed its drafts yet', async () => {
    seed()
    answering()
    const clients = {
      a: fakeClient('env-a', { state: { draftsListed: true } }),
      b: fakeClient('env-b', {}),
    }
    renderLookup(DRAFT, clients)
    await settle()
    await shows('status: searching')

    act(() => clients.b.change({ ...holding('draft-1'), draftsListed: true }))
    await shows('selected: env-b')
  })

  it('asks no environment for a draft, and leaves one nobody has to its page', async () => {
    seed()
    answering({ a: true })
    const clients = {
      a: fakeClient('env-a', { state: { draftsListed: true } }),
      b: fakeClient('env-b', {}),
    }
    renderLookup(DRAFT, clients)

    await shows('status: absent')
    expect(screen.getByText('selected: env-a')).toBeInTheDocument()
    expect(clients.a.commands.openSession).not.toHaveBeenCalled()
  })
})
