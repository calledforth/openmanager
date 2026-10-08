// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, Profiler, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionGlobalConfig } from 'motion/react'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  selectDraftSyncStatus,
  selectDraftTarget,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import type { Workspace } from '@openmanager/protocol'
import { SidebarProvider } from '../src/components/fluid/ui/sidebar'
import { ChatWorkspace } from '../src/components/chat/ChatWorkspace'
import { WorkspaceSidebar } from '../src/components/sidebar/WorkspaceSidebar'
import { DraftDiscardNotice } from '../src/components/sidebar/DraftDiscardToast'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { DRAFT_DISCARD_UNDO_MS } from '../src/providers/environment-sidebar-drafts'
import { useSessionState, type SessionStateValue } from '../src/providers/session-provider'
import { useSidebarDrafts, type SidebarDraftsValue } from '../src/providers/sidebar-provider'
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

// Whole shells mounted per test: the longest runs about 3 s alone, and
// goes past 5 s under the full suite's load.
vi.setConfig({ testTimeout: 20_000 })

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
  /** Show or drop the sidebar, as a phone's sheet closing does. */
  showSidebar: (shown: boolean) => void
  drafts: SidebarDraftsValue | null
}
let navigations: string[] = []
let sidebarRenders = 0

function Capture() {
  probe.session = useSessionState()
  probe.drafts = useSidebarDrafts()
  return null
}

/** The web's shell over an in-memory address: the sidebar beside the chat pane. */
function Host({ client, initial }: { client: MockEnvironmentClient; initial: Route }) {
  const [route, setRoute] = useState<Route>(initial)
  const [sidebarShown, showSidebar] = useState(true)
  probe.route = route
  probe.showSidebar = showSidebar
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
        {sidebarShown ? (
          <Profiler id="sidebar" onRender={() => (sidebarRenders += 1)}>
            <WorkspaceSidebar />
          </Profiler>
        ) : null}
        <ChatWorkspace />
        {/* At the shell, beside the sidebar, as the web mounts it. */}
        <DraftDiscardNotice />
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
/**
 * ✕ clicked with a pointer behind it, as a mouse or a tap makes. Each lands
 * somewhere new unless told where, as a repeat click on one spot is guarded.
 */
let pointerX = 0
const discard = async (text: string, at = (pointerX += 20)) => {
  await act(() =>
    cardFor(text)!
      .querySelector<HTMLButtonElement>('[aria-label="Discard draft"]')!
      .dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1, clientX: at, clientY: 40 }),
      ),
  )
}
/** ✕ pressed from the keyboard: a click with no pointer behind it. */
const keyboardDiscard = async (text: string) => {
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
    // Newest edit first, in the Drafts section above Active, each in its own
    // project. The opened session is Active's only card.
    expect(draftCards()).toEqual(['third idea', 'second idea', 'first idea'])
    expect(activeCards()).toHaveLength(3)
    expect(container.querySelectorAll('[role="list"]')[1]!.children).toHaveLength(1)
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

    // Sent from its page: the card leaves Drafts, and the session's card in
    // Active is the one selected.
    const row = cardFor('second idea')!
    const { sessionId } = selectDraftTarget(client.getState(), probe.session.newSessionDraftId!)!
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    )
    await settle(client)
    expect(client.getState().sessions[sessionId!]).toBeDefined()
    expect(draftCards()).toEqual(['first idea, refined', 'third idea'])
    expect(row.isConnected).toBe(false)
    const sessionCards = [...container.querySelectorAll('[role="list"]')[1]!.children]
    const sent = sessionCards.find((card) => card.querySelector('[aria-current="page"]'))
    expect(sent).toBeDefined()
    expect(sent!.textContent).not.toContain('Draft')

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

  it('pushes a blank `/` when the draft on screen is discarded, so Back returns to it', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await openCard(client, 'second idea')
    const second = probe.session.newSessionDraftId!
    navigations = []

    await discard('second idea')
    await settle(client)
    // Pushed: the draft's own entry stays in the history, one Back away.
    expect(navigations).toEqual(['push /'])
    expect(pathOf(probe.route)).toBe('/')
    expect(probe.session.newSessionDraftId).not.toBe(second)
    // A blank page in the discarded draft's project.
    expect(probe.session.activeWorkspacePath).toBe(BETA.workspaceId)
    expect(composer().value).toBe('')
    expect(draftCards()).toEqual(['third idea', 'first idea'])

    // Back (to its address) before the window closes: it is wanted after all.
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

describe('review regressions', () => {
  const idOf = (client: MockEnvironmentClient, text: string) =>
    Object.values(client.getState().drafts).find((draft) => draft.content.text === text)!.draftId
  /** The live region the notice is swapped in and out of. */
  const region = () => document.querySelector<HTMLElement>('body > [role="status"]')
  const key = (target: Element, name: string, extra: KeyboardEventInit = {}) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...extra }))
    })
  const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  it('keeps the undo, and lets a tap reach it, when the sidebar goes away', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await discard('third idea')
    // A phone's sheet closes on the tap that reaches for Undo.
    await act(() => probe.showSidebar(false))
    expect(toast()).toBeDefined()
    expect(region()!.firstElementChild!.className).toContain('pointer-events-auto')
    await act(() => button(toast()!, 'Undo').click())
    await act(() => probe.showSidebar(true))
    expect(draftCards()).toEqual(['third idea', 'second idea', 'first idea'])
  })

  it('announces through a live region that was there before the notice', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const live = region()
    expect(live).not.toBeNull()
    expect(live!.getAttribute('aria-live')).toBe('polite')
    expect(live!.textContent).toBe('')
    await discard('third idea')
    expect(region()).toBe(live)
    expect(live!.textContent).toContain('Draft discarded')
  })

  it('puts focus on Undo after a keyboard discard, and lets Escape go', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    await keyboardDiscard('third idea')
    expect(document.activeElement).toBe(button(toast()!, 'Undo'))
    await key(document.activeElement!, 'Escape')
    expect(toast()).toBeUndefined()
    // Not left on the page body: on the card that was next to it.
    expect(document.activeElement).toBe(cardFor('second idea')!.querySelector('button'))
    await settle(client)
    expect(client.getState().drafts[third]).toBeUndefined()

    // Undone from the keyboard: back on the card that came back.
    await keyboardDiscard('second idea')
    await act(() => button(toast()!, 'Undo').click())
    expect(document.activeElement).toBe(cardFor('second idea')!.querySelector('button'))

    // From the pointer, focus stays where it was.
    await discard('second idea')
    expect(document.activeElement).not.toBe(button(toast()!, 'Undo'))
  })

  it('holds the notice while either the pointer or focus is in it', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    vi.useFakeTimers()
    await keyboardDiscard('third idea')
    const notice = region()!.firstElementChild!
    // Focus is on Undo; the pointer comes and goes.
    await act(() => {
      notice.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    await act(() => {
      notice.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
      )
    })
    await act(() => vi.advanceTimersByTime(DRAFT_DISCARD_UNDO_MS * 2))
    expect(toast()).toBeDefined()
    // Focus leaves too: the window runs again.
    await act(() => (document.activeElement as HTMLElement).blur())
    await act(() => vi.advanceTimersByTime(DRAFT_DISCARD_UNDO_MS + 10))
    vi.useRealTimers()
    await settle(client)
    expect(toast()).toBeUndefined()
    expect(client.getState().drafts[third]).toBeUndefined()
  })

  it('drops the open draft’s card once that draft is deleted elsewhere', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await openCard(client, 'second idea')
    const second = probe.session.newSessionDraftId!
    const saved = client.getState().drafts[second]!
    await act(() => client.commands.deleteDraft({ draftId: second, baseRevision: saved.revision }))
    await settle(client)
    expect(draftCards()).toEqual(['third idea', 'first idea'])
    // Written in again: a card once it is left, not the old one now.
    await type('a fresh start')
    await flushDrafts(client)
    expect(draftCards()).toEqual(['third idea', 'first idea'])
    await openCard(client, 'first idea')
    expect(draftCards()).toEqual(['a fresh start', 'third idea', 'first idea'])
  })

  it('offers no discard for a draft being sent', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const first = idOf(client, 'first idea')
    act(() => client.drafts!.beginLaunch(first))
    const card = cardFor('first idea')!
    expect(card.querySelector('[aria-label="Discard draft"]')).toBeNull()
    await act(() => {
      card.firstElementChild!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await wait(50)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    act(() => probe.drafts!.discardDraft(first))
    expect(probe.drafts!.pendingDiscard).toBeNull()
    act(() => client.drafts!.endLaunch(first, 'aborted'))
    expect(cardFor('first idea')!.querySelector('[aria-label="Discard draft"]')).not.toBeNull()
  })

  /** The deletes this page asked for, with the revision each named. */
  const deletesAsked = (client: MockEnvironmentClient) =>
    client.calls
      .filter((call) => call.command === 'deleteDraft')
      .map((call) => call.input as { draftId: string; ifRevision?: number })
  /** The window ends (or the page goes): the discard is let go. */
  const endWindow = async (client: MockEnvironmentClient) => {
    await act(() => window.dispatchEvent(new Event('pagehide')))
    await settle(client)
  }

  it('keeps a draft another device wrote during the window: the delete is refused', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    const saved = client.getState().drafts[third]!
    await discard('third idea')
    await act(() =>
      client.commands.saveDraft({
        draftId: third,
        baseRevision: saved.revision,
        target: saved.target,
        content: { text: 'third idea, and more from the phone' },
      }),
    )
    await settle(client)
    await endWindow(client)
    // Named the revision the discard was made on; the environment refused it.
    expect(deletesAsked(client)).toEqual([
      expect.objectContaining({ draftId: third, ifRevision: saved.revision }),
    ])
    expect(client.getState().drafts[third]?.content.text).toBe(
      'third idea, and more from the phone',
    )
    expect(client.getState().draftEdits[third]).toBeUndefined()
    expect(draftCards()[0]).toBe('third idea, and more from the phone')
  })

  it('keeps a draft written again during the window, even with the same text', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    const saved = client.getState().drafts[third]!
    await discard('third idea')
    // Another device's copy, saved over this one: a restore after its failed
    // send reads the same. A later revision all the same.
    await act(() =>
      client.commands.saveDraft({
        draftId: third,
        baseRevision: saved.revision,
        target: saved.target,
        content: saved.content,
      }),
    )
    await settle(client)
    expect(client.getState().drafts[third]!.revision).toBeGreaterThan(saved.revision)
    await endWindow(client)
    expect(client.getState().drafts[third]?.content.text).toBe('third idea')
    expect(draftCards()).toContain('third idea')
  })

  it('keeps a draft that another device sent and got back during the window', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    const saved = client.getState().drafts[third]!
    const { sessionId } = saved.target as { sessionId: string }
    await discard('third idea')
    // Sent elsewhere: gone, so the discard has nothing left to take.
    await act(() =>
      client.commands.createSession({
        environmentId: client.getState().environment!.environmentId,
        workspaceId: ALPHA.workspaceId,
        providerId: 'opencode',
        firstMessage: 'third idea',
        draftId: third,
        sessionId,
      }),
    )
    await settle(client)
    expect(toast()).toBeUndefined()
    // Its provider fails to start, and the draft is put back.
    await act(() => client.commands.deleteSession(sessionId))
    await act(() =>
      client.commands.saveDraft({
        draftId: third,
        baseRevision: saved.revision + 1,
        target: saved.target,
        content: { text: 'third idea', providerId: 'opencode' },
      }),
    )
    await endWindow(client)
    expect(client.getState().drafts[third]?.content.text).toBe('third idea')
    expect(draftCards()).toContain('third idea')
  })

  it('keeps a draft whose model alone another device changed after this page’s closing save', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await openCard(client, 'first idea')
    const first = probe.session.newSessionDraftId!
    await type('first idea, edited')
    await discard('first idea')
    await settle(client)
    // This page's own closing save landed.
    const saved = client.getState().drafts[first]!
    expect(saved.content.text).toBe('first idea, edited')
    // The same text, project and images, another provider: written since.
    await act(() =>
      client.commands.saveDraft({
        draftId: first,
        baseRevision: saved.revision,
        target: saved.target,
        content: { ...saved.content, providerId: 'cursor' },
      }),
    )
    await settle(client)
    await endWindow(client)
    expect(client.getState().drafts[first]?.content.providerId).toBe('cursor')
    expect(draftCards()).toContain('first idea, edited')
  })

  it('deletes a draft whose own earlier save answers after the discard', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    const { target } = client.getState().drafts[third]!
    // X is on the wire when Y is typed, and the card discarded: X's answer
    // brings a newer revision that is this page's own.
    await act(() => {
      client.drafts!.edit(third, target, { text: 'third idea X' })
      client.drafts!.flush()
      client.drafts!.edit(third, target, { text: 'third idea XY' })
      cardFor('third idea')!
        .querySelector<HTMLButtonElement>('[aria-label="Discard draft"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 999 }))
    })
    await settle(client)
    expect(toast()).toBeDefined()
    await endWindow(client)
    expect(client.getState().drafts[third]).toBeUndefined()
  })

  it('keeps a draft another device saved over an edit this page could not write', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    const saved = client.getState().drafts[third]!
    // Held here, never to be written: too big for one message.
    await act(() => {
      client.drafts!.edit(third, saved.target, { text: 'third idea ' + 'x'.repeat(70_000) })
      client.drafts!.flush()
    })
    await settle(client)
    expect(selectDraftSyncStatus(client.getState(), third)).toBe('too_large')
    await discard('third idea')
    await act(() =>
      client.commands.saveDraft({
        draftId: third,
        baseRevision: saved.revision,
        target: saved.target,
        content: { text: 'third idea, from the phone' },
      }),
    )
    await settle(client)
    await endWindow(client)
    expect(client.getState().drafts[third]?.content.text).toBe('third idea, from the phone')
    expect(cardFor('third idea, from the phone')).toBeDefined()
  })

  it('deletes a draft whose own closing save was on the wire when it was discarded', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    const { target } = client.getState().drafts[third]!
    await act(() => {
      client.drafts!.edit(third, target, { text: 'third idea, last words' })
      client.drafts!.flush()
      cardFor('third idea')!
        .querySelector<HTMLButtonElement>('[aria-label="Discard draft"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 777 }))
    })
    await settle(client)
    const answered = client.getState().drafts[third]!
    expect(answered.content.text).toBe('third idea, last words')
    await endWindow(client)
    // Named at its own save's answer, not at what the discard was made on.
    expect(deletesAsked(client)).toEqual([
      expect.objectContaining({ draftId: third, ifRevision: answered.revision }),
    ])
    expect(client.getState().drafts[third]).toBeUndefined()
  })

  it('keeps a draft another device wrote after this page’s save was answered, the delete queued behind it', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    const third = idOf(client, 'third idea')
    const saved = client.getState().drafts[third]!
    await act(() => {
      // This page's last keystrokes go out; the discard is made, and the page
      // goes at once, so its delete waits behind that save.
      client.drafts!.edit(third, saved.target, { text: 'third idea, last words' })
      client.drafts!.flush()
      cardFor('third idea')!
        .querySelector<HTMLButtonElement>('[aria-label="Discard draft"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 888 }))
      // Another device writes after this page's save reaches the environment,
      // before this page's delete does.
      void client.commands.saveDraft({
        draftId: third,
        baseRevision: saved.revision,
        target: saved.target,
        content: { text: 'third idea, from the phone' },
      })
      window.dispatchEvent(new Event('pagehide'))
    })
    await settle(client)
    expect(client.getState().drafts[third]?.content.text).toBe('third idea, from the phone')
    expect(draftCards()).toContain('third idea, from the phone')
  })

  it('shows what is being sent on the open draft’s card, not the snapshot', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await openCard(client, 'first idea')
    const first = probe.session.newSessionDraftId!
    await type('first idea, as sent')
    expect(draftCards()).toContain('first idea')
    act(() => client.drafts!.beginLaunch(first))
    expect(draftCards()).toContain('first idea, as sent')
    expect(cardFor('first idea, as sent')!.querySelector('[aria-label="Discard draft"]')).toBeNull()
  })

  // The composer empties the box before the send is held, and the send waits
  // on uploads and `session.create`: hung here, so the card can be read mid-send.
  const sendFromComposer = async (client: MockEnvironmentClient) => {
    vi.spyOn(client.commands, 'createSession').mockReturnValue(new Promise(() => undefined))
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    )
  }

  it('shows the text sent from the composer, not the last autosave, while it is sent', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, draftSaveDebounceMs: 60_000 })
    await parkThree(client)
    await openCard(client, 'first idea')
    const first = probe.session.newSessionDraftId!
    await type('first idea, edited before autosave')
    expect(client.getState().drafts[first]!.content.text).toBe('first idea')
    await sendFromComposer(client)
    expect(composer().value).toBe('')
    expect(draftCards()).toContain('first idea, edited before autosave')
    expect(
      cardFor('first idea, edited before autosave')!.querySelector('[aria-label="Discard draft"]'),
    ).toBeNull()
  })

  it('ignores a second click on the spot where the last discard was', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await discard('third idea', 500)
    // The next card slid up under the pointer: a double click's second half.
    await discard('second idea', 500)
    expect(probe.drafts!.pendingDiscard?.draftId).toBe(idOf(client, 'third idea'))
    expect(document.documentElement.hasAttribute('data-draft-discard-guard')).toBe(true)
    // The pointer moved off: the ✕ there is live again.
    await act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 540, clientY: 40 }))
    })
    expect(document.documentElement.hasAttribute('data-draft-discard-guard')).toBe(false)
    await discard('second idea', 500)
    expect(probe.drafts!.pendingDiscard?.draftId).toBe(idOf(client, 'second idea'))
  })

  it('lets a replaced notice act on nothing', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await discard('third idea')
    const first = probe.drafts!.pendingDiscard!
    await discard('second idea')
    const second = probe.drafts!.pendingDiscard!
    // The first notice's Undo, Dismiss and hold, reached mid-fade.
    act(() => probe.drafts!.undoDiscard(first.key))
    act(() => probe.drafts!.confirmDiscard(first.key))
    act(() => probe.drafts!.holdDiscard(true, first.key))
    expect(probe.drafts!.pendingDiscard).toBe(second)
    expect(draftCards()).toEqual(['first idea'])
    act(() => probe.drafts!.undoDiscard(second.key))
    expect(draftCards()).toEqual(['second idea', 'first idea'])
  })

  it('still deletes a draft whose own last keystrokes are saved during the window', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await parkThree(client)
    await openCard(client, 'first idea')
    const first = probe.session.newSessionDraftId!
    // Typed, not saved yet; discarding leaves the page, which saves it.
    await type('first idea, edited')
    await discard('first idea')
    await settle(client)
    expect(client.getState().drafts[first]?.content.text).toBe('first idea, edited')
    expect(toast()).toBeDefined()
    await act(() => window.dispatchEvent(new Event('pagehide')))
    await settle(client)
    expect(client.getState().drafts[first]).toBeUndefined()
  })

  it('deletes before the host files its state away on pagehide, and not on a tab switch', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    let seenByHost: string | undefined
    let third = ''
    // Registered first, as the web's cache is, and not captured.
    const hostSave = () => {
      seenByHost = selectDraftContent(client.getState(), third)?.text
    }
    window.addEventListener('pagehide', hostSave)
    try {
      await parkThree(client)
      third = idOf(client, 'third idea')
      await discard('third idea')
      const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      await act(() => document.dispatchEvent(new Event('visibilitychange')))
      hidden.mockRestore()
      expect(toast()).toBeDefined()
      expect(selectDraftContent(client.getState(), third)?.text).toBe('third idea')

      await act(() => window.dispatchEvent(new Event('pagehide')))
      expect(seenByHost).toBe('')
    } finally {
      window.removeEventListener('pagehide', hostSave)
    }
  })

  it('marks a settled session that holds unsent text', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await act(() => client.commands.settleSession(SESSION.sessionId, true))
    await act(() =>
      client.commands.saveDraft({
        draftId: SESSION.sessionId,
        baseRevision: 0,
        target: { type: 'session', sessionId: SESSION.sessionId },
        content: { text: 'one more thing' },
      }),
    )
    await settle(client)
    const row = [...container.querySelectorAll('li')].find((item) =>
      item.textContent?.includes('First'),
    )
    expect(row?.textContent).toContain('Has an unsent draft')
  })
})
