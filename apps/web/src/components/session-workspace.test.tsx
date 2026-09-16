import { cleanup, screen, waitFor, within } from '@testing-library/react'
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
        protocolVersion: 1,
        capabilities: ['connection.heartbeat'],
        environmentId: 'env-local',
        label: 'Local environment',
      }),
    })),
  )
}

function renderConnected(path: string, seed: MockSeed = SEED) {
  connectedEnvironment()
  const client = createMockEnvironmentClient({ seed })
  const result = renderWebApp(path, { createEnvironmentClient: () => client })
  return { ...result, client }
}

describe('session workspace', () => {
  it('renames and deletes a session through the shared sidebar', async () => {
    const user = userEvent.setup()
    const { client } = renderConnected('/')
    await user.click(await screen.findByRole('button', { name: 'Rename session' }))
    const title = screen.getByRole('textbox', { name: 'Session title' })
    await user.clear(title)
    await user.type(title, 'Renamed in web{Enter}')
    expect(await screen.findByText('Renamed in web')).toBeInTheDocument()
    expect(client.getState().sessions[SESSION.sessionId]?.title).toBe('Renamed in web')
    await user.click(screen.getByRole('button', { name: 'Delete session' }))
    await waitFor(() => expect(client.getState().sessions[SESSION.sessionId]).toBeUndefined())
    expect(screen.queryByText('Renamed in web')).not.toBeInTheDocument()
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
      expect(screen.getByText('Sidebar move')).toBeInTheDocument()
      expect(screen.getByText(availability.toUpperCase())).toBeInTheDocument()
      // The row stays listed and says why it cannot run, without claiming a
      // lifecycle status the environment never reported.
      expect(screen.getByLabelText('Project folder unavailable')).toBeInTheDocument()
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
    expect(screen.queryByText('Sidebar move')).not.toBeInTheDocument()
  })

  it('renders the shared sidebar, empty chat and composer once connected', async () => {
    renderConnected('/')
    expect(await screen.findByText('Sidebar move')).toBeInTheDocument()
    expect(screen.getAllByText('repo').length).toBeGreaterThan(0)
    expect(screen.getByText(/Let's build in/)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
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

  it('opens the session named by the URL', async () => {
    const { client } = renderConnected('/sessions/session-1')
    expect(await screen.findByText('In the shared application package.')).toBeInTheDocument()
    expect(client.getState().activeSessionId).toBe('session-1')
  })

  it('adds a project by typing a path the environment accepts', async () => {
    const user = userEvent.setup()
    const { client } = renderConnected('/')
    await user.click(await screen.findByRole('button', { name: 'Add project' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a project' })
    expect(dialog).toBeInTheDocument()
    await user.type(screen.getByLabelText('Folder path'), 'C:/other')
    await user.click(within(dialog).getByRole('button', { name: 'Add project' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add a project' })).not.toBeInTheDocument()
    })
    expect(client.calls).toContainEqual({ command: 'addWorkspace', input: { path: 'C:/other' } })
    expect(await screen.findByText('other')).toBeInTheDocument()
  })

  it('marks a registered project whose folder is gone and offers no new agent there', async () => {
    renderConnected('/', {
      ...SEED,
      workspaces: [
        WORKSPACE,
        { ...WORKSPACE, workspaceId: 'C:/gone', name: 'gone', path: 'C:/gone', exists: false },
      ],
    })
    expect(await screen.findByText('gone')).toBeInTheDocument()
    expect(screen.getByText('MISSING')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New Agent' })).toHaveLength(2)
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
})
