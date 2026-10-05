import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockEnvironmentClient, type MockSeed } from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from '../lib/environment-store'
import { renderWebApp } from '../test-utils'

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  exists: true,
  capabilities: { git: false, providers: [] },
}
const SESSION = {
  sessionId: 'session-1',
  workspaceId: WORKSPACE.workspaceId,
  title: 'Sidebar move',
}
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

const SEED: MockSeed = {
  environment: { environmentId: 'env-local', name: 'Local environment' },
  workspaces: [WORKSPACE],
  sessions: [
    {
      session: SESSION,
      threads: [THREAD],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
      messages: [
        {
          messageId: 'user-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'user',
          content: [{ type: 'text', text: 'Where does the sidebar live now?' }],
        },
        {
          messageId: 'assistant-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'In the shared application package.' }],
        },
      ],
    },
  ],
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function connectedEnvironment() {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Local environment',
          endpoints: ['http://127.0.0.1:43120'],
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
        capabilities: ['connection.heartbeat'],
        environmentId: 'env-local',
        label: 'Local environment',
      }),
    })),
  )
}

/** The session list; the topbar trail repeats the open session's title. It
 *  mounts once the environment connects. */
const sidebar = () => {
  const content = document.querySelector<HTMLElement>('[data-sidebar="content"]')
  if (!content) throw new Error('The sidebar has not mounted yet.')
  return content
}
/** Re-queries the sidebar on each try: the disconnected shell has its own,
 *  which the connected one replaces. */
const findInSidebar = (text: string) => waitFor(() => within(sidebar()).getByText(text))

function renderConnected(path: string, seed: MockSeed = SEED) {
  connectedEnvironment()
  const client = createMockEnvironmentClient({ seed })
  const result = renderWebApp(path, { createEnvironmentClient: () => client })
  return { ...result, client }
}

describe('session workspace', () => {
  // The rows no longer offer rename or delete; the commands stay on the
  // client, and the sidebar has to follow them wherever they come from.
  it('reflects a session renamed and deleted through the client', async () => {
    const { client } = renderConnected('/')
    expect(await findInSidebar('Sidebar move')).toBeInTheDocument()
    await act(() => client.commands.renameSession(SESSION.sessionId, 'Renamed in web'))
    expect(await within(sidebar()).findByText('Renamed in web')).toBeInTheDocument()
    expect(within(sidebar()).queryByText('Sidebar move')).not.toBeInTheDocument()
    expect(client.getState().sessions[SESSION.sessionId]?.title).toBe('Renamed in web')
    await act(() => client.commands.deleteSession(SESSION.sessionId))
    await waitFor(() => expect(client.getState().sessions[SESSION.sessionId]).toBeUndefined())
    // The card folds away rather than vanishing.
    await waitFor(() =>
      expect(within(sidebar()).queryByText('Renamed in web')).not.toBeInTheDocument(),
    )
  })

  it('opens persisted failed history from its URL without changing identity or status', async () => {
    const { client } = renderConnected('/sessions/session-1', {
      ...SEED,
      sessions: [
        {
          ...SEED.sessions![0]!,
          status: 'error',
          turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'failed' }],
        },
      ],
    })
    expect(await screen.findByText('In the shared application package.')).toBeInTheDocument()
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('error')
    expect(client.getState().sessionOrder).toEqual([SESSION.sessionId])
  })

  it.each(['missing', 'inaccessible'] as const)(
    'keeps %s sessions visible and recovers on retry',
    async (availability) => {
      const user = userEvent.setup()
      const { client } = renderConnected('/sessions/session-1', {
        ...SEED,
        workspaces: [{ ...WORKSPACE, exists: false, availability }],
      })
      expect(await screen.findByRole('alert')).toHaveTextContent('Project folder unavailable')
      expect(within(sidebar()).getByText('Sidebar move')).toBeInTheDocument()
      // The badge names the cause, since the two need different fixes.
      expect(
        screen.getByText(availability === 'missing' ? 'MISSING' : 'NO ACCESS'),
      ).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent(
        availability === 'missing' ? 'missing or was moved' : 'Permission denied',
      )
      // The card stays listed, dimmed, without claiming a lifecycle status
      // the environment never reported.
      const card = within(sidebar()).getByText('Sidebar move').closest('button')!
      expect(card).toHaveClass('opacity-70')
      expect(client.getState().sessions[SESSION.sessionId]?.status).not.toBe('error')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      // The filesystem becomes usable again and the environment publishes it.
      client.emit({
        type: 'event',
        name: 'workspace.updated',
        eventId: 'restored',
        timestamp: new Date().toISOString(),
        scope: { type: 'environment', environmentId: 'env-local' },
        payload: { workspace: { ...WORKSPACE, availability: 'available' } },
      })
      await user.click(screen.getByRole('button', { name: 'Try again' }))
      expect(await screen.findByText('In the shared application package.')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.getByRole('textbox')).toBeEnabled()
    },
  )

  it('deletes an unrecoverable session from the recovery panel after confirming', async () => {
    const user = userEvent.setup()
    const { client } = renderConnected('/sessions/session-1', {
      ...SEED,
      workspaces: [{ ...WORKSPACE, exists: false, availability: 'missing' }],
    })
    const panel = await screen.findByRole('region', { name: 'Session recovery' })
    await user.click(within(panel).getByRole('button', { name: 'Delete session' }))
    // One click only arms the action; the transcript is gone for good.
    expect(client.getState().sessions[SESSION.sessionId]).toBeDefined()
    await user.click(within(panel).getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => expect(client.getState().sessions[SESSION.sessionId]).toBeUndefined())
    await waitFor(() => expect(screen.queryByText('Sidebar move')).not.toBeInTheDocument())
  })

  it('keeps an unrecoverable session and reports why when deleting it fails', async () => {
    const user = userEvent.setup()
    const { client } = renderConnected('/sessions/session-1', {
      ...SEED,
      workspaces: [{ ...WORKSPACE, exists: false, availability: 'missing' }],
    })
    const panel = await screen.findByRole('region', { name: 'Session recovery' })
    vi.spyOn(client.commands, 'deleteSession').mockRejectedValue(
      new Error('Not connected to the environment.'),
    )
    await user.click(within(panel).getByRole('button', { name: 'Delete session' }))
    await user.click(within(panel).getByRole('button', { name: 'Delete permanently' }))
    expect(await within(panel).findByText('Not connected to the environment.')).toBeInTheDocument()
    expect(client.getState().sessions[SESSION.sessionId]).toBeDefined()
  })

  it('renders the shared sidebar, empty chat and a ready composer once connected', async () => {
    renderConnected('/')
    expect(await screen.findByText('Sidebar move')).toBeInTheDocument()
    expect(screen.getAllByText('repo').length).toBeGreaterThan(0)
    expect(screen.getByText(/Let's build in/)).toBeInTheDocument()
    // The project the landing names is open as a draft: typing needs no pick first.
    expect(screen.getByRole('textbox')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('opens a session from the sidebar, shows its messages and moves to its route', async () => {
    const user = userEvent.setup()
    const { router } = renderConnected('/')
    await user.click(await screen.findByText('Sidebar move'))
    expect(await screen.findByText('Where does the sidebar live now?')).toBeInTheDocument()
    expect(screen.getByText('In the shared application package.')).toBeInTheDocument()
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/sessions/session-1')
    })
    expect(screen.getByRole('textbox')).toBeEnabled()
  })

  // Switching sessions waits on `session.open`. The wait belongs to the next
  // session, not to the new-session landing standing in until the reply.
  it('shows the next session, never the landing, while it opens', async () => {
    const user = userEvent.setup()
    const OTHER_THREAD = { threadId: 'thread-2', sessionId: 'session-2' }
    connectedEnvironment()
    // Every command takes a while, so the open is in flight long enough to see.
    const client = createMockEnvironmentClient({
      latencyMs: 250,
      seed: {
        ...SEED,
        sessions: [
          ...SEED.sessions!,
          {
            session: { sessionId: 'session-2', workspaceId: WORKSPACE.workspaceId, title: 'Other' },
            threads: [OTHER_THREAD],
            turns: [{ turnId: 'turn-2', threadId: OTHER_THREAD.threadId, state: 'completed' }],
            messages: [
              {
                messageId: 'user-2',
                threadId: OTHER_THREAD.threadId,
                turnId: 'turn-2',
                role: 'user',
                content: [{ type: 'text', text: 'What did the other session do?' }],
              },
            ],
          },
        ],
      },
    })
    const { router } = renderWebApp('/sessions/session-1', {
      createEnvironmentClient: () => client,
    })
    expect(await screen.findByText('In the shared application package.')).toBeInTheDocument()

    let landingShown = false
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes('Start with a message below')) landingShown = true
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    await user.click(within(sidebar()).getByText('Other'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions/session-2'))
    // Picked at once, so the sidebar and the pane agree while it loads.
    expect(client.getState().activeSessionId).toBe('session-2')
    expect(await screen.findByText('What did the other session do?')).toBeInTheDocument()
    observer.disconnect()
    expect(landingShown).toBe(false)
  })

  it('opens the session named by the URL', async () => {
    const { client } = renderConnected('/sessions/session-1')
    expect(await screen.findByText('In the shared application package.')).toBeInTheDocument()
    expect(client.getState().activeSessionId).toBe('session-1')
  })

  it('replaces the address of a session the environment does not have with `/`', async () => {
    const { client, router } = renderConnected('/sessions/deleted-since')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(client.calls).toContainEqual({ command: 'openSession', input: 'deleted-since' })
    const textbox = await screen.findByRole('textbox')
    await waitFor(() => expect(textbox).toBeEnabled())
    expect(textbox).toHaveValue('')
  })

  it('leads a sent draft’s address on to `/` when its session was deleted since', async () => {
    // This browser sent the draft; the session it became is gone.
    localStorage.setItem('openmanager.sent-drafts', JSON.stringify({ 'sent-draft': 'deleted' }))
    const { router } = renderConnected('/drafts/sent-draft', {
      ...SEED,
      workspaces: [{ ...WORKSPACE, capabilities: { git: false, providers: ['opencode'] } }],
    })
    const visited: string[] = []
    const stop = router.history.subscribe(() => visited.push(router.history.location.pathname))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    stop()
    expect(visited).toContain('/sessions/deleted')
    const textbox = await screen.findByRole('textbox')
    await waitFor(() => expect(textbox).toBeEnabled())
    expect(textbox).toHaveValue('')
  })

  it('opens a session from its URL before the catalog lists it, without leaving the URL', async () => {
    connectedEnvironment()
    // The catalog has not reached it (past its first page); the environment has it.
    const client = createMockEnvironmentClient({ seed: { ...SEED, sessions: [] } })
    const open = client.commands.openSession.bind(client.commands)
    vi.spyOn(client.commands, 'openSession').mockImplementation(async (sessionId) => {
      if (sessionId === SESSION.sessionId && !client.getState().sessions[sessionId]) {
        const timestamp = new Date().toISOString()
        client.emit({
          type: 'event',
          name: 'session.created',
          eventId: 'listed-late',
          timestamp,
          scope: { type: 'environment', environmentId: 'env-local' },
          payload: { session: SESSION },
        })
        client.emit({
          type: 'event',
          name: 'thread.created',
          eventId: 'listed-late-thread',
          timestamp,
          scope: { type: 'session', environmentId: 'env-local', sessionId: SESSION.sessionId },
          payload: { thread: THREAD },
        })
      }
      return open(sessionId)
    })
    const { router } = renderWebApp(`/sessions/${SESSION.sessionId}`, {
      createEnvironmentClient: () => client,
    })
    const visited: string[] = []
    const stop = router.history.subscribe(() => visited.push(router.history.location.pathname))
    await waitFor(() => expect(client.getState().activeSessionId).toBe(SESSION.sessionId))
    stop()
    expect(router.state.location.pathname).toBe(`/sessions/${SESSION.sessionId}`)
    expect(visited).not.toContain('/')
    // Asked for once: the catalog learning of it does not open it again.
    expect(client.calls.filter((call) => call.command === 'openSession')).toHaveLength(1)
  })

  it('adds a project picked in the folder browser', async () => {
    const user = userEvent.setup()
    const { client } = renderConnected('/', {
      ...SEED,
      home: 'C:/work',
      folders: { 'C:/work': ['other'], 'C:/work/other': [] },
    })
    await user.click(await screen.findByRole('button', { name: 'Add project' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a project' })
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveValue('C:/work/'))
    await user.type(screen.getByLabelText('Folder path'), 'other')
    await user.click(within(dialog).getByRole('button', { name: /Add other/ }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add a project' })).not.toBeInTheDocument()
    })
    expect(client.calls).toContainEqual({
      command: 'addWorkspace',
      input: { path: 'C:/work/other' },
    })
    await waitFor(() =>
      expect(
        Object.values(client.getState().workspaces).map((workspace) => workspace.path),
      ).toContain('C:/work/other'),
    )
    // Adding a project opens a new agent in it: the draft's project picker
    // names it and the composer is ready.
    const picker = screen.getByText("Let's build in").parentElement!
    await waitFor(() => expect(within(picker).getByRole('button')).toHaveTextContent('other'))
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
  })

  it('offers new agent, add project and settings in the command palette', async () => {
    const user = userEvent.setup()
    const { router } = renderConnected('/', {
      ...SEED,
      home: 'C:/work',
      folders: { 'C:/work': [] },
    })
    await findInSidebar('Sidebar move')
    const palette = async () => {
      await user.keyboard('{Control>}k{/Control}')
      return screen.findByRole('dialog', { name: 'Search and commands' })
    }

    await user.click(within(await palette()).getByRole('option', { name: /New agent/ }))
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())

    await user.click(within(await palette()).getByRole('option', { name: /Add project/ }))
    await screen.findByRole('dialog', { name: 'Add a project' })
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add a project' })).not.toBeInTheDocument()
    })

    await user.click(within(await palette()).getByRole('option', { name: /Open settings/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  })

  it('marks sessions in a project whose folder is gone and starts new agents elsewhere', async () => {
    const GONE = { ...WORKSPACE, workspaceId: 'C:/gone', name: 'gone', path: 'C:/gone' }
    renderConnected('/', {
      ...SEED,
      workspaces: [WORKSPACE, { ...GONE, exists: false }],
      sessions: [
        ...SEED.sessions!,
        {
          session: { sessionId: 'session-gone', workspaceId: GONE.workspaceId, title: 'Lost work' },
          threads: [{ threadId: 'thread-gone', sessionId: 'session-gone' }],
        },
      ],
    })
    // The badge rides the card of the missing project's session, and only it.
    const lost = (await findInSidebar('Lost work')).closest('button')!
    expect(lost).toHaveTextContent('gone')
    expect(lost).toHaveTextContent('MISSING')
    const healthy = within(sidebar()).getByText('Sidebar move').closest('button')!
    expect(healthy).not.toHaveTextContent('MISSING')
    expect(within(sidebar()).getAllByText('MISSING')).toHaveLength(1)
    // New agent targets a project that still exists.
    expect(screen.getByRole('button', { name: 'New agent' })).toBeEnabled()
  })

  it('offers no new agent when every registered project is gone', async () => {
    renderConnected('/', {
      ...SEED,
      workspaces: [{ ...WORKSPACE, exists: false }],
    })
    expect(await findInSidebar('MISSING')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New agent' })).toBeDisabled()
  })

  it('sends a prompt through the composer and renders the streamed reply', async () => {
    const user = userEvent.setup()
    const { client } = renderConnected('/sessions/session-1')
    const textbox = await screen.findByRole('textbox')
    await waitFor(() => expect(textbox).toBeEnabled())
    await user.type(textbox, 'hello web')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('You said: hello web')).toBeInTheDocument()
    expect(client.calls.map((call) => call.command)).toContain('sendTurn')
  })

  // `/`, `/drafts/$draftId` and `/sessions/$sessionId` share one chat pane, so
  // a draft's first character and its first message move the URL without
  // rebuilding the pane.
  it('launches a draft into its session route with the same composer and no landing in between', async () => {
    const user = userEvent.setup()
    const { client, router } = renderConnected('/', {
      environment: SEED.environment,
      workspaces: [{ ...WORKSPACE, capabilities: { git: false, providers: ['opencode'] } }],
    })
    await waitFor(() => expect(screen.getByText('Start with a message below')).toBeInTheDocument())
    const textbox = await screen.findByRole('textbox')
    await waitFor(() => expect(textbox).toBeEnabled())
    await user.type(textbox, 'first words')
    // The first character gave the draft its address, in place.
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/drafts\//))
    const draftPath = router.state.location.pathname
    expect(screen.getByRole('textbox')).toBe(textbox)
    expect(textbox).toHaveFocus()
    expect(textbox).toHaveValue('first words')

    // Held until the transcript has taken over, so the whole launch is watched.
    const create = client.commands.createSession.bind(client.commands)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(client.commands, 'createSession').mockImplementation(async (input) => {
      await gate
      return create(input)
    })
    // The landing may only leave once: gone, then back, is the flicker.
    let landingLeft = false
    let landingReturned = false
    const observer = new MutationObserver(() => {
      const landing = document.body.textContent?.includes('Start with a message below')
      if (!landing) landingLeft = true
      else if (landingLeft) landingReturned = true
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    await user.click(screen.getByRole('button', { name: 'Send' }))

    // Creating: the message is already in the transcript, the URL is still the draft's.
    expect(await screen.findByText('Creating session…')).toBeInTheDocument()
    expect(screen.getByText('first words')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(draftPath)
    expect(landingLeft).toBe(true)

    await act(async () => release())
    expect(await screen.findByText('You said: first words')).toBeInTheDocument()
    const sessionId = client.getState().activeSessionId
    expect(sessionId).not.toBeNull()
    await waitFor(() => expect(router.state.location.pathname).toBe(`/sessions/${sessionId}`))
    observer.disconnect()
    expect(screen.getByRole('textbox')).toBe(textbox)
    expect(landingReturned).toBe(false)
  })

  it('keeps each draft at its own address, and `/` blank', async () => {
    const user = userEvent.setup()
    const { router } = renderConnected('/', {
      environment: SEED.environment,
      workspaces: [{ ...WORKSPACE, capabilities: { git: false, providers: ['opencode'] } }],
    })
    const textbox = await screen.findByRole('textbox')
    await waitFor(() => expect(textbox).toBeEnabled())
    await user.type(textbox, 'first draft')
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/drafts\//))
    const first = router.state.location.pathname

    // New agent: a blank page, the first draft kept at its address.
    await user.click(screen.getByRole('button', { name: 'New agent' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
    await user.type(screen.getByRole('textbox'), 'second draft')
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/drafts\//))
    const second = router.state.location.pathname
    expect(second).not.toBe(first)

    await act(() => router.history.back())
    await waitFor(() => expect(router.state.location.pathname).toBe(first))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('first draft'))
    await act(() => router.history.forward())
    await waitFor(() => expect(router.state.location.pathname).toBe(second))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('second draft'))
  })

  it('opens a blank page in place of a draft address nobody knows', async () => {
    const { router } = renderConnected('/drafts/nobody-knows', {
      environment: SEED.environment,
      workspaces: [{ ...WORKSPACE, capabilities: { git: false, providers: ['opencode'] } }],
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    const textbox = await screen.findByRole('textbox')
    await waitFor(() => expect(textbox).toBeEnabled())
    expect(textbox).toHaveValue('')
  })
})
