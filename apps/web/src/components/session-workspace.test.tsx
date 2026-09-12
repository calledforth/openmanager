import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockEnvironmentClient, type MockSeed } from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from '../lib/environment-store'
import { renderWebApp } from '../test-utils'

const WORKSPACE = { workspaceId: 'C:/repo', name: 'repo' }
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'Sidebar move' }
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
