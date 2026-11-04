import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  type MockSeed,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import type { SidebarDataValue } from '@openmanager/app-core/providers/sidebar-provider'
import { ENVIRONMENT_STORAGE_KEY } from '@openmanager/environment-client/connection'
import { idleUntilDialled, renderWebApp } from './test-utils'

const { sidebar } = vi.hoisted(() => ({ sidebar: { data: null as SidebarDataValue | null } }))

vi.mock('./components/session-notifications', () => ({ EnvironmentNotifications: () => null }))

vi.mock('@openmanager/app-core/components/sidebar/WorkspaceSidebar', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@openmanager/app-core/components/sidebar/WorkspaceSidebar')
    >()
  const { useSidebarData } = await import('@openmanager/app-core/providers/sidebar-provider')
  return {
    ...actual,
    WorkspaceSidebar: (props: Parameters<typeof actual.WorkspaceSidebar>[0]) => {
      sidebar.data = useSidebarData()
      return <actual.WorkspaceSidebar {...props} />
    },
  }
})

const DESK = 'http://127.0.0.1:43120'
const LAPTOP = 'http://127.0.0.1:43121'
const REFUSED = { phase: 'closed', failure: { code: 'auth', message: 'Token revoked.' } } as const

afterEach(() => {
  // Lets go of the guard a discard leaves on its spot, which outlives the test.
  fireEvent.pointerMove(window, { clientX: 999, clientY: 999 })
  cleanup()
  sidebar.data = null
  localStorage.clear()
  vi.unstubAllGlobals()
})

function saved(...ids: ('desk' | 'laptop')[]) {
  const entry = (id: 'desk' | 'laptop') => ({
    environmentId: `env-${id}`,
    label: id === 'desk' ? 'Desk' : 'Laptop',
    endpoints: [id === 'desk' ? DESK : LAPTOP],
    credential: 'token',
  })
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId: `env-${ids[0]}`,
      environments: ids.map(entry),
    }),
  )
}

function answering({ desk = true, laptop = true }: { desk?: boolean; laptop?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const onLaptop = String(input).startsWith(LAPTOP)
      if (!(onLaptop ? laptop : desk)) throw new TypeError('Failed to fetch')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: ['connection.heartbeat'],
          environmentId: onLaptop ? 'env-laptop' : 'env-desk',
          label: onLaptop ? 'Laptop' : 'Desk',
        }),
      }
    }),
  )
}

function seedOf(
  environmentId: string,
  name: string,
  title: string,
  extra: { status?: SessionStatus; unrecoverable?: boolean } = {},
): MockSeed {
  const workspaceId = `/${name}`
  return {
    environment: { environmentId, name: environmentId },
    workspaces: [
      {
        workspaceId,
        name,
        path: workspaceId,
        lastUsedAt: null,
        lastActivityAt: null,
        exists: true,
        capabilities: { git: false },
      },
    ],
    ...(extra.unrecoverable ? { unrecoverableSessions: [`${environmentId}-session`] } : {}),
    sessions: [
      {
        ...(extra.status ? { status: extra.status } : {}),
        session: {
          sessionId: `${environmentId}-session`,
          workspaceId,
          title,
        },
        threads: [{ threadId: `${environmentId}-thread`, sessionId: `${environmentId}-session` }],
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
  } as MockSeed
}

type Mock = ReturnType<typeof createMockEnvironmentClient>
type SessionStatus = NonNullable<NonNullable<MockSeed['sessions']>[number]['status']>

const deskMock = (extra?: Parameters<typeof seedOf>[3]) =>
  createMockEnvironmentClient({ seed: seedOf('env-desk', 'desk-project', 'Desk chat', extra) })
const laptopMock = (extra?: Parameters<typeof seedOf>[3]) =>
  createMockEnvironmentClient({
    seed: seedOf('env-laptop', 'laptop-project', 'Laptop chat', extra),
  })

function renderApp(
  path: string,
  {
    cached = [],
    desk = deskMock(),
    laptop = laptopMock(),
  }: { cached?: ('desk' | 'laptop')[]; desk?: Mock; laptop?: Mock } = {},
) {
  const create = (options: WebSocketEnvironmentClientOptions) => {
    const onLaptop = options.environmentId === 'env-laptop'
    return idleUntilDialled(onLaptop ? laptop : desk, undefined, {
      cached: cached.includes(onLaptop ? 'laptop' : 'desk'),
    })
  }
  return renderWebApp(path, { createEnvironmentClient: create as never })
}

const selected = () =>
  (JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as { selectedId: string }).selectedId

async function cardOf(title: string | RegExp) {
  const button = await screen.findByRole('button', { name: title })
  return { button, card: within(button.closest<HTMLElement>('.group\\/card')!) }
}

const connected = (client: Mock) =>
  waitFor(() => expect(client.getState().connection.phase).toBe('connected'))

async function saveDraftOn(client: Mock, text: string, workspaceId = '/laptop-project') {
  await client.commands.saveDraft({
    draftId: 'waiting-draft',
    baseRevision: 0,
    target: { type: 'new_session', sessionId: 'next', workspaceId },
    content: { text },
  })
}

/** Laptop answers at first, so its chat is really open, then stops once told. */
function answeringUntil() {
  const laptop = { up: true }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const onLaptop = String(input).startsWith(LAPTOP)
      if (onLaptop && !laptop.up) throw new TypeError('Failed to fetch')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: ['connection.heartbeat'],
          environmentId: onLaptop ? 'env-laptop' : 'env-desk',
          label: onLaptop ? 'Laptop' : 'Desk',
        }),
      }
    }),
  )
  return laptop
}

const HELD = "Can't send until Laptop is back. What you type here is kept."

describe('the selected environment has no client', () => {
  it("keeps the other environments' cards, in the same sidebar, on a refused token", async () => {
    saved('desk', 'laptop')
    answering()
    const user = userEvent.setup()
    const desk = deskMock()
    const laptop = laptopMock()
    renderApp('/', { desk, laptop })
    await cardOf(/Desk chat/)
    const { button } = await cardOf(/Laptop chat/)
    await connected(desk)

    act(() => desk.setConnection(REFUSED))

    // Its own cards are gone with its cache; the other's stay where they were.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Desk chat/ })).toBeNull())
    expect(screen.getByRole('button', { name: /Laptop chat/ })).toBe(button)
    // A banner saying who it's about, and no full-screen block.
    expect(screen.queryByRole('heading', { name: 'Not authorized' })).toBeNull()
    expect(await screen.findByText('Not authorized · Desk')).toBeInTheDocument()

    await user.click(button)
    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(screen.getByRole('button', { name: /Laptop chat/ })).toBe(button)
    expect(await screen.findByText('Desk refused this device')).toBeInTheDocument()
    // Reading another environment asks nothing of the one that refused.
    expect(screen.queryByRole('button', { name: /Desk chat/ })).toBeNull()
  })

  it("goes through the row's own environment, with nothing open to fall back on", async () => {
    saved('desk', 'laptop')
    answering()
    const desk = deskMock()
    const laptop = laptopMock()
    const deskRename = vi.spyOn(desk.commands, 'renameSession')
    renderApp('/', { desk, laptop })
    await cardOf(/Laptop chat/)
    await connected(desk)
    await connected(laptop)

    act(() => desk.setConnection(REFUSED))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Desk chat/ })).toBeNull())

    expect(sidebar.data!.activeEnvironmentId).toBeUndefined()
    // New agent hands over to a reachable environment's project (#278).
    expect(screen.getByRole('button', { name: 'New agent' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Add project' })).toBeDisabled()
    await act(async () => {
      await sidebar.data!.renameSession!(
        '/laptop-project',
        'env-laptop-session',
        'Moved',
        'env-laptop',
      )
    })
    expect(laptop.getState().sessions['env-laptop-session']?.title).toBe('Moved')
    expect(deskRename).not.toHaveBeenCalled()
  })

  it('lists the others when it is offline with nothing kept', async () => {
    saved('desk', 'laptop')
    answering({ desk: false })
    const user = userEvent.setup()
    renderApp('/')

    const { button } = await cardOf(/Laptop chat/)
    expect(await screen.findByText("Can't reach Desk")).toBeInTheDocument()
    expect(screen.getByText('Open a session from the sidebar.')).toBeInTheDocument()

    await user.click(button)
    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
    expect(await screen.findByText('Desk is offline')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText("Can't reach Desk")).toBeNull())
  })

  it('keeps a waiting discard, with its undo, through losing the open environment', async () => {
    saved('desk', 'laptop')
    answering()
    const user = userEvent.setup()
    const desk = deskMock()
    const laptop = laptopMock()
    await saveDraftOn(laptop, 'Typed on the laptop')
    const discard = vi.spyOn(laptop.commands, 'deleteDraft')
    renderApp('/', { desk, laptop })
    await connected(desk)
    await connected(laptop)

    const { card } = await cardOf(/Typed on the laptop/)
    await user.click(await card.findByRole('button', { name: 'Discard draft' }))

    act(() => desk.setConnection(REFUSED))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Desk chat/ })).toBeNull())

    expect(discard).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('button', { name: /Typed on the laptop/ })).toBeInTheDocument()
    expect(discard).not.toHaveBeenCalled()
    expect(laptop.getState().drafts['waiting-draft']).toBeDefined()
  })
})

describe('another environment is down', () => {
  it('names it in a small notice and marks its cards, with no banner', async () => {
    saved('desk', 'laptop')
    answering({ laptop: false })
    renderApp('/', { cached: ['laptop'] })

    expect(await screen.findByText('Laptop is offline')).toBeInTheDocument()
    const { card } = await cardOf(/Laptop chat/)
    expect(card.getByText('· offline')).toBeInTheDocument()
    expect((await cardOf(/Desk chat/)).card.queryByText('· offline')).toBeNull()
    expect(screen.queryByText("Can't reach Laptop")).toBeNull()
    expect(screen.queryByText("Can't reach Desk")).toBeNull()
  })

  it('does not show a cached card as live', async () => {
    saved('desk', 'laptop')
    answering({ laptop: false })
    renderApp('/', { cached: ['laptop'], laptop: laptopMock({ status: 'running' }) })

    await screen.findByText('Laptop is offline')
    const { card } = await cardOf(/Laptop chat/)
    expect(card.queryByText('Working')).toBeNull()
  })

  it('shows a live card as live', async () => {
    saved('desk', 'laptop')
    answering()
    renderApp('/', { laptop: laptopMock({ status: 'running' }) })

    const { card } = await cardOf(/Laptop chat/)
    expect(await card.findByText('Working')).toBeInTheDocument()
    expect(card.queryByText('· offline')).toBeNull()
  })

  it('leaves the open environment usable', async () => {
    saved('desk', 'laptop')
    answering({ laptop: false })
    const user = userEvent.setup()
    const desk = deskMock()
    const sent = vi.spyOn(desk.commands, 'sendTurn')
    renderApp('/sessions/env-desk-session', { cached: ['laptop'], desk })
    await screen.findByText('Laptop is offline')
    await connected(desk)

    await user.click(await screen.findByRole('textbox'))
    await user.keyboard('Still here{Enter}')
    await waitFor(() => expect(sent).toHaveBeenCalled())
  })

  it('says a refused environment needs someone, and hides what it left here', async () => {
    saved('desk', 'laptop')
    answering()
    const stored = JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!)
    stored.environments[1].tokenRefused = true
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, JSON.stringify(stored))
    const user = userEvent.setup()
    const { router } = renderApp('/', { cached: ['laptop'] })

    // The page mounts again once Desk's client is in, so find the notice after it.
    await cardOf(/Desk chat/)
    expect(await screen.findByText('Laptop refused this device')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Laptop chat/ })).toBeNull()
    const notice = screen
      .getByText('Laptop refused this device')
      .closest<HTMLElement>('[role="status"]')!
    await user.click(within(notice).getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })
})

describe('the open environment is down', () => {
  it('opens from the cache, and holds the send saying why', async () => {
    saved('laptop', 'desk')
    answering({ laptop: false })
    const laptop = laptopMock()
    const sent = vi.spyOn(laptop.commands, 'sendTurn')
    renderApp('/sessions/env-laptop-session', { cached: ['laptop'], laptop })

    expect((await screen.findAllByText('Laptop chat')).length).toBeGreaterThan(0)
    expect(await screen.findByText("Can't reach Laptop")).toBeInTheDocument()
    const reason = "Can't send until Laptop is back. What you type here is kept."
    expect(await screen.findByText(reason)).toBeInTheDocument()

    // The chat's own composer is the real client's to show: it selects a cached
    // session as it starts to open it, which this mock's frozen idle state
    // cannot. The landing's, for a new session there, shows the same hold.
    expect(sent).not.toHaveBeenCalled()
    // The banner is about this page, so the smaller notice has nothing to add.
    expect(screen.queryByText('Laptop is offline')).toBeNull()
    expect((await cardOf(/Laptop chat/)).card.getByText('· offline')).toBeInTheDocument()
  })

  it('names the environment on a failure on its page', async () => {
    saved('laptop', 'desk')
    answering()
    renderApp('/sessions/env-laptop-session', { laptop: laptopMock({ unrecoverable: true }) })

    expect(await screen.findByText(/^Laptop: /)).toBeInTheDocument()
  })
})

describe('typing while the open environment is down', () => {
  it('keeps the text, and sends nothing, on Enter', async () => {
    saved('laptop', 'desk')
    // Up at first, so the chat is really open; then it stops answering.
    let laptopUp = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const onLaptop = String(input).startsWith(LAPTOP)
        if (onLaptop && !laptopUp) throw new TypeError('Failed to fetch')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: ['connection.heartbeat'],
            environmentId: onLaptop ? 'env-laptop' : 'env-desk',
            label: onLaptop ? 'Laptop' : 'Desk',
          }),
        }
      }),
    )
    const user = userEvent.setup()
    const laptop = laptopMock()
    const sent = vi.spyOn(laptop.commands, 'sendTurn')
    renderApp('/sessions/env-laptop-session', { laptop })
    await screen.findByText('Written on env-laptop')
    await connected(laptop)

    laptopUp = false
    // As the socket says when it drops.
    act(() =>
      laptop.setConnection({
        phase: 'reconnecting',
        failure: { code: 'unavailable', message: 'Connection closed.' },
      }),
    )
    const reason = "Can't send until Laptop is back. What you type here is kept."
    expect(await screen.findByText(reason, undefined, { timeout: 4000 })).toBeInTheDocument()

    const box = screen.getByRole('textbox')
    await user.click(box)
    await user.keyboard('Later')
    expect(box).toHaveValue('Later')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('textbox')).toHaveValue('Later')
    expect(sent).not.toHaveBeenCalled()
  })
})

describe('answering while the open environment is down', () => {
  it("holds a permission's choices, saying why, and sends nothing", async () => {
    saved('laptop', 'desk')
    const answers = answeringUntil()
    const user = userEvent.setup()
    const laptop = createMockEnvironmentClient({
      seed: seedOf('env-laptop', 'laptop-project', 'Laptop chat'),
      respond: () => null,
    })
    const target = { sessionId: 'env-laptop-session', threadId: 'env-laptop-thread' }
    const { turn } = await laptop.commands.sendTurn({ ...target, text: 'Run the tests' })
    laptop.requestInteraction(
      { ...target, turnId: turn.turnId },
      {
        kind: 'permission',
        interactionId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'pnpm test' },
        options: [
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        ],
      },
    )
    renderApp('/sessions/env-laptop-session', { laptop })
    const allow = await screen.findByRole('button', { name: 'Allow' })
    await connected(laptop)
    expect(allow).toBeEnabled()

    answers.up = false
    act(() =>
      laptop.setConnection({
        phase: 'reconnecting',
        failure: { code: 'unavailable', message: 'Connection closed.' },
      }),
    )
    // Under the composer, and on the card, which can be far up the chat.
    await waitFor(() => expect(screen.getAllByText(HELD)).toHaveLength(2), { timeout: 4000 })
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(laptop.calls.filter((call) => call.command === 'respondToInteraction')).toEqual([])
  })
})

describe('a row of another environment fails', () => {
  async function ready() {
    saved('desk', 'laptop')
    answering()
    const desk = deskMock()
    const laptop = laptopMock()
    renderApp('/', { desk, laptop })
    await cardOf(/Laptop chat/)
    await connected(desk)
    await connected(laptop)
    return { desk, laptop }
  }

  it('says what failed and on which environment, until it is dismissed', async () => {
    const { laptop } = await ready()
    const user = userEvent.setup()
    vi.spyOn(laptop.commands, 'renameSession').mockRejectedValue(new Error('Refused.'))
    vi.spyOn(laptop.commands, 'deleteSession').mockRejectedValue(new Error('Busy.'))

    await act(async () => {
      await sidebar.data!.renameSession!(
        '/laptop-project',
        'env-laptop-session',
        'Moved',
        'env-laptop',
      )
    })
    expect(
      await screen.findByText("Couldn't rename a session on Laptop: Refused."),
    ).toBeInTheDocument()

    await act(async () => {
      await sidebar.data!.deleteSession(
        '/laptop-project',
        'env-laptop-session',
        'opencode',
        'env-laptop',
      )
    })
    expect(
      await screen.findByText("Couldn't delete a session on Laptop: Busy."),
    ).toBeInTheDocument()
    expect(screen.queryByText(/rename a session/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/delete a session/)).toBeNull()
  })

  it('still rejects a settle, so the row moves back, and says so', async () => {
    const { laptop } = await ready()
    vi.spyOn(laptop.commands, 'settleSession').mockRejectedValue(new Error('Refused.'))

    await act(async () => {
      await expect(
        sidebar.data!.settleSession!('/laptop-project', 'env-laptop-session', true, 'env-laptop'),
      ).rejects.toThrow('Refused.')
    })
    expect(
      await screen.findByText("Couldn't settle a session on Laptop: Refused."),
    ).toBeInTheDocument()
  })

  it("says so when the open environment's own row fails too", async () => {
    const { desk } = await ready()
    vi.spyOn(desk.commands, 'deleteSession').mockRejectedValue(new Error('Busy.'))

    await act(async () => {
      await sidebar.data!.deleteSession('/desk-project', 'env-desk-session', 'opencode', 'env-desk')
    })
    expect(await screen.findByText("Couldn't delete a session on Desk: Busy.")).toBeInTheDocument()
  })

  it('sends nothing to an environment that is down, to go out once it is back', async () => {
    saved('desk', 'laptop')
    answering({ laptop: false })
    const laptop = laptopMock()
    const rename = vi.spyOn(laptop.commands, 'renameSession')
    renderApp('/', { cached: ['laptop'], laptop })
    await screen.findByText('Laptop is offline')

    await act(async () => {
      await sidebar.data!.renameSession!(
        '/laptop-project',
        'env-laptop-session',
        'Moved',
        'env-laptop',
      )
    })
    expect(
      await screen.findByText(
        "Couldn't rename a session on Laptop: it's offline. Try again once it's back.",
      ),
    ).toBeInTheDocument()
    expect(rename).not.toHaveBeenCalled()
  })

  it('refuses a settle and a pin to an environment that is down, sending neither', async () => {
    saved('desk', 'laptop')
    answering({ laptop: false })
    const laptop = laptopMock()
    const settle = vi.spyOn(laptop.commands, 'settleSession')
    const pin = vi.spyOn(laptop.commands, 'pinSession')
    renderApp('/', { cached: ['laptop'], laptop })
    await screen.findByText('Laptop is offline')
    await waitFor(() => expect(sidebar.data!.settleSession).toBeDefined())

    await act(async () => {
      await sidebar.data!.settleSession!(
        '/laptop-project',
        'env-laptop-session',
        true,
        'env-laptop',
      )
    })
    expect(
      await screen.findByText(
        "Couldn't settle a session on Laptop: it's offline. Try again once it's back.",
      ),
    ).toBeInTheDocument()
    expect(sidebar.data!.pinSession).toBeDefined()
    await act(async () => {
      await sidebar.data!.pinSession!('/laptop-project', 'env-laptop-session', true, 'env-laptop')
    })
    expect(
      await screen.findByText(
        "Couldn't pin a session on Laptop: it's offline. Try again once it's back.",
      ),
    ).toBeInTheDocument()
    expect(settle).not.toHaveBeenCalled()
    expect(pin).not.toHaveBeenCalled()
  })

  it('refuses a draft discard to an environment that is down, keeping the card', async () => {
    saved('desk', 'laptop')
    answering({ laptop: false })
    const user = userEvent.setup()
    const laptop = laptopMock()
    await saveDraftOn(laptop, 'Typed on the laptop')
    const discard = vi.spyOn(laptop.commands, 'deleteDraft')
    renderApp('/', { cached: ['laptop'], laptop })
    await screen.findByText('Laptop is offline')

    const { card } = await cardOf(/Typed on the laptop/)
    await user.click(await card.findByRole('button', { name: 'Discard draft' }))
    expect(
      await screen.findByText(
        "Couldn't discard a draft on Laptop: it's offline. Try again once it's back.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Typed on the laptop/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(discard).not.toHaveBeenCalled()
  })

  it("refuses a discard of the open environment's own draft the same way", async () => {
    saved('laptop', 'desk')
    answering({ laptop: false })
    const user = userEvent.setup()
    const laptop = laptopMock()
    await saveDraftOn(laptop, 'Typed on the laptop')
    const discard = vi.spyOn(laptop.commands, 'deleteDraft')
    renderApp('/', { cached: ['laptop'], laptop })
    await screen.findByText("Can't reach Laptop")

    const { card } = await cardOf(/Typed on the laptop/)
    await user.click(await card.findByRole('button', { name: 'Discard draft' }))
    expect(
      await screen.findByText(
        "Couldn't discard a draft on Laptop: it's offline. Try again once it's back.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Typed on the laptop/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(discard).not.toHaveBeenCalled()
  })

  it('refuses one the client cannot send yet, whatever the banner says', async () => {
    const { laptop } = await ready()
    const rename = vi.spyOn(laptop.commands, 'renameSession')
    act(() => laptop.setConnection({ phase: 'reconnecting' }))

    await act(async () => {
      await sidebar.data!.renameSession!(
        '/laptop-project',
        'env-laptop-session',
        'Moved',
        'env-laptop',
      )
    })
    expect(await screen.findByText(/^Couldn't rename a session on Laptop: it/)).toBeInTheDocument()
    expect(rename).not.toHaveBeenCalled()
  })

  it("does not ask the open environment when the row's has gone", async () => {
    const { desk, laptop } = await ready()
    const deskDelete = vi.spyOn(desk.commands, 'deleteSession')

    act(() => laptop.setConnection(REFUSED))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Laptop chat/ })).toBeNull())

    await act(async () => {
      await sidebar.data!.deleteSession(
        '/laptop-project',
        'env-desk-session',
        'opencode',
        'env-laptop',
      )
    })
    expect(
      await screen.findByText("Couldn't delete a session on Laptop: it isn't connected."),
    ).toBeInTheDocument()
    expect(deskDelete).not.toHaveBeenCalled()
  })
})

describe('with one environment saved', () => {
  it('keeps the full screen for a refused token, with no name on what it says', async () => {
    saved('desk')
    answering()
    const desk = deskMock()
    renderApp('/', { desk })
    await cardOf(/Desk chat/)
    await connected(desk)

    act(() => desk.setConnection(REFUSED))

    expect(await screen.findByRole('heading', { name: 'Not authorized' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: /Desk chat/ })).toBeNull())
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument()
  })

  it('shows the banner alone when it is down, and no marks on its cards', async () => {
    saved('desk')
    answering({ desk: false })
    renderApp('/', { cached: ['desk'] })

    expect(await screen.findByText("Can't reach Desk")).toBeInTheDocument()
    const { card } = await cardOf(/Desk chat/)
    expect(card.queryByText('· offline')).toBeNull()
    expect(screen.queryByText('Desk is offline')).toBeNull()
  })

  it('leaves the composer as it is on main when it is down', async () => {
    saved('desk')
    let deskUp = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!deskUp) throw new TypeError('Failed to fetch')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: ['connection.heartbeat'],
            environmentId: 'env-desk',
            label: 'Desk',
          }),
        }
      }),
    )
    const user = userEvent.setup()
    const desk = deskMock()
    const sent = vi.spyOn(desk.commands, 'sendTurn')
    renderApp('/sessions/env-desk-session', { desk })
    await screen.findByText('Written on env-desk')
    await connected(desk)

    deskUp = false
    act(() =>
      desk.setConnection({
        phase: 'reconnecting',
        failure: { code: 'unavailable', message: 'Connection closed.' },
      }),
    )
    expect(
      await screen.findByText("Can't reach Desk", undefined, { timeout: 4000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Can't send until/)).toBeNull()

    // As on main, the send isn't held: it goes, and the client answers it.
    await user.click(screen.getByRole('textbox'))
    await user.keyboard('Hello{Enter}')
    await waitFor(() => expect(sent).toHaveBeenCalled())
  })

  it('discards its draft as on main when it is down', async () => {
    saved('desk')
    answering({ desk: false })
    const user = userEvent.setup()
    const desk = deskMock()
    await saveDraftOn(desk, 'Typed on the desk', '/desk-project')
    renderApp('/', { cached: ['desk'], desk })
    await screen.findByText("Can't reach Desk")

    const { card } = await cardOf(/Typed on the desk/)
    await user.click(await card.findByRole('button', { name: 'Discard draft' }))
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(screen.queryByText(/^Couldn't discard/)).toBeNull()
  })

  it('says a failure as it is', async () => {
    saved('desk')
    answering()
    renderApp('/sessions/env-desk-session', { desk: deskMock({ unrecoverable: true }) })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/^Desk: /)).toBeNull()
  })
})

describe('the device offline under sockets that still read connected', () => {
  it('offers neither the picker nor New agent an environment that reads offline', async () => {
    saved('desk', 'laptop')
    answering()
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    try {
      const user = userEvent.setup()
      // Nothing to start on here, so New agent hands over to Laptop's project.
      const desk = createMockEnvironmentClient({
        seed: { environment: { environmentId: 'env-desk', name: 'env-desk' }, workspaces: [] },
      })
      const laptop = laptopMock()
      renderApp('/', { desk, laptop })
      await connected(desk)
      await connected(laptop)
      await waitFor(() => expect(screen.getByRole('button', { name: 'New agent' })).toBeEnabled())

      online.mockReturnValue(false)
      act(() => void window.dispatchEvent(new Event('offline')))
      expect(await (await cardOf(/Laptop chat/)).card.findByText('· offline')).toBeInTheDocument()
      expect(laptop.getState().connection.phase).toBe('connected')

      await waitFor(() => expect(screen.getByRole('button', { name: 'New agent' })).toBeDisabled())
      await user.click(await screen.findByRole('button', { name: /^Environment: / }))
      const menu = await screen.findByRole('dialog', { name: 'Choose an environment' })
      const row = within(menu).getByRole('option', { name: /^Laptop/ })
      expect(row).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(row)
      expect(selected()).toBe('env-desk')
    } finally {
      online.mockRestore()
    }
  })
})
