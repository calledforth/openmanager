// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, Profiler, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  selectDraftTarget,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import type { Workspace } from '@openmanager/protocol'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { ChatWorkspace } from '../src/components/chat/ChatWorkspace'
import { WorkspaceSidebar } from '../src/components/sidebar/WorkspaceSidebar'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { DRAFT_DISCARD_UNDO_MS } from '../src/providers/environment-sidebar-drafts'
import { useSessionState, type SessionStateValue } from '../src/providers/session-provider'
import { ThemeProvider } from '../src/providers/theme-provider'

const project = (name: string, extra: Partial<Workspace> = {}): Workspace => ({
  workspaceId: `C:/${name}`,
  name,
  path: `C:/${name}`,
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['opencode'] },
  exists: true,
  ...extra,
})
const ALPHA = project('alpha', { lastActivityAt: '2026-10-02T10:00:00.000Z' })
const BETA = project('beta', { lastActivityAt: '2026-10-01T10:00:00.000Z' })
const SESSION = { sessionId: 'session-1', workspaceId: ALPHA.workspaceId, title: 'First' }
const SEED: MockSeed = {
  workspaces: [ALPHA, BETA],
  sessions: [
    {
      session: SESSION,
      providerId: 'opencode',
      threads: [{ threadId: 't1', sessionId: SESSION.sessionId }],
    },
  ],
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }))
  // jsdom never finishes a row's fold, so a card that left would linger.
  MotionGlobalConfig.skipAnimations = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  vi.useRealTimers()
  await act(() => root.unmount())
  container.remove()
  globalThis.localStorage?.clear()
  vi.unstubAllGlobals()
  MotionGlobalConfig.skipAnimations = false
})

const settle = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 6; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

type Route = { draftId: string | null } | { sessionId: string }
const pathOf = (route: Route) =>
  'sessionId' in route
    ? `/sessions/${route.sessionId}`
    : route.draftId
      ? `/drafts/${route.draftId}`
      : '/'

const probe = {} as {
  session: SessionStateValue
  route: Route
  go: (route: Route) => void
}
let navigations: string[] = []
let sidebarRenders = 0

function Capture() {
  probe.session = useSessionState()
  return null
}

/** The web's shell over an in-memory address: the sidebar beside the chat pane. */
function Host({ client, initial }: { client: MockEnvironmentClient; initial: Route }) {
  const [route, setRoute] = useState<Route>(initial)
  probe.route = route
  const go = (next: Route) => {
    setRoute(next)
    if ('sessionId' in next) void client.commands.openSession(next.sessionId).catch(() => undefined)
    else client.setActiveSession(null)
  }
  probe.go = go
  return (
    <EnvironmentApplicationProviders
      collapsedWorkspaceStorage={null}
      onLanding={!('sessionId' in route)}
      landingDraftId={'draftId' in route ? route.draftId : null}
      navigateSession={async (sessionId, options) => {
        const next: Route = sessionId ? { sessionId } : { draftId: null }
        navigations.push(`${options?.replace ? 'replace' : 'push'} ${pathOf(next)}`)
        go(next)
      }}
      navigateDraft={async (draftId, options) => {
        navigations.push(`${options?.replace ? 'replace' : 'push'} /drafts/${draftId}`)
        go({ draftId })
      }}
    >
      <SidebarProvider persist={false}>
        <Profiler id="sidebar" onRender={() => (sidebarRenders += 1)}>
          <WorkspaceSidebar />
        </Profiler>
        <ChatWorkspace />
      </SidebarProvider>
      <Capture />
    </EnvironmentApplicationProviders>
  )
}

async function mount(client: MockEnvironmentClient, initial: Route = { draftId: null }) {
  navigations = []
  await act(() =>
    root.render(
      <ThemeProvider>
        <EnvironmentClientProvider client={client}>
          <Host client={client} initial={initial} />
        </EnvironmentClientProvider>
      </ThemeProvider>,
    ),
  )
  await settle(client)
}

const composer = () => container.querySelector('textarea')!
const type = async (text: string) => {
  const textarea = composer()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The Active list's cards, top to bottom. */
const activeCards = () => [...container.querySelectorAll<HTMLElement>('[role="list"]')[0]!.children]
/** Each draft card's first line, top to bottom. */
const draftCards = () =>
  activeCards()
    .filter((card) => card.textContent?.includes('Draft'))
    // The first line alone, without what is only read out.
    .map((card) => card.querySelector('.text-\\[14px\\]')?.firstChild?.textContent ?? '')
const cardFor = (text: string) => activeCards().find((card) => card.textContent?.includes(text))
const openCard = async (client: MockEnvironmentClient, text: string) => {
  await act(() => cardFor(text)!.querySelector('button')!.click())
  await settle(client)
}
const discard = async (text: string) => {
  await act(() =>
    cardFor(text)!.querySelector<HTMLButtonElement>('[aria-label="Discard draft"]')!.click(),
  )
}
const toast = () =>
  [...document.querySelectorAll('[role="status"]')].find((node) =>
    node.textContent?.includes('Draft discarded'),
  )
const button = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll('button')].find((node) => node.textContent === label)!
const flushDrafts = async (client: MockEnvironmentClient) => {
  act(() => client.drafts!.flush())
  await settle(client)
}

/** Three drafts parked, two in alpha and one in beta, then a session opened. */
async function parkThree(client: MockEnvironmentClient) {
  await mount(client)
  await type('first idea')
  // Typed in for the first time on this page: no card yet.
  expect(draftCards()).toEqual([])
  await act(() => probe.session.createSession(BETA.workspaceId))
  await settle(client)
  expect(draftCards()).toEqual(['first idea'])
  await type('second idea')
  await act(() => probe.session.createSession(ALPHA.workspaceId))
  await settle(client)
  await type('third idea')
  await act(() => probe.session.selectSession(ALPHA.workspaceId, SESSION.sessionId))
  await flushDrafts(client)
}

describe('sidebar draft cards', () => {
  it('parks three drafts across two projects, reopens each, sends one, discards one and undoes it', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    // Newest edit first, at the top of Active, each in its own project.
    expect(draftCards()).toEqual(['third idea', 'second idea', 'first idea'])
    expect(activeCards()).toHaveLength(4)
    expect(cardFor('second idea')!.textContent).toContain('beta')
    expect(cardFor('first idea')!.textContent).toContain('alpha')

    // Reopen each: the card stays, selected, and the page is as it was left.
    for (const text of ['first idea', 'second idea', 'third idea']) {
      await openCard(client, text)
      expect(composer().value).toBe(text)
      expect(cardFor(text)!.querySelector('[aria-current="page"]')).not.toBeNull()
      expect(pathOf(probe.route)).toMatch(/^\/drafts\//)
    }
    expect(probe.session.activeWorkspacePath).toBe(ALPHA.workspaceId)

    // Reopened and typed in: the card holds still until it is left.
    await openCard(client, 'first idea')
    await type('first idea, refined')
    expect(draftCards()).toEqual(['third idea', 'second idea', 'first idea'])
    await openCard(client, 'second idea')
    expect(draftCards()).toEqual(['first idea, refined', 'third idea', 'second idea'])

    // Sent from its page: the same row becomes the session's card.
    const row = cardFor('second idea')!
    const { sessionId } = selectDraftTarget(client.getState(), probe.session.newSessionDraftId!)!
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    )
    await settle(client)
    expect(client.getState().sessions[sessionId!]).toBeDefined()
    expect(draftCards()).toEqual(['first idea, refined', 'third idea'])
    expect(row.isConnected).toBe(true)
    expect(row.textContent).not.toContain('Draft')
    expect(row.querySelector('[aria-current="page"]')).not.toBeNull()

    // Discarded: gone at once, back with Undo, and nothing was deleted.
    await discard('third idea')
    expect(draftCards()).toEqual(['first idea, refined'])
    expect(toast()).toBeDefined()
    await act(() => button(toast()!, 'Undo').click())
    expect(toast()).toBeUndefined()
    expect(draftCards()).toEqual(['first idea, refined', 'third idea'])
    await settle(client)
    expect(
      Object.values(client.getState().drafts).some((draft) => draft.content.text === 'third idea'),
    ).toBe(true)
  })

  it('deletes a discarded draft once its undo window closes, or the page is hidden', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const idOf = (text: string) =>
      Object.values(client.getState().drafts).find((draft) => draft.content.text === text)!.draftId

    const third = idOf('third idea')
    vi.useFakeTimers()
    await discard('third idea')
    await act(() => vi.advanceTimersByTime(DRAFT_DISCARD_UNDO_MS - 100))
    expect(selectDraftContent(client.getState(), third)?.text).toBe('third idea')
    await act(() => vi.advanceTimersByTime(200))
    vi.useRealTimers()
    await settle(client)
    expect(client.getState().drafts[third]).toBeUndefined()
    expect(toast()).toBeUndefined()

    const second = idOf('second idea')
    await discard('second idea')
    await act(() => window.dispatchEvent(new Event('pagehide')))
    await settle(client)
    expect(client.getState().drafts[second]).toBeUndefined()
    expect(draftCards()).toEqual(['first idea'])
  })

  it('takes the page to a blank `/` when the draft on screen is discarded', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await openCard(client, 'second idea')
    const second = probe.session.newSessionDraftId!
    navigations = []

    await discard('second idea')
    await settle(client)
    expect(navigations).toEqual(['replace /'])
    expect(pathOf(probe.route)).toBe('/')
    expect(probe.session.newSessionDraftId).not.toBe(second)
    // A blank page in the discarded draft's project.
    expect(probe.session.activeWorkspacePath).toBe(BETA.workspaceId)
    expect(composer().value).toBe('')
    expect(draftCards()).toEqual(['third idea', 'first idea'])

    // Back to its address before the window closes: it is wanted after all.
    await act(() => probe.go({ draftId: second }))
    await settle(client)
    expect(toast()).toBeUndefined()
    expect(composer().value).toBe('second idea')
    expect(draftCards()).toEqual(['third idea', 'second idea', 'first idea'])
  })

  it('shows another device’s drafts as they come and go, a removed project’s too', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client, { sessionId: SESSION.sessionId })
    expect(draftCards()).toEqual([])

    await act(() =>
      client.commands.saveDraft({
        draftId: 'remote',
        baseRevision: 0,
        target: { type: 'new_session', workspaceId: BETA.workspaceId, sessionId: 'remote-s' },
        content: { text: 'from the phone' },
      }),
    )
    await act(() =>
      client.commands.saveDraft({
        draftId: 'orphan',
        baseRevision: 0,
        target: { type: 'new_session', workspaceId: null, sessionId: 'orphan-s' },
        content: { text: 'kept without a project' },
      }),
    )
    await settle(client)
    expect(draftCards()).toEqual(['kept without a project', 'from the phone'])
    expect(cardFor('kept without a project')!.textContent).toContain('No project')

    const saved = client.getState().drafts.remote!
    await act(() =>
      client.commands.deleteDraft({ draftId: 'remote', baseRevision: saved.revision }),
    )
    await settle(client)
    expect(draftCards()).toEqual(['kept without a project'])
  })

  it('does not re-render the sidebar while a draft is typed in', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    // A draft with a card, and a brand-new one.
    await openCard(client, 'first idea')
    await type('first idea.')
    await settle(client)
    sidebarRenders = 0
    for (const text of ['first idea..', 'first idea...', 'first idea....']) await type(text)
    await flushDrafts(client)
    expect(sidebarRenders).toBe(0)

    await act(() => probe.session.createSession(ALPHA.workspaceId))
    await type('n')
    await settle(client)
    sidebarRenders = 0
    for (const text of ['ne', 'new', 'new one']) await type(text)
    await flushDrafts(client)
    expect(sidebarRenders).toBe(0)
  })

  it('shows no cards on a host without draft pages', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await act(() =>
      root.render(
        <ThemeProvider>
          <EnvironmentClientProvider client={client}>
            <EnvironmentApplicationProviders collapsedWorkspaceStorage={null} onLanding>
              <SidebarProvider persist={false}>
                <WorkspaceSidebar />
                <ChatWorkspace />
              </SidebarProvider>
            </EnvironmentApplicationProviders>
          </EnvironmentClientProvider>
        </ThemeProvider>,
      ),
    )
    await settle(client)
    await act(() =>
      client.commands.saveDraft({
        draftId: 'remote',
        baseRevision: 0,
        target: { type: 'new_session', workspaceId: BETA.workspaceId, sessionId: 'remote-s' },
        content: { text: 'from the phone' },
      }),
    )
    await settle(client)
    expect(draftCards()).toEqual([])
    expect(activeCards()).toHaveLength(1)
  })
})

describe('unsent session drafts', () => {
  const marked = () =>
    activeCards()
      .filter((card) => card.textContent?.includes('Has an unsent draft'))
      .map((card) => (card.textContent?.includes('First') ? 'First' : 'other'))

  it('marks a session whose composer holds unsent text, on every device, until it is sent or cleared', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await act(() => probe.go({ sessionId: SESSION.sessionId }))
    await settle(client)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    // Typed in here: the session on screen carries no mark while it is open.
    await type('half a thought')
    await flushDrafts(client)
    expect(marked()).toEqual([])

    await act(() => probe.go({ draftId: null }))
    await settle(client)
    expect(marked()).toEqual(['First'])

    // Cleared on another device.
    const saved = client.getState().drafts[SESSION.sessionId]!
    await act(() =>
      client.commands.deleteDraft({ draftId: SESSION.sessionId, baseRevision: saved.revision }),
    )
    await settle(client)
    expect(marked()).toEqual([])

    // Written on another device.
    await act(() =>
      client.commands.saveDraft({
        draftId: SESSION.sessionId,
        baseRevision: saved.revision + 1,
        target: { type: 'session', sessionId: SESSION.sessionId },
        content: { text: 'from the phone' },
      }),
    )
    await settle(client)
    expect(marked()).toEqual(['First'])

    // Sent from its own page: the mark is gone once it is left.
    await act(() => probe.go({ sessionId: SESSION.sessionId }))
    await settle(client)
    expect(composer().value).toBe('from the phone')
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    )
    await settle(client)
    await act(() => probe.go({ draftId: null }))
    await settle(client)
    expect(marked()).toEqual([])
  })
})
