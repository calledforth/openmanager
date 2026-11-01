import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  type MockSeed,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from './lib/environment-store'
import { idleUntilDialled, renderWebApp } from './test-utils'

/** One set per mounted sidebar, of the environments it was ever given. */
const { sidebarSaw } = vi.hoisted(() => ({ sidebarSaw: new Set<Set<string>>() }))

vi.mock('@openmanager/app-core/components/sidebar/WorkspaceSidebar', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@openmanager/app-core/components/sidebar/WorkspaceSidebar')
    >()
  const { useEnvironmentClient } = await import(
    '@openmanager/app-core/providers/environment-client'
  )
  const { useRef } = await import('react')
  return {
    ...actual,
    WorkspaceSidebar: (props: Parameters<typeof actual.WorkspaceSidebar>[0]) => {
      const seen = useRef<Set<string> | null>(null)
      if (!seen.current) {
        seen.current = new Set()
        sidebarSaw.add(seen.current)
      }
      const id = useEnvironmentClient().getState().environment?.environmentId
      if (id) seen.current.add(id)
      return <actual.WorkspaceSidebar {...props} />
    },
  }
})

const DESK = 'http://127.0.0.1:43120'
const LAPTOP = 'http://127.0.0.1:43121'

afterEach(() => {
  cleanup()
  sidebarSaw.clear()
  localStorage.clear()
  vi.unstubAllGlobals()
})

function seedRegistry() {
  localStorage.setItem(
    ENVIRONMENT_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      selectedId: 'env-desk',
      environments: [
        { environmentId: 'env-desk', label: 'Desk', endpoints: [DESK], credential: '' },
        { environmentId: 'env-laptop', label: 'Laptop', endpoints: [LAPTOP], credential: '' },
      ],
    }),
  )
}

function answering({ laptop = true, laptopAfter = 0 }: { laptop?: boolean; laptopAfter?: number } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const onLaptop = String(input).startsWith(LAPTOP)
      if (onLaptop && !laptop) throw new TypeError('Failed to fetch')
      if (onLaptop && laptopAfter) {
        await new Promise((resolve) => setTimeout(resolve, laptopAfter))
      }
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

function project(name: string) {
  return {
    workspaceId: `/${name}`,
    name,
    path: `/${name}`,
    lastUsedAt: null,
    lastActivityAt: null,
    exists: true,
    capabilities: { git: false },
  }
}

function seedOf(environmentId: string, name: string, sessionTitle?: string): MockSeed {
  const workspace = project(name)
  return {
    environment: { environmentId, name: environmentId },
    workspaces: [workspace],
    sessions: sessionTitle
      ? [
          {
            session: {
              sessionId: `${environmentId}-session`,
              workspaceId: workspace.workspaceId,
              title: sessionTitle,
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
        ]
      : [],
  }
}

type Mock = ReturnType<typeof createMockEnvironmentClient>

function mockOf(id: string): Mock {
  return createMockEnvironmentClient({
    seed:
      id === 'env-laptop'
        ? seedOf(id, 'laptop-project', 'Laptop chat')
        : seedOf(id, 'desk-project', 'Desk chat'),
  })
}

function renderBoth(
  path: string,
  { cachedLaptop = false, laptop }: { cachedLaptop?: boolean; laptop?: Mock } = {},
) {
  const create = (options: WebSocketEnvironmentClientOptions) => {
    const id = options.environmentId ?? 'env-desk'
    const client = id === 'env-laptop' && laptop ? laptop : mockOf(id)
    return idleUntilDialled(client, undefined, { cached: id === 'env-laptop' && cachedLaptop })
  }
  return renderWebApp(path, { createEnvironmentClient: create as never })
}

const selected = () =>
  (JSON.parse(localStorage.getItem(ENVIRONMENT_STORAGE_KEY)!) as { selectedId: string }).selectedId

describe('opening an address that belongs to another environment', () => {
  it('opens a session in the environment that has it', async () => {
    seedRegistry()
    answering()
    const { router } = renderBoth('/sessions/env-laptop-session')

    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sessions/env-laptop-session')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(screen.getAllByText('laptop-project').length).toBeGreaterThan(0)
    expect(screen.queryByText('desk-project')).not.toBeInTheDocument()
  })

  it('keeps a link to the selected environment working as it did', async () => {
    seedRegistry()
    answering()
    renderBoth('/sessions/env-desk-session')

    expect(await screen.findByText('Written on env-desk')).toBeInTheDocument()
    expect(selected()).toBe('env-desk')
  })

  it('opens a session this browser kept when its environment cannot be reached', async () => {
    seedRegistry()
    answering({ laptop: false })
    const { router } = renderBoth('/sessions/env-laptop-session', { cachedLaptop: true })

    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(router.state.location.pathname).toBe('/sessions/env-laptop-session')
    expect(await screen.findByText('Laptop chat')).toBeInTheDocument()
  })

  it('leaves for the start page when nobody has it', async () => {
    seedRegistry()
    answering()
    const { router } = renderBoth('/sessions/nobody-has-this')

    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(selected()).toBe('env-desk')
  })

  it('says where it may be instead of leaving, when an environment is offline', async () => {
    seedRegistry()
    answering({ laptop: false })
    const { router } = renderBoth('/sessions/nobody-has-this')

    expect(
      await screen.findByText('This session may be on Laptop, which is offline.'),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sessions/nobody-has-this')
    expect(selected()).toBe('env-desk')
  })

  it('opens a draft in the environment that has it, with that environment\'s text', async () => {
    seedRegistry()
    answering()
    const laptop = mockOf('env-laptop')
    await laptop.commands.saveDraft({
      draftId: 'laptop-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next', workspaceId: '/laptop-project' },
      content: { text: 'Typed on the laptop' },
    })
    const { router } = renderBoth('/drafts/laptop-draft', { laptop })

    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(await screen.findByDisplayValue('Typed on the laptop')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/drafts/laptop-draft')
  })

  it('keeps a draft address while the environment that has it is still connecting', async () => {
    seedRegistry()
    answering({ laptopAfter: 300 })
    const laptop = mockOf('env-laptop')
    await laptop.commands.saveDraft({
      draftId: 'laptop-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next', workspaceId: '/laptop-project' },
      content: { text: 'Typed on the laptop' },
    })
    const { router } = renderBoth('/drafts/laptop-draft', { laptop })

    // The selected environment has listed its drafts, and this is not one.
    await screen.findAllByText('desk-project')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(router.state.location.pathname).toBe('/drafts/laptop-draft')

    expect(await screen.findByDisplayValue('Typed on the laptop')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/drafts/laptop-draft')
  })

  it('never hands a mounted page another environment\'s client', async () => {
    seedRegistry()
    answering({ laptopAfter: 150 })
    renderBoth('/sessions/env-laptop-session')

    await screen.findAllByText('desk-project')
    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
    expect(sidebarSaw.size).toBeGreaterThan(0)
    expect([...sidebarSaw].filter((seen) => seen.size > 1)).toEqual([])
  })
})
