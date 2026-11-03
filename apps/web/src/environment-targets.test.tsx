import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

function answering(label?: string, { desk = true }: { desk?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const onLaptop = String(input).startsWith(LAPTOP)
      if (!onLaptop && !desk) throw new TypeError('Failed to fetch')
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

  it('still tells of another environment while the open one has no client', async () => {
    seedRegistry()
    answering(undefined, { desk: false })
    const { desk, laptop } = twoEnvironments()
    const { router } = renderBoth('/', desk, laptop)
    await connected(laptop)
    // Desk is selected, can't be reached and has nothing cached.
    expect(desk.getState().connection.phase).not.toBe('connected')

    await finishTurn(laptop, 'laptop-session', 'env-laptop-thread')
    await waitFor(() => expect(FakeNotification.created).toHaveLength(1))
    expect(FakeNotification.created[0]!.options.tag).toBe('env-laptop/laptop-session')

    act(() => FakeNotification.created[0]!.onclick?.())
    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions/laptop-session'))
    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
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

describe('settings for a chosen environment', () => {
  const choice = (name: string) => screen.findByRole('radio', { name })

  it('offers no choice with one environment, and still names it', async () => {
    seedRegistry('desk')
    answering()
    const desk = mock(seedOf('env-desk', 'Desk chat', 'desk-session', 'Desk phone'))
    renderBoth('/settings?tab=devices', desk, desk)

    await waitFor(() => expect(screen.getByText(/Who can reach Desk\./)).toBeInTheDocument())
    await connected(desk)
    expect(screen.queryByRole('radiogroup', { name: 'Applies to' })).not.toBeInTheDocument()
  })

  it('lists and revokes on the chosen environment, and the selection stays put', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const { desk, laptop } = twoEnvironments()
    const { router } = renderBoth('/settings?tab=devices', desk, laptop)

    expect(await choice('Desk')).toBeChecked()
    expect(await screen.findByText('Desk phone')).toBeInTheDocument()

    await user.click(await choice('Laptop'))

    expect(await screen.findByText('Laptop phone')).toBeInTheDocument()
    expect(screen.queryByText('Desk phone')).not.toBeInTheDocument()
    expect(screen.getByText(/Who can reach Laptop\./)).toBeInTheDocument()

    const row = screen.getByText('Laptop phone').closest('li')!
    await user.click(within(row).getByRole('button', { name: /Revoke/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('loses access to Laptop now')
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    await waitFor(() =>
      expect(laptop.calls.filter((call) => call.command === 'revokeAuthorizedClient')).toHaveLength(
        1,
      ),
    )
    expect(desk.calls.filter((call) => call.command === 'revokeAuthorizedClient')).toEqual([])
    expect(selected()).toBe('env-desk')
    expect(router.state.location.pathname).toBe('/settings')
  })

  it('keeps the choice across a tab change and acts there too', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const { desk, laptop } = twoEnvironments()
    renderBoth('/settings?tab=devices&environment=env-laptop', desk, laptop)

    expect(await choice('Laptop')).toBeChecked()
    await user.click(screen.getByRole('tab', { name: 'Environments' }))

    expect(await screen.findByText(/Where Add project opens on Laptop/)).toBeInTheDocument()
    expect(await screen.findByText('/starts-on-env-laptop')).toBeInTheDocument()
    expect(screen.queryByText('/starts-on-env-desk')).not.toBeInTheDocument()
    expect(selected()).toBe('env-desk')

    await user.click(screen.getByRole('tab', { name: 'Providers' }))
    expect(await screen.findByText(/The coding agents Laptop can run/)).toBeInTheDocument()
    expect(await choice('Laptop')).toBeChecked()
  })

  it('falls back to the selected environment when the choice is no longer saved', async () => {
    seedRegistry()
    answering()
    const { desk, laptop } = twoEnvironments()
    renderBoth('/settings?tab=devices&environment=env-gone', desk, laptop)
    expect(await choice('Desk')).toBeChecked()
  })

  it('tells two environments with one name apart', async () => {
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectedId: 'env-desk',
        environments: [
          { environmentId: 'env-desk', label: 'Clemax', endpoints: [DESK], credential: '' },
          { environmentId: 'env-laptop', label: 'Clemax', endpoints: [LAPTOP], credential: '' },
        ],
      }),
    )
    answering('Clemax')
    const { desk, laptop } = twoEnvironments()
    renderBoth('/settings?tab=devices', desk, laptop)
    await waitFor(() => expect(screen.getByRole('radio', { name: /43120/ })).toBeChecked())
    expect(screen.getByRole('radio', { name: 'Clemax (127.0.0.1:43121)' })).not.toBeChecked()
  })
})
