import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockEnvironmentClient } from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from './lib/environment-store'
import { CONNECTION_STORIES } from './stories/connection-states'
import { renderWebApp } from './test-utils'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function seedRegistry(
  environments: Array<{
    environmentId: string
    label?: string
    endpoints: string[]
    credential?: string
  }>,
  selectedId: string | null = environments[0]?.environmentId ?? null,
) {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId,
      environments: environments.map((item) => ({
        label: 'Local environment',
        credential: '',
        ...item,
      })),
    }),
  )
}

function mockBootstrap(byEndpoint: Record<string, { environmentId: string; label?: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const match = Object.entries(byEndpoint).find(([endpoint]) => url.startsWith(`${endpoint}/`))
      const body = match?.[1] ?? {
        environmentId: 'env-local',
        label: 'Local environment',
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: ['connection.heartbeat'],
          ...body,
        }),
      }
    }),
  )
}

function storedRegistry() {
  return JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY) ?? '{}') as {
    selectedId: string | null
    environments: Array<{
      environmentId: string
      label: string
      endpoints: string[]
      credential: string
    }>
  }
}

describe('web routes', () => {
  it.each(['idle', 'running', 'question'] as const)(
    'switches sessions with one open per route and opens a draft while %s',
    async (activity) => {
      const user = userEvent.setup()
      seedRegistry([{ environmentId: 'env-local', endpoints: ['http://127.0.0.1:43120'] }])
      mockBootstrap({ 'http://127.0.0.1:43120': { environmentId: 'env-local' } })
      const client = createMockEnvironmentClient({
        seed: {
          environment: { environmentId: 'env-local', name: 'Local environment' },
          workspaces: [
            {
              workspaceId: 'ws',
              name: 'Project',
              path: '/project',
              lastUsedAt: null,
              lastActivityAt: null,
              exists: true,
              capabilities: { git: false, providers: ['opencode'] },
            },
          ],
          sessions: ['a', 'b'].map((id) => ({
            session: { sessionId: id, workspaceId: 'ws', title: `Chat ${id.toUpperCase()}` },
            threads: [{ sessionId: id, threadId: `thread-${id}` }],
          })),
        },
        respond: () => null,
      })
      if (activity !== 'idle') {
        const target = { sessionId: 'a', threadId: 'thread-a' }
        const { turn } = await client.commands.sendTurn({ ...target, text: 'Keep working' })
        if (activity === 'question')
          client.requestInteraction(
            { ...target, turnId: turn.turnId },
            {
              kind: 'question',
              interactionId: 'question-1',
              questions: [
                {
                  questionId: 'q1',
                  prompt: 'Which option?',
                  options: [{ optionId: 'yes', label: 'Yes' }],
                },
              ],
            },
          )
      }
      const { router } = renderWebApp('/sessions/a', { createEnvironmentClient: () => client })
      await waitFor(() => expect(client.getState().activeSessionId).toBe('a'))
      const opens = () =>
        client.calls.filter((call) => call.command === 'openSession').map((call) => call.input)
      expect(opens()).toEqual(['a'])
      await user.click(screen.getByRole('button', { name: /Chat B/ }))
      await waitFor(() => expect(client.getState().activeSessionId).toBe('b'))
      await act(() => client.settle())
      expect(router.state.location.pathname).toBe('/sessions/b')
      // openSession is the client command for the wire's session.open.
      expect(opens()).toEqual(['a', 'b'])

      await user.click(screen.getByRole('button', { name: /Chat A/ }))
      await waitFor(() => expect(client.getState().activeSessionId).toBe('a'))
      expect(router.state.location.pathname).toBe('/sessions/a')
      expect(opens()).toEqual(['a', 'b', 'a'])
      await user.click(screen.getAllByRole('button', { name: 'New Agent' })[0]!)
      await waitFor(() => expect(router.state.location.pathname).toBe('/'))
      await act(() => client.settle())
      expect(client.getState().activeSessionId).toBeNull()
      expect(opens()).toEqual(['a', 'b', 'a'])

      await act(() => router.history.back())
      await waitFor(() => expect(client.getState().activeSessionId).toBe('a'))
      expect(router.state.location.pathname).toBe('/sessions/a')
      expect(opens()).toEqual(['a', 'b', 'a', 'a'])

      await act(() => client.commands.deleteSession('a'))
      await waitFor(() => expect(router.state.location.pathname).toBe('/'))
      expect(client.getState().activeSessionId).toBeNull()
      expect(opens()).toEqual(['a', 'b', 'a', 'a'])
      if (activity === 'idle') {
        await user.click(screen.getAllByRole('button', { name: 'New Agent' })[0]!)
        await user.type(screen.getByRole('textbox'), 'A new conversation')
        await user.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(client.getState().activeSessionId).not.toBeNull())
        const createdId = client.getState().activeSessionId!
        expect(router.state.location.pathname).toBe(`/sessions/${createdId}`)
        expect(opens()).toEqual(['a', 'b', 'a', 'a', createdId])
      }
    },
  )

  it('keeps the draft selected when an overtaken session open resolves last', async () => {
    const user = userEvent.setup()
    seedRegistry([{ environmentId: 'env-local', endpoints: ['http://127.0.0.1:43120'] }])
    mockBootstrap({ 'http://127.0.0.1:43120': { environmentId: 'env-local' } })
    const client = createMockEnvironmentClient({
      latencyMs: 250,
      seed: {
        environment: { environmentId: 'env-local', name: 'Local environment' },
        workspaces: [
          {
            workspaceId: 'ws',
            name: 'Project',
            path: '/project',
            lastUsedAt: null,
            lastActivityAt: null,
            exists: true,
            capabilities: { git: false, providers: ['opencode'] },
          },
        ],
        sessions: ['a', 'b'].map((id) => ({
          session: { sessionId: id, workspaceId: 'ws', title: `Chat ${id.toUpperCase()}` },
          threads: [{ sessionId: id, threadId: `thread-${id}` }],
        })),
      },
      respond: () => null,
    })
    const { router } = renderWebApp('/sessions/a', { createEnvironmentClient: () => client })
    await waitFor(() => expect(client.getState().activeSessionId).toBe('a'))

    // Leave for a draft while the open for B is still in flight.
    await user.click(screen.getByRole('button', { name: /Chat B/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sessions/b'))
    expect(client.getState().activeSessionId).not.toBe('b')
    await user.click(screen.getAllByRole('button', { name: 'New Agent' })[0]!)
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    await act(() => client.settle())
    expect(client.getState().activeSessionId).toBeNull()
    expect(router.state.location.pathname).toBe('/')
  })

  it('renders the no-environment screen on first run', async () => {
    renderWebApp('/')
    expect(
      await screen.findByRole('heading', { name: 'No environment configured' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Environment endpoint')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
  })

  it('keeps settings reachable without an environment', async () => {
    const user = userEvent.setup()
    renderWebApp('/settings')

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Appearance' }))
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('openmanager-theme')).toBe('light')

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('shows the connection story playground for every state', async () => {
    renderWebApp('/playground/connection')
    expect(await screen.findByRole('heading', { name: 'Connection states' })).toBeInTheDocument()
    for (const story of CONNECTION_STORIES) {
      expect(screen.getByRole('heading', { name: story.name })).toBeInTheDocument()
    }
  })

  it('claims the local owner credential on localhost and stores it by environment ID', async () => {
    const user = userEvent.setup()
    const ownerCredential = `omc1.${'B'.repeat(43)}`
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/local-owner')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              environmentId: 'env-local',
              kind: 'owner',
              credential: ownerCredential,
              grant: ['read', 'admin'],
            }),
          }
        }
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
      }),
    )

    renderWebApp('/')
    await user.type(await screen.findByLabelText('Environment endpoint'), 'http://127.0.0.1:43120')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect((await screen.findAllByRole('button', { name: /new agent/i })).length).toBeGreaterThan(0)
    expect(storedRegistry()).toMatchObject({
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Local environment',
          endpoints: ['http://127.0.0.1:43120'],
          credential: ownerCredential,
        },
      ],
    })
    const requested = JSON.stringify(vi.mocked(fetch).mock.calls)
    expect(requested).toContain('/local-owner')
    expect(requested).not.toContain('tunnel.example')
  })

  it('surfaces a local owner identity mismatch without storing or connecting it', async () => {
    const user = userEvent.setup()
    const ownerCredential = `omc1.${'C'.repeat(43)}`
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        return {
          ok: true,
          status: 200,
          json: async () =>
            url.endsWith('/local-owner')
              ? {
                  environmentId: 'env-claimed',
                  kind: 'owner',
                  credential: ownerCredential,
                  grant: ['read', 'admin'],
                }
              : {
                  protocolVersion: PROTOCOL_VERSION,
                  environmentId: 'env-bootstrap',
                  label: 'Unexpected environment',
                  capabilities: ['connection.heartbeat'],
                },
        }
      }),
    )

    renderWebApp('/')
    await user.type(await screen.findByLabelText('Environment endpoint'), 'http://127.0.0.1:43120')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('heading', { name: 'Not authorized' })).toBeInTheDocument()
    expect(screen.getByText(/belongs to a different environment/i)).toBeInTheDocument()
    expect(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)).toBeNull()
    expect(screen.queryByRole('button', { name: /new agent/i })).not.toBeInTheDocument()
  })

  it('connects from the first-run screen using the bootstrap response', async () => {
    const user = userEvent.setup()
    mockBootstrap({
      'http://127.0.0.1:43120': { environmentId: 'env-local', label: 'Local environment' },
    })

    renderWebApp('/')
    await user.type(await screen.findByLabelText('Environment endpoint'), 'http://127.0.0.1:43120')
    await user.type(screen.getByLabelText('Client token'), 'client-token')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect((await screen.findAllByRole('button', { name: /new agent/i })).length).toBeGreaterThan(0)
    expect(storedRegistry()).toMatchObject({
      selectedId: 'env-local',
      environments: [
        {
          environmentId: 'env-local',
          label: 'Local environment',
          endpoints: ['http://127.0.0.1:43120'],
          credential: 'client-token',
        },
      ],
    })
  })

  it('does not claim an owner credential from a remote endpoint', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        environmentId: 'env-remote',
        label: 'Remote lab',
        capabilities: ['connection.heartbeat'],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    renderWebApp('/')
    await user.type(await screen.findByLabelText('Environment endpoint'), 'https://tunnel.example')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect((await screen.findAllByRole('button', { name: /new agent/i })).length).toBeGreaterThan(0)
    expect(storedRegistry().environments).toEqual([
      expect.objectContaining({
        environmentId: 'env-remote',
        endpoints: ['https://tunnel.example'],
        credential: '',
      }),
    ])
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('local-owner')
  })

  it('merges a second URL for the same environment ID', async () => {
    const user = userEvent.setup()
    seedRegistry([
      {
        environmentId: 'env-local',
        endpoints: ['http://127.0.0.1:43120'],
        credential: 'client-token',
      },
    ])
    mockBootstrap({
      'http://127.0.0.1:43120': { environmentId: 'env-local', label: 'Local environment' },
      'https://tunnel.example': { environmentId: 'env-local', label: 'Home lab' },
    })

    renderWebApp('/settings')
    // The shell swaps to the shared sidebar once the client exists; type after that.
    await screen.findByText(/Connected · Local environment/)
    await user.type(screen.getByLabelText('Environment endpoint'), 'https://tunnel.example')
    await user.click(screen.getByRole('button', { name: 'Add environment' }))

    expect(await screen.findByText('Home lab · Selected')).toBeInTheDocument()
    expect(storedRegistry().environments).toEqual([
      {
        environmentId: 'env-local',
        label: 'Home lab',
        endpoints: ['https://tunnel.example', 'http://127.0.0.1:43120'],
        credential: 'client-token',
      },
    ])
  })

  it('selects and removes saved environments without wiping the other records', async () => {
    const user = userEvent.setup()
    seedRegistry(
      [
        {
          environmentId: 'env-a',
          label: 'Home',
          endpoints: ['http://127.0.0.1:43120'],
        },
        {
          environmentId: 'env-b',
          label: 'Lab',
          endpoints: ['http://127.0.0.1:43121'],
        },
      ],
      'env-a',
    )
    mockBootstrap({
      'http://127.0.0.1:43120': { environmentId: 'env-a', label: 'Home' },
      'http://127.0.0.1:43121': { environmentId: 'env-b', label: 'Lab' },
    })

    renderWebApp('/settings')
    await screen.findByText(/Connected · Home/)
    await waitFor(() => expect(screen.getByText('Home · Selected')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Select' }))
    // The shell remounts its content while the client is swapped, so re-query.
    await screen.findByText(/Connected · Lab/)
    await waitFor(() => expect(screen.getByText('Lab · Selected')).toBeInTheDocument())
    expect(storedRegistry().selectedId).toBe('env-b')

    await screen.findByText(/Connected · Lab/)
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!)
    expect(screen.queryByText('Home · Selected')).not.toBeInTheDocument()
    expect(screen.getByText('Lab · Selected')).toBeInTheDocument()
    expect(storedRegistry().environments.map((item) => item.environmentId)).toEqual(['env-b'])
  })

  it('keeps saved environments when changing the selection', async () => {
    const user = userEvent.setup()
    seedRegistry([{ environmentId: 'env-local', endpoints: ['http://127.0.0.1:43120'] }])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { code: 'auth', message: 'Origin is not allowed.' } }),
      })),
    )

    renderWebApp('/')
    expect(await screen.findByRole('heading', { name: 'Not authorized' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Change environment' }))
    expect(
      await screen.findByRole('heading', { name: 'Select an environment' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Local environment')).toBeInTheDocument()
    expect(storedRegistry().environments).toHaveLength(1)
    expect(storedRegistry().selectedId).toBeNull()
  })

  it('does not restore a removed environment from an in-flight add', async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    seedRegistry([{ environmentId: 'env-local', endpoints: ['http://127.0.0.1:43120'] }])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('43121')) await gate
        return {
          ok: true,
          status: 200,
          json: async () => ({
            protocolVersion: PROTOCOL_VERSION,
            environmentId: 'env-local',
            capabilities: [],
            label: 'Local environment',
          }),
        }
      }),
    )

    renderWebApp('/settings')
    await screen.findByText(/Connected · Local environment/)
    await waitFor(() =>
      expect(screen.getByText('Local environment · Selected')).toBeInTheDocument(),
    )
    await user.type(screen.getByLabelText('Environment endpoint'), 'http://127.0.0.1:43121')
    await user.click(screen.getByRole('button', { name: 'Add environment' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(storedRegistry().environments).toEqual([])
    release()
    await waitFor(() => {
      expect(storedRegistry().environments).toEqual([])
    })
  })

  it('renders the shared sidebar after a stored environment is ready', async () => {
    seedRegistry([{ environmentId: 'env-local', endpoints: ['http://127.0.0.1:43120'] }])
    mockBootstrap({
      'http://127.0.0.1:43120': { environmentId: 'env-local', label: 'Local environment' },
    })

    renderWebApp('/')

    expect(await screen.findByRole('button', { name: 'New Agent' })).toBeInTheDocument()
    expect(screen.getByText('No projects yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })

  it('shows an in-shell unreachable banner instead of replacing the session', async () => {
    seedRegistry([{ environmentId: 'env-local', endpoints: ['http://127.0.0.1:43120'] }])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    renderWebApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent('Environment unreachable')
    expect(
      screen.getByText('Connect to an environment to see your sessions here.'),
    ).toBeInTheDocument()
  })

  it('shows the not-found surface for unknown paths once connected', async () => {
    seedRegistry([{ environmentId: 'env-local', endpoints: ['http://127.0.0.1:43120'] }])
    mockBootstrap({
      'http://127.0.0.1:43120': { environmentId: 'env-local' },
    })

    renderWebApp('/missing')
    await screen.findAllByRole('button', { name: /new agent/i })
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument(),
    )
  })
})
