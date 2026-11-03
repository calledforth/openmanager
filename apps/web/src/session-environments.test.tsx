import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMockEnvironmentClient,
  type MockSeed,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import { ENVIRONMENT_STORAGE_KEY } from './lib/environment-store'
import { idleUntilDialled, renderWebApp } from './test-utils'

import type {
  SidebarDataValue,
  SidebarDraftsValue,
} from '@openmanager/app-core/providers/sidebar-provider'

/**
 * One set per mounted page, of the environments it was ever given; and the
 * sidebar as it was last rendered, with how often that was.
 */
const { pageSaw, sidebar } = vi.hoisted(() => ({
  pageSaw: new Set<Set<string>>(),
  sidebar: {
    renders: 0,
    data: null as SidebarDataValue | null,
    drafts: null as SidebarDraftsValue | null,
  },
}))

vi.mock('./components/session-notifications', async () => {
  const { useEnvironmentClient } = await import(
    '@openmanager/app-core/providers/environment-client'
  )
  const { useRef } = await import('react')
  return {
    SessionNotifications: () => {
      const seen = useRef<Set<string> | null>(null)
      if (!seen.current) {
        seen.current = new Set()
        pageSaw.add(seen.current)
      }
      const id = useEnvironmentClient().getState().environment?.environmentId
      if (id) seen.current.add(id)
      return null
    },
  }
})

vi.mock('@openmanager/app-core/components/sidebar/WorkspaceSidebar', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@openmanager/app-core/components/sidebar/WorkspaceSidebar')
    >()
  const { useSidebarData, useSidebarDrafts } = await import(
    '@openmanager/app-core/providers/sidebar-provider'
  )
  return {
    ...actual,
    WorkspaceSidebar: (props: Parameters<typeof actual.WorkspaceSidebar>[0]) => {
      sidebar.renders += 1
      sidebar.data = useSidebarData()
      sidebar.drafts = useSidebarDrafts()
      return <actual.WorkspaceSidebar {...props} />
    },
  }
})

const DESK = 'http://127.0.0.1:43120'
const LAPTOP = 'http://127.0.0.1:43121'

afterEach(() => {
  // Lets go of the guard a discard leaves on its spot, which outlives the test.
  fireEvent.pointerMove(window, { clientX: 999, clientY: 999 })
  cleanup()
  pageSaw.clear()
  sidebar.renders = 0
  sidebar.data = null
  sidebar.drafts = null
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
  {
    cachedLaptop = false,
    desk,
    laptop,
  }: { cachedLaptop?: boolean; desk?: Mock; laptop?: Mock } = {},
) {
  const create = (options: WebSocketEnvironmentClientOptions) => {
    const id = options.environmentId ?? 'env-desk'
    const given = id === 'env-laptop' ? laptop : desk
    const client = given ?? mockOf(id)
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
    expect(pageSaw.size).toBeGreaterThan(0)
    expect([...pageSaw].filter((seen) => seen.size > 1)).toEqual([])
  })
})

/** The card a session or draft is shown on: its button, and all that sits beside it. */
async function cardOf(title: string | RegExp) {
  const button = await screen.findByRole('button', { name: title })
  return { button, card: within(button.closest<HTMLElement>('.group\\/card')!) }
}

function twins(environmentId: string, title: string): MockSeed {
  const seed = seedOf(environmentId, `${environmentId}-project`, title)
  const { session, threads, messages, turns } = seed.sessions![0]!
  const sessionId = 'shared-session'
  return {
    ...seed,
    sessions: [
      {
        session: { ...session, sessionId },
        threads: threads!.map((thread) => ({ ...thread, sessionId })),
        turns,
        messages,
      },
    ],
  }
}

describe('one sidebar for every environment', () => {
  it('lists every environment together, each card naming its own', async () => {
    seedRegistry()
    answering()
    renderBoth('/')

    const desk = await cardOf(/Desk chat/)
    const laptop = await cardOf(/Laptop chat/)
    expect(desk.card.getByText('Desk')).toBeInTheDocument()
    expect(laptop.card.getByText('Laptop')).toBeInTheDocument()
    expect(selected()).toBe('env-desk')
  })

  it('shows no environment on the cards when only one is saved', async () => {
    localStorage.setItem(
      ENVIRONMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        selectedId: 'env-desk',
        environments: [
          { environmentId: 'env-desk', label: 'Desk', endpoints: [DESK], credential: '' },
        ],
      }),
    )
    answering()
    renderBoth('/')

    const { card } = await cardOf(/Desk chat/)
    // The screen reader's "on env-desk" is what the environment calls itself, as before.
    expect(card.queryByText('Desk')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Settle' })).toBeInTheDocument()
  })

  it('lists another environment\'s draft and opens it there', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const laptop = mockOf('env-laptop')
    await laptop.commands.saveDraft({
      draftId: 'laptop-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next', workspaceId: '/laptop-project' },
      content: { text: 'Typed on the laptop' },
    })
    const { router } = renderBoth('/', { laptop })

    const { button, card } = await cardOf(/Typed on the laptop/)
    expect(card.getByText('Laptop')).toBeInTheDocument()

    await user.click(button)
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(router.state.location.pathname).toBe('/drafts/laptop-draft')
    expect(await screen.findByDisplayValue('Typed on the laptop')).toBeInTheDocument()
  })

  it('settles a card through its own environment, whichever is open', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = mockOf('env-desk')
    const laptop = mockOf('env-laptop')
    const onDesk = vi.spyOn(desk.commands, 'settleSession')
    const onLaptop = vi.spyOn(laptop.commands, 'settleSession')
    renderBoth('/', { desk, laptop })

    await waitFor(() => expect(laptop.getState().connection.phase).toBe('connected'))
    const { card } = await cardOf(/Laptop chat/)
    await user.click(await card.findByRole('button', { name: 'Settle' }))

    expect(onLaptop).toHaveBeenCalledWith('env-laptop-session', true)
    expect(onDesk).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(laptop.getState().sessions['env-laptop-session']?.settledAt).toBeTruthy(),
    )
    expect(await screen.findByRole('button', { name: 'Move back to active' })).toBeInTheDocument()
    expect(selected()).toBe('env-desk')
  })

  it('pins a card through its own environment, whichever is open', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = mockOf('env-desk')
    const laptop = mockOf('env-laptop')
    const onDesk = vi.spyOn(desk.commands, 'pinSession')
    const onLaptop = vi.spyOn(laptop.commands, 'pinSession')
    renderBoth('/', { desk, laptop })

    await waitFor(() => expect(laptop.getState().connection.phase).toBe('connected'))
    const { card } = await cardOf(/Laptop chat/)
    await user.click(await card.findByRole('button', { name: 'Pin to top' }))

    expect(onLaptop).toHaveBeenCalledWith('env-laptop-session', true)
    expect(onDesk).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(laptop.getState().sessions['env-laptop-session']?.pinnedAt).toBeTruthy(),
    )
    expect(await card.findByRole('button', { name: 'Unpin' })).toBeInTheDocument()
    expect(selected()).toBe('env-desk')
  })

  it('settles the card it was asked to when its twin is open', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = createMockEnvironmentClient({ seed: twins('env-desk', 'Desk twin') })
    const laptop = createMockEnvironmentClient({ seed: twins('env-laptop', 'Laptop twin') })
    const onDesk = vi.spyOn(desk.commands, 'settleSession')
    const onLaptop = vi.spyOn(laptop.commands, 'settleSession')
    renderBoth('/sessions/shared-session', { desk, laptop })

    expect(await screen.findByText('Written on env-desk')).toBeInTheDocument()
    await waitFor(() => expect(laptop.getState().connection.phase).toBe('connected'))
    const { card } = await cardOf(/Laptop twin/)
    await user.click(await card.findByRole('button', { name: 'Settle' }))

    expect(onLaptop).toHaveBeenCalledWith('shared-session', true)
    expect(onDesk).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(laptop.getState().sessions['shared-session']?.settledAt).toBeTruthy(),
    )
    expect(desk.getState().sessions['shared-session']?.settledAt ?? null).toBeNull()
    expect(screen.getByText('Written on env-desk')).toBeInTheDocument()
    expect(selected()).toBe('env-desk')
  })

  it('does nothing for a row whose environment has no client, least of all on the open one', async () => {
    seedRegistry()
    answering()
    const desk = mockOf('env-desk')
    const settle = vi.spyOn(desk.commands, 'settleSession')
    const rename = vi.spyOn(desk.commands, 'renameSession')
    const remove = vi.spyOn(desk.commands, 'deleteSession')
    await desk.commands.saveDraft({
      draftId: 'desk-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next-desk', workspaceId: '/desk-project' },
      content: { text: 'Typed on the desk' },
    })
    renderBoth('/', { desk })
    await cardOf(/Desk chat/)
    await waitFor(() => expect(desk.getState().connection.phase).toBe('connected'))

    const id = 'env-desk-session'
    await act(async () => {
      await sidebar.data!.settleSession!('/desk-project', id, true, 'env-gone')
      await sidebar.data!.renameSession!('/desk-project', id, 'Wrong', 'env-gone')
      await sidebar.data!.deleteSession('/desk-project', id, 'opencode', 'env-gone')
      sidebar.drafts!.discardDraft('desk-draft', { environmentId: 'env-gone' })
    })

    expect(settle).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    await act(async () => {
      await sidebar.data!.pinSession?.('/desk-project', id, true, 'env-gone')
    })
    expect(desk.getState().sessions[id]?.pinnedAt ?? null).toBeNull()
    expect(sidebar.drafts!.pendingDiscard).toBeNull()
    expect(desk.getState().sessions[id]?.title).toBe('Desk chat')
  })

  it('never paints the page without the sidebar beside it', async () => {
    seedRegistry()
    answering()
    // Each snapshot is what a frame painted now would show.
    const bare: string[] = []
    const watch = new MutationObserver(() => {
      if (!screen.queryByRole('main')) return
      if (!document.querySelector('[data-sidebar="sidebar"]')) bare.push(location.pathname)
    })
    watch.observe(document.body, { childList: true, subtree: true })
    renderBoth('/')

    await cardOf(/Desk chat/)
    watch.disconnect()
    expect(bare).toEqual([])
  })

  it('sends a rename and a delete through the row\'s own environment', async () => {
    seedRegistry()
    answering()
    const desk = mockOf('env-desk')
    const laptop = mockOf('env-laptop')
    const deskRename = vi.spyOn(desk.commands, 'renameSession')
    const deskDelete = vi.spyOn(desk.commands, 'deleteSession')
    renderBoth('/', { desk, laptop })
    await cardOf(/Laptop chat/)
    await waitFor(() => expect(laptop.getState().connection.phase).toBe('connected'))

    await act(async () => {
      await sidebar.data!.renameSession!('/laptop-project', 'env-laptop-session', 'Moved', 'env-laptop')
    })
    expect(laptop.getState().sessions['env-laptop-session']?.title).toBe('Moved')
    expect(await screen.findByRole('button', { name: /Moved/ })).toBeInTheDocument()
    expect(deskRename).not.toHaveBeenCalled()

    await act(async () => {
      await sidebar.data!.deleteSession('/laptop-project', 'env-laptop-session', 'opencode', 'env-laptop')
    })
    expect(laptop.getState().sessions['env-laptop-session']).toBeUndefined()
    expect(deskDelete).not.toHaveBeenCalled()
  })

  it('opens another environment\'s card without rebuilding the sidebar', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const { router } = renderBoth('/sessions/env-desk-session')

    const { button } = await cardOf(/Laptop chat/)
    const newAgent = screen.getByRole('button', { name: 'New agent' })
    await user.click(button)

    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/sessions/env-laptop-session')
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    await waitFor(() => expect(button).toHaveAttribute('aria-current', 'page'))
    expect((await cardOf(/Desk chat/)).button).not.toHaveAttribute('aria-current')
    // The same element: a remount would lose the sidebar's scroll and focus.
    expect(newAgent).toBeInTheDocument()
    expect(button).toBeInTheDocument()
  })

  it('tells two sessions with the same id apart', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = createMockEnvironmentClient({ seed: twins('env-desk', 'Desk twin') })
    const laptop = createMockEnvironmentClient({ seed: twins('env-laptop', 'Laptop twin') })
    const { router } = renderBoth('/sessions/shared-session', { desk, laptop })

    expect(await screen.findByText('Written on env-desk')).toBeInTheDocument()
    const deskCard = (await cardOf(/Desk twin/)).button
    const laptopCard = (await cardOf(/Laptop twin/)).button
    await waitFor(() => expect(deskCard).toHaveAttribute('aria-current', 'page'))
    expect(laptopCard).not.toHaveAttribute('aria-current')

    // The address is the same one, and it is the card that says which.
    await user.click(laptopCard)
    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    expect(router.state.location.pathname).toBe('/sessions/shared-session')
    await waitFor(() => expect(laptopCard).toHaveAttribute('aria-current', 'page'))
    expect(deskCard).not.toHaveAttribute('aria-current')

    await user.click(deskCard)
    expect(await screen.findByText('Written on env-desk')).toBeInTheDocument()
    await waitFor(() => expect(selected()).toBe('env-desk'))
  })

  it('discards another environment\'s draft there, with its undo', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const desk = mockOf('env-desk')
    const laptop = mockOf('env-laptop')
    await laptop.commands.saveDraft({
      draftId: 'laptop-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next', workspaceId: '/laptop-project' },
      content: { text: 'Typed on the laptop' },
    })
    await desk.commands.saveDraft({
      draftId: 'desk-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next-desk', workspaceId: '/desk-project' },
      content: { text: 'Typed on the desk' },
    })
    renderBoth('/', { desk, laptop })

    await waitFor(() => expect(laptop.getState().connection.phase).toBe('connected'))
    const discard = async () => {
      const { card } = await cardOf(/Typed on the laptop/)
      await user.click(await card.findByRole('button', { name: 'Discard draft' }))
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /Typed on the laptop/ })).toBeNull(),
      )
    }

    await discard()
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('button', { name: /Typed on the laptop/ })).toBeInTheDocument()
    expect(laptop.getState().drafts['laptop-draft']).toBeDefined()

    await user.pointer({ coords: { x: 300, y: 300 } })
    await discard()
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(laptop.getState().drafts['laptop-draft']).toBeUndefined())
    expect(desk.getState().drafts['desk-draft']).toBeDefined()
    expect(screen.getByRole('button', { name: /Typed on the desk/ })).toBeInTheDocument()
    expect(selected()).toBe('env-desk')
  })

  it('calls off another environment\'s discard on arriving at that draft', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const laptop = mockOf('env-laptop')
    await laptop.commands.saveDraft({
      draftId: 'laptop-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next', workspaceId: '/laptop-project' },
      content: { text: 'Typed on the laptop' },
    })
    const { router } = renderBoth('/', { laptop })
    await waitFor(() => expect(laptop.getState().connection.phase).toBe('connected'))

    const { card } = await cardOf(/Typed on the laptop/)
    await user.click(await card.findByRole('button', { name: 'Discard draft' }))
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument()

    await act(() => router.navigate({ to: '/drafts/$draftId', params: { draftId: 'laptop-draft' } }))
    await waitFor(() => expect(selected()).toBe('env-laptop'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull())
    expect(await screen.findByDisplayValue('Typed on the laptop')).toBeInTheDocument()
    expect(laptop.getState().drafts['laptop-draft']).toBeDefined()
  })

  it('keeps a discard waiting across a move to another environment', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    const laptop = mockOf('env-laptop')
    await laptop.commands.saveDraft({
      draftId: 'laptop-draft',
      baseRevision: 0,
      target: { type: 'new_session', sessionId: 'next', workspaceId: '/laptop-project' },
      content: { text: 'Typed on the laptop' },
    })
    renderBoth('/', { laptop })
    await waitFor(() => expect(laptop.getState().connection.phase).toBe('connected'))

    const { card } = await cardOf(/Typed on the laptop/)
    await user.click(await card.findByRole('button', { name: 'Discard draft' }))
    await user.click((await cardOf(/Laptop chat/)).button)
    expect(await screen.findByText('Written on env-laptop')).toBeInTheDocument()

    // Now its own environment's card, and still hidden; the undo still works.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Typed on the laptop/ })).toBeNull(),
    )
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByRole('button', { name: /Typed on the laptop/ })).toBeInTheDocument()
    expect(laptop.getState().drafts['laptop-draft']).toBeDefined()
  })

  it('lists what an unreachable environment left here, with no settle to offer', async () => {
    seedRegistry()
    answering({ laptop: false })
    renderBoth('/', { cachedLaptop: true })

    const { card } = await cardOf(/Laptop chat/)
    expect(card.getByText('Laptop')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Settle' })).not.toBeInTheDocument()
    expect((await cardOf(/Desk chat/)).card.getByRole('button', { name: 'Settle' })).toBeTruthy()
  })

  it('does not render the sidebar as a draft is typed in', async () => {
    seedRegistry()
    answering()
    const user = userEvent.setup()
    renderBoth('/')
    await cardOf(/Laptop chat/)

    const box = await screen.findByRole('textbox')
    await user.click(box)
    await user.keyboard('The draft has its page by now')
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus())
    const before = sidebar.renders
    await user.keyboard(' and the sidebar has nothing more to show')
    expect(sidebar.renders).toBe(before)
  })

  it('does not render the sidebar for tokens streaming in another environment', async () => {
    seedRegistry()
    answering()
    const laptop = createMockEnvironmentClient({
      seed: seedOf('env-laptop', 'laptop-project', 'Laptop chat'),
      respond: () => null,
    })
    renderBoth('/', { laptop })
    await cardOf(/Laptop chat/)
    await waitFor(() => expect(laptop.getState().connection.phase).toBe('connected'))

    const target = { sessionId: 'env-laptop-session', threadId: 'env-laptop-thread' }
    const { turn } = await act(() => laptop.commands.sendTurn({ ...target, text: 'Go on' }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    const before = sidebar.renders
    const stateBefore = laptop.getState()
    await act(async () => {
      for (let token = 0; token < 25; token += 1) {
        laptop.streamAssistantText({ ...target, turnId: turn.turnId }, 'word ', 'm-stream')
      }
    })
    expect(laptop.getState()).not.toBe(stateBefore)
    expect(sidebar.renders).toBe(before)
  })
})
