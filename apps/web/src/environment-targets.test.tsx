import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  type AuthorizedClient,
  type MockEnvironmentClient,
  type MockSeed,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from './lib/environment-store'
import { idleUntilDialled, renderWebApp } from './test-utils'

const DESK = 'http://127.0.0.1:43120'
const LAPTOP = 'http://127.0.0.1:43121'

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static created: FakeNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.created.push(this)
  }
}

beforeEach(() => {
  FakeNotification.created = []
  vi.stubGlobal('Notification', FakeNotification)
  vi.spyOn(window, 'focus').mockImplementation(() => undefined)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function seedRegistry(saved: 'both' | 'desk' = 'both') {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId: 'env-desk',
      environments: [
        { environmentId: 'env-desk', label: 'Desk', endpoints: [DESK], credential: '' },
        ...(saved === 'both'
          ? [{ environmentId: 'env-laptop', label: 'Laptop', endpoints: [LAPTOP], credential: '' }]
          : []),
      ],
    }),
  )
}

function answering(label?: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const onLaptop = String(input).startsWith(LAPTOP)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: ['connection.heartbeat'],
          environmentId: onLaptop ? 'env-laptop' : 'env-desk',
          label: label ?? (onLaptop ? 'Laptop' : 'Desk'),
        }),
      }
    }),
  )
}

const device = (clientId: string, label: string, kind: AuthorizedClient['kind']) =>
  ({
    clientId,
    label,
    kind,
    capabilities: ['read', 'operate', 'agent', 'terminal', 'admin'],
    createdAt: '2026-10-01T10:00:00.000Z',
    lastSeenAt: null,
    expiresAt: '2099-11-01T10:00:00.000Z',
    connected: false,
  }) satisfies AuthorizedClient

function seedOf(environmentId: string, title: string, sessionId: string, phone: string): MockSeed {
  const workspaceId = `/${environmentId}`
  return {
    environment: { environmentId, name: environmentId },
    workspaces: [
      {
        workspaceId,
        name: environmentId,
        path: workspaceId,
        lastUsedAt: null,
        lastActivityAt: null,
        exists: true,
        capabilities: { git: false },
      },
    ],
    sessions: [
      {
        session: { sessionId, workspaceId, title },
        threads: [{ threadId: `${environmentId}-thread`, sessionId }],
        turns: [{ turnId: 't', threadId: `${environmentId}-thread`, state: 'completed' }],
        messages: [
          {
            messageId: 'm',
            threadId: `${environmentId}-thread`,
            turnId: 't',
            role: 'assistant',
            content: [{ type: 'text', text: `Written on ${environmentId}` }],
          },
        ],
      },
    ],
    authorizedClients: [device('owner', 'Owner', 'owner'), device('phone', phone, 'paired')],
    currentClientId: 'owner',
    environmentSettings: { addProjectStartsIn: `/starts-on-${environmentId}` },
  }
}

const mock = (seed: MockSeed) => createMockEnvironmentClient({ seed, respond: () => null })

function renderBoth(path: string, desk: MockEnvironmentClient, laptop: MockEnvironmentClient) {
  const create = (options: WebSocketEnvironmentClientOptions) =>
    idleUntilDialled(options.environmentId === 'env-laptop' ? laptop : desk)
  return renderWebApp(path, { createEnvironmentClient: create as never })
}

const twoEnvironments = (sessionId?: string) => ({
  desk: mock(seedOf('env-desk', 'Desk chat', sessionId ?? 'desk-session', 'Desk phone')),
  laptop: mock(seedOf('env-laptop', 'Laptop chat', sessionId ?? 'laptop-session', 'Laptop phone')),
})

const selected = () =>
  (JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as { selectedId: string }).selectedId

const connected = (client: MockEnvironmentClient) =>
  waitFor(() => expect(client.getState().connection.phase).toBe('connected'))

/** Runs a turn to its end, as a session finishing elsewhere does. */
async function finishTurn(client: MockEnvironmentClient, sessionId: string, threadId: string) {
  const target = { sessionId, threadId }
  const { turn } = await act(() => client.commands.sendTurn({ ...target, text: 'Go on' }))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  act(() => client.completeTurn({ ...target, turnId: turn.turnId }))
}

describe('notifications across environments', () => {
  it('tells of a session in an environment that is not open, and opens it there', async () => {
    seedRegistry()
    answering()
    const { desk, laptop } = twoEnvironments()
    const { router } = renderBoth('/', desk, laptop)
    await screen.findAllByText('Laptop chat')
    await connected(laptop)

    await finishTurn(laptop, 'laptop-session', 'env-laptop-thread')

    await waitFor(() => expect(FakeNotification.created).toHaveLength(1))
    const notice = FakeNotification.created[0]!
    expect(notice.title).toBe('Laptop chat')
    expect(notice.options).toMatchObject({
      body: 'Finished · Laptop',
      tag: 'env-laptop/laptop-session',
    })
    expect(selected()).toBe('env-desk')

    act(() => notice.onclick?.())
    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions/laptop-session'))
    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
    await waitFor(() => expect(selected()).toBe('env-laptop'))
  })

  it('opens the right one of two sessions with the same id', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    seedRegistry()
    answering()
    const { desk, laptop } = twoEnvironments('shared')
    renderBoth('/sessions/shared', desk, laptop)
    expect(await screen.findByText('Written on env-desk')).toBeInTheDocument()
    await connected(laptop)

    // Same id as the one on screen, in the environment that is not.
    await finishTurn(laptop, 'shared', 'env-laptop-thread')
    await waitFor(() => expect(FakeNotification.created).toHaveLength(1))
    expect(FakeNotification.created[0]!.options.tag).toBe('env-laptop/shared')

    act(() => FakeNotification.created[0]!.onclick?.())
    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
    await waitFor(() => expect(selected()).toBe('env-laptop'))
  })

  it('stays quiet for the session on screen, and not for one left behind Settings', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    seedRegistry()
    answering()
    const { desk, laptop } = twoEnvironments()
    const { router } = renderBoth('/sessions/desk-session', desk, laptop)
    expect(await screen.findByText('Written on env-desk')).toBeInTheDocument()
    await connected(desk)

    await finishTurn(desk, 'desk-session', 'env-desk-thread')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(FakeNotification.created).toHaveLength(0)

    await act(() => router.navigate({ to: '/settings' }))
    await finishTurn(desk, 'desk-session', 'env-desk-thread')
    await waitFor(() => expect(FakeNotification.created).toHaveLength(1))
  })

  it('keeps watching across a move between environments', async () => {
    seedRegistry()
    answering()
    const { desk, laptop } = twoEnvironments()
    const { router } = renderBoth('/', desk, laptop)
    await screen.findAllByText('Laptop chat')
    await connected(desk)
    await act(() =>
      desk.commands.sendTurn({
        sessionId: 'desk-session',
        threadId: 'env-desk-thread',
        text: 'Go on',
      }),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    await act(() =>
      router.navigate({ to: '/sessions/$sessionId', params: { sessionId: 'laptop-session' } }),
    )
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    const [turn] = desk.getState().threads['env-desk-thread']!.turns.slice(-1)
    act(() =>
      desk.completeTurn({
        sessionId: 'desk-session',
        threadId: 'env-desk-thread',
        turnId: turn!.turnId,
      }),
    )

    await waitFor(() => expect(FakeNotification.created).toHaveLength(1))
    expect(FakeNotification.created[0]!.options.tag).toBe('env-desk/desk-session')
  })
})

