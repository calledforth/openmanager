// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentApplicationProviders,
  EnvironmentClientProvider,
  useActiveThreadState,
  useSessionState,
  type SessionStateValue,
  type UIMessage,
} from '@openmanager/app-core/logic'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeed,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'

import type { PhoneConnectionState } from '../src/environment/controller'
import type { ComposerModel } from '../src/composer/model'
import type { ProjectSource } from '../src/composer/ProjectSheet'

const connection = {
  loaded: true,
  environments: [],
  selectedId: null,
  links: {},
  activity: 'active',
  network: { online: true },
} as unknown as PhoneConnectionState
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({
  usePhoneConnection: () => connection,
  // Every page here is `env-1`'s (`E` below), and it is connected.
  usePageEnvironmentId: () => 'env-1',
  useEnvironmentLabel: () => 'Desk',
  usePageConnectionStatus: () => 'connected',
}))

const { useLiveComposerModel, draftSendBlocked } =
  await import('../src/composer/useLiveComposerModel')
const { ThreadBridge } = await import('../src/composer/thread-port')
const { pressPrimary } = await import('../src/composer/model')
const { useProjectSource } = await import('../src/draft/useProjectSource')
const { useReadOnlySession } = await import('../src/session/useReadOnlySession')
const { landingOf, draftHref, sessionHref, sessionOnPath, sessionRowHref, draftRowHref } =
  await import('../src/environment/landing-route')
const { createPhoneNavigation, ARRIVAL_TIMEOUT_MS } = await import('../src/environment/navigation')

/** The environment every page in these tests belongs to. */
const E = 'env-1'
const BLANK = draftHref(E, null)
const draftPage = (draftId: string) => draftHref(E, draftId)
const sessionPage = (sessionId: string) => sessionHref(E, sessionId)
const { svgOfDataUrl } = await import('../src/ui/project-icon')
const { DraftDiscardHost } = await import('../src/draft/DraftDiscardHost')
const { discardHandoff } = await import('../src/draft/discard-handoff')
const { DRAFT_SYNC_EXPLANATION } = await import('@openmanager/app-core/logic')
const { useSidebarDrafts } = await import('@openmanager/app-core/providers/sidebar-provider')

describe('the landing, by address', () => {
  const OFF = { onLanding: false, environmentId: null, draftId: null }

  it('reads the blank page, a draft page, and everything else', () => {
    expect(landingOf('/draft/env-1/new')).toEqual({
      onLanding: true,
      environmentId: 'env-1',
      draftId: null,
    })
    expect(landingOf('/draft/env%201/d%201')).toEqual({
      onLanding: true,
      environmentId: 'env 1',
      draftId: 'd 1',
    })
    expect(landingOf('/draft/env-1/abc/')).toEqual({
      onLanding: true,
      environmentId: 'env-1',
      draftId: 'abc',
    })
    expect(landingOf('/')).toEqual(OFF)
    expect(landingOf('/session/env-1/s1')).toEqual(OFF)
    expect(landingOf('/draft/')).toEqual(OFF)
    expect(landingOf('/draft/env-1/')).toEqual(OFF)
    // An address from before environments were in it is no landing: its
    // page moves it to its environment's address first.
    expect(landingOf('/draft/new')).toEqual(OFF)
    expect(landingOf('/draft/abc')).toEqual(OFF)
    expect(landingOf('/draft/a/b/c')).toEqual(OFF)
  })

  it('writes every address as its environment’s own', () => {
    expect(draftHref('env-1', null)).toBe('/draft/env-1/new')
    expect(draftHref('env 1', 'd 1')).toBe('/draft/env%201/d%201')
    expect(sessionHref('env-1', 's/1')).toBe('/session/env-1/s%2F1')
    expect(sessionHref('a/b', 's1')).toBe('/session/a%2Fb/s1')
    // Written and read back.
    expect(landingOf(draftHref('a/b', 'c/d'))).toEqual({
      onLanding: true,
      environmentId: 'a/b',
      draftId: 'c/d',
    })
    expect(sessionOnPath(sessionHref('a/b', 'c/d'))).toEqual({
      environmentId: 'a/b',
      sessionId: 'c/d',
    })
  })

  it('opens a listed row through its own environment, and the fixture’s at its old address', () => {
    const on = { environmentId: 'env-2' }
    expect(sessionRowHref({ externalId: 's 1', environment: on })).toBe('/session/env-2/s%201')
    expect(draftRowHref({ draftId: 'd/1', environment: on })).toBe('/draft/env-2/d%2F1')
    // The same ids on another environment are other pages.
    expect(sessionRowHref({ externalId: 's 1', environment: { environmentId: 'env-1' } })).toBe(
      '/session/env-1/s%201',
    )
    expect(sessionRowHref({ externalId: 'fixture' })).toBe('/session/fixture')
    expect(draftRowHref({ draftId: 'fixture' })).toBe('/draft/fixture')
  })
})

function fakeRouter() {
  const moves: string[] = []
  return {
    moves,
    router: {
      push: (href: string) => moves.push(`push ${href}`),
      replace: (href: string) => moves.push(`replace ${href}`),
      setParams: (params: Record<string, string>) =>
        moves.push(`setParams ${JSON.stringify(params)}`),
    },
  }
}

describe('the phone navigation', () => {
  it('turns the blank page into its draft in place, and answers once the address reads it', async () => {
    const { moves, router } = fakeRouter()
    const navigation = createPhoneNavigation(router, { environmentId: E })
    navigation.arrived(BLANK)
    let settled = false
    const claimed = navigation.navigateDraft('d1', { replace: true }).then(() => {
      settled = true
    })
    expect(moves).toEqual(['setParams {"draftId":"d1"}'])
    await Promise.resolve()
    expect(settled).toBe(false)
    navigation.arrived(draftPage('d1'))
    await claimed
    expect(settled).toBe(true)
  })

  it('replaces the draft page with its session, and pushes from anywhere else', async () => {
    const { moves, router } = fakeRouter()
    const navigation = createPhoneNavigation(router, { environmentId: E })
    navigation.arrived(draftPage('d1'))
    const sent = navigation.navigateSession('s1', { replace: true })
    navigation.arrived(sessionPage('s1'))
    await sent
    const blank = navigation.navigateSession(null)
    navigation.arrived(BLANK)
    await blank
    const draft = navigation.navigateDraft('d2')
    navigation.arrived(draftPage('d2'))
    await draft
    expect(moves).toEqual([
      'replace /session/env-1/s1',
      'push /draft/env-1/new',
      'push /draft/env-1/d2',
    ])
  })

  it('a blank page asked for on a draft page is that page, and nothing moves to where it is', async () => {
    const { moves, router } = fakeRouter()
    const navigation = createPhoneNavigation(router, { environmentId: E })
    navigation.arrived(draftPage('d1'))
    const blank = navigation.navigateSession(null, { replace: true })
    navigation.arrived(BLANK)
    await blank
    await navigation.navigateDraft('d1', { replace: true }).catch(() => undefined)
    expect(moves[0]).toBe('setParams {"draftId":"new"}')
    // Already there: answered at once, with no second move.
    navigation.arrived(draftPage('d1'))
    await navigation.navigateDraft('d1')
    expect(moves).toHaveLength(2)
  })

  it('treats another environment’s new-session page as somewhere else', async () => {
    const { moves, router } = fakeRouter()
    const navigation = createPhoneNavigation(router, { environmentId: E })
    // The other environment's blank page is in front: not this one's landing.
    navigation.arrived(draftHref('env-2', null))
    const draft = navigation.navigateDraft('d1', { replace: true })
    navigation.arrived(draftPage('d1'))
    await draft
    expect(moves).toEqual(['replace /draft/env-1/d1'])
  })

  it('opens no session in place of a page the reader has left', async () => {
    const { moves, router } = fakeRouter()
    const stayed: string[] = []
    const navigation = createPhoneNavigation(router, {
      environmentId: E,
      stayed: (id) => stayed.push(id),
    })
    navigation.arrived('/')
    await navigation.navigateSession('s1', { replace: true })
    expect(moves).toEqual([])
    expect(stayed).toEqual(['s1'])
    // Asked for outright (not in a page's place), it still opens.
    const pushed = navigation.navigateSession('s2')
    navigation.arrived(sessionPage('s2'))
    await pushed
    expect(moves).toEqual(['push /session/env-1/s2'])
  })

  it('settles a navigation the address never reaches', async () => {
    vi.useFakeTimers()
    try {
      const { router } = fakeRouter()
      const navigation = createPhoneNavigation(router, { environmentId: E })
      navigation.arrived('/')
      let settled = false
      void navigation.navigateSession('s1').then(() => {
        settled = true
      })
      navigation.arrived('/settings')
      await vi.advanceTimersByTimeAsync(ARRIVAL_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('declared project icons', () => {
  it('reads an SVG data URL for SvgXml, and leaves bitmaps to Image', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>é</title></svg>'
    const base64 = Buffer.from(svg, 'utf8').toString('base64')
    expect(svgOfDataUrl(`data:image/svg+xml;base64,${base64}`)).toBe(svg)
    expect(svgOfDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`)).toBe(svg)
    expect(svgOfDataUrl('data:image/svg+xml;base64,@@@')).toBeNull()
    expect(svgOfDataUrl('data:image/svg+xml')).toBeNull()
    expect(svgOfDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBeUndefined()
  })
})

const project = (name: string, lastActivityAt: string | null) => ({
  workspaceId: `C:/${name}`,
  name,
  path: `C:/${name}`,
  lastUsedAt: null,
  lastActivityAt,
  capabilities: { git: false },
  exists: true,
})
const ALPHA = project('alpha', '2026-10-02T10:00:00.000Z')
const BETA = project('beta', '2026-10-01T10:00:00.000Z')

const CLAUDE = {
  id: 'claude',
  displayName: 'Claude Code',
  limits: { supported: false, reading: null, refreshing: false, lastRefresh: null },
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canListSessions: true,
    canCancelPrompt: true,
    supportsPlans: true,
    supportsAvailableCommands: true,
    supportsUsage: true,
    supportsPermissionRequests: true,
    supportsAuthentication: false,
    supportsThoughtStreaming: false,
    supportsSubtasks: false,
    supportsExtensions: false,
    supportsQuestions: true,
  },
  health: {
    summary: 'ready',
    available: true,
    refreshing: false,
    install: 'installed',
    auth: 'authenticated',
    runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
    lastProbe: null,
    update: 'current',
  },
  profile: {
    providerId: 'claude',
    availableModels: [
      { modelId: 'opus', name: 'Opus', supportsImageInput: true },
      { modelId: 'sonnet', name: 'Sonnet', supportsImageInput: true },
    ],
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ],
    defaultModelId: 'opus',
    defaultModeId: 'default',
    promptCapabilities: { image: true, audio: false, embeddedContext: false },
    updatedAt: 1_700_000_000_000,
  },
} as ProviderCatalogEntry

const SEED: MockSeed = {
  workspaces: [ALPHA, BETA],
  providers: [CLAUDE],
  // The last-used picks the draft is seeded from, per project.
  composerPreferences: {
    [ALPHA.workspaceId]: { claude: { modelId: 'sonnet', modeId: 'plan' } },
  },
  folders: { '/home/me': ['alpha', 'beta', 'gamma'], '/home/me/alpha': [], '/home/me/gamma': [] },
  home: '/home/me',
}

const probe = {} as {
  model: ComposerModel
  projects: ProjectSource
  session: SessionStateValue
  messages: UIMessage[]
  path: string
  /** What the session page shows, once one is in front. */
  page: { phase: string; messages: UIMessage[] } | null
  go: (path: string) => void
  /** The draft cards the home lists, whatever page is in front. */
  drafts: ReturnType<typeof useSidebarDrafts>
}

function DraftsProbe() {
  probe.drafts = useSidebarDrafts()
  return null
}

function Probe() {
  const live = useLiveComposerModel(null)
  probe.model = live.model
  probe.projects = useProjectSource()
  probe.session = useSessionState()
  probe.messages = useActiveThreadState().messages
  return <ThreadBridge port={live.port} />
}

/** The session page's own hook, as `app/session/[externalId].tsx` mounts it. */
function SessionPage({ sessionId }: { sessionId: string }) {
  const view = useReadOnlySession(sessionId)
  probe.page = { phase: view.phase, messages: view.messages }
  return null
}

/**
 * The phone's root over an in-memory address: the navigation the real
 * provider builds (with its `stayed`), a router that moves the address, and
 * the landing read from it; at `/session/<id>`, the session page's hook.
 */
function Host({ client, moves }: { client: MockEnvironmentClient; moves: string[] }) {
  const [path, setPath] = useState<string>(BLANK)
  const [navigation] = useState(() =>
    createPhoneNavigation(
      {
        push: (href) => {
          moves.push(`push ${href}`)
          setPath(href)
        },
        replace: (href) => {
          moves.push(`replace ${href}`)
          setPath(href)
        },
        setParams: (params) => {
          moves.push(`setParams ${JSON.stringify(params)}`)
          setPath(draftHref(E, params.draftId === 'new' ? null : params.draftId!))
        },
      },
      {
        environmentId: E,
        stayed: (sessionId) => {
          moves.push(`stayed ${sessionId}`)
          if (client.getState().activeSessionId === sessionId) client.setActiveSession(null)
        },
      },
    ),
  )
  useLayoutEffect(() => navigation.arrived(path), [navigation, path])
  probe.path = path
  probe.go = setPath
  const landing = landingOf(path)
  const sessionId = sessionOnPath(path)?.sessionId ?? null
  return (
    <EnvironmentClientProvider client={client}>
      <EnvironmentApplicationProviders
        storage={null}
        navigateSession={navigation.navigateSession}
        navigateDraft={navigation.navigateDraft}
        onLanding={landing.onLanding}
        landingDraftId={landing.draftId}
      >
        {landing.onLanding ? <Probe /> : null}
        {sessionId ? <SessionPage key={sessionId} sessionId={sessionId} /> : null}
        <DraftsProbe />
        <DraftDiscardHost environmentId={E} />
      </EnvironmentApplicationProviders>
    </EnvironmentClientProvider>
  )
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const settle = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 8; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}
const callsOf = (client: MockEnvironmentClient, command: string) =>
  client.calls.filter((call) => call.command === command).map((call) => call.input)

async function openLanding(options: Parameters<typeof createMockEnvironmentClient>[0] = {}) {
  const client = createMockEnvironmentClient({
    seed: SEED,
    respond: () => ['On it.'],
    draftSaveDebounceMs: 0,
    ...options,
  })
  // Event replay, as the environment server advertises it: the session page needs it.
  client.setConnection({
    capabilities: [...client.getState().connection.capabilities, 'subscription.replay'],
  })
  const moves: string[] = []
  probe.page = null
  await act(() => root.render(<Host client={client} moves={moves} />))
  await settle(client)
  return { client, moves }
}

describe('a new session from the phone', () => {
  it('opens in the project worked in last, with its last-used picks', async () => {
    const { client } = await openLanding()
    expect(probe.session.isSessionDraftOpen).toBe(true)
    expect(probe.session.activeWorkspacePath).toBe(ALPHA.workspaceId)
    expect(probe.model.picks).toMatchObject({
      providerId: 'claude',
      modelLabel: 'Sonnet',
      mode: { id: 'plan' },
      lockedReason: null,
    })
    // Recents first, as the environment orders them.
    expect(probe.projects.recents.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
    expect(probe.projects.current).toBe(ALPHA.workspaceId)
    expect(probe.model.primary).toMatchObject({ kind: 'send', enabled: false })
    expect(callsOf(client, 'createSession')).toEqual([])
  })

  it('offers the settings and commands the project last listed, as a draft has no chat of its own', async () => {
    const { client } = await openLanding()
    expect(probe.model.settings).toEqual([])
    expect(probe.model.slashCommands).toEqual([])
    await act(() =>
      client.emit({
        type: 'event',
        eventId: 'listing-1',
        timestamp: new Date().toISOString(),
        name: 'composer.listing.updated',
        scope: {
          type: 'environment',
          environmentId: client.getState().environment!.environmentId,
        },
        payload: {
          workspaceId: ALPHA.workspaceId,
          providerId: 'claude',
          sourceSessionId: 'an-earlier-chat',
          configOptions: [{ type: 'boolean', id: 'fast', name: 'Fast mode', currentValue: false }],
          availableCommands: [{ name: 'review', description: 'Review the diff' }],
        },
      } as never),
    )
    await settle(client)
    expect(probe.model.settings.map((option) => option.id)).toEqual(['fast'])
    expect(probe.model.slashCommands.map((command) => command.name)).toEqual(['review'])
  })

  it('creates the session with the draft, echoes the first message, and lands on its page', async () => {
    const { client, moves } = await openLanding({ latencyMs: 30 })
    await act(async () => probe.model.setText('Fix the flaky test'))
    await settle(client)
    // The first text gives the page its draft's address, in place.
    const draftId = probe.session.newSessionDraftId!
    expect(draftId).toBeTruthy()
    expect(moves).toEqual([`setParams {"draftId":"${draftId}"}`])
    expect(probe.path).toBe(draftPage(draftId))
    expect(probe.model.text).toBe('Fix the flaky test')

    // Another project, picked from the sheet: the text goes with it.
    await act(async () => probe.projects.pick(BETA.workspaceId))
    await settle(client)
    expect(probe.session.activeWorkspacePath).toBe(BETA.workspaceId)
    expect(probe.model.text).toBe('Fix the flaky test')

    let echoed: UIMessage[] = []
    await act(async () => {
      pressPrimary(probe.model.primary, { send: probe.model.send, interrupt: () => undefined })
      await new Promise((resolve) => setTimeout(resolve, 5))
      echoed = probe.messages
    })
    // On screen from the send, before the session exists.
    expect(echoed.map((message) => message.optimisticContent)).toEqual(['Fix the flaky test'])
    await settle(client)

    const [created] = callsOf(client, 'createSession') as Array<Record<string, unknown>>
    expect(created).toMatchObject({
      workspaceId: BETA.workspaceId,
      providerId: 'claude',
      firstMessage: 'Fix the flaky test',
      draftId,
    })
    const sessionId = created!.sessionId as string
    expect(client.getState().sessions[sessionId]?.workspaceId).toBe(BETA.workspaceId)
    expect(moves.at(-1)).toBe(`replace ${sessionPage(sessionId)}`)
    expect(probe.path).toBe(sessionPage(sessionId))

    // The session's page opens it, though the launch already made it the
    // client's active one: only an open subscribes it, so the reply arrives.
    const opens = callsOf(client, 'openSession')
    expect(opens).toContain(sessionId)
    await settle(client)
    expect(probe.page?.phase).toBe('ready')
    // The reply's own words, not just its row: the open is what streams them in.
    const replyText = () =>
      Object.values(client.getState().threads)
        .filter((thread) => thread.thread.sessionId === sessionId)
        .flatMap((thread) => thread.messages)
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.content ?? [])
        .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
        .join('')
    await vi.waitFor(async () => {
      await settle(client)
      expect(replyText()).toContain('On it.')
      expect(probe.page!.messages.some((message) => message.role === 'assistant')).toBe(true)
    })
  })

  it('leaves the reader where they went when a launch finishes after they left', async () => {
    const { client, moves } = await openLanding({ latencyMs: 40 })
    await act(async () => probe.model.setText('Start, then go back'))
    await settle(client)
    await act(async () => {
      probe.model.send()
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    // Back to the home while session.create is on its way.
    await act(async () => probe.go('/'))
    await settle(client)
    const [created] = callsOf(client, 'createSession') as Array<Record<string, unknown>>
    const sessionId = created!.sessionId as string
    expect(client.getState().sessions[sessionId]).toBeTruthy()
    expect(probe.path).toBe('/')
    expect(moves.filter((move) => move.startsWith('replace'))).toEqual([])
    expect(moves.at(-1)).toBe(`stayed ${sessionId}`)
    // No page holds it, so the client does not either; the next compose is a fresh page.
    expect(client.getState().activeSessionId).toBeNull()
    await act(async () => probe.go(BLANK))
    await settle(client)
    expect(probe.session.isSessionDraftOpen).toBe(true)
    expect(probe.model.text).toBe('')
  })

  it('keeps the draft when the environment refuses it, text and all', async () => {
    const { client } = await openLanding()
    await act(async () => probe.model.setText('Start here'))
    await settle(client)
    const realCreate = client.commands.createSession
    client.commands.createSession = () => Promise.reject(new Error('The provider is down.'))
    await act(async () => probe.model.send())
    await settle(client)
    client.commands.createSession = realCreate
    expect(probe.model.text).toBe('Start here')
    expect(probe.model.notice).toBe('The provider is down.')
    expect(probe.messages).toEqual([])
    expect(probe.session.isSessionDraftOpen).toBe(true)
  })

  it('adds a browsed folder as a project and moves the draft to it', async () => {
    const { client } = await openLanding()
    const listing = await act(() => probe.projects.browse!())
    // Where the environment starts Add project.
    expect(listing.path).toBe('/home/me')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'gamma'])
    await act(async () => probe.projects.add!('/home/me/gamma'))
    await settle(client)
    expect(callsOf(client, 'addWorkspace')).toEqual([{ path: '/home/me/gamma' }])
    const gamma = probe.projects.workspaces.find((entry) => entry.name === 'gamma')
    expect(gamma).toBeTruthy()
    expect(probe.session.activeWorkspacePath).toBe(gamma!.path)
  })

  it('picks an added project only if nothing was picked while it was added', async () => {
    const { client } = await openLanding({ latencyMs: 30 })
    let adding: Promise<void> = Promise.resolve()
    await act(async () => {
      adding = probe.projects.add!('/home/me/gamma')
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    // A newer choice while the environment answers.
    await act(async () => probe.projects.pick(BETA.workspaceId))
    await act(() => adding)
    await settle(client)
    expect(probe.projects.workspaces.some((entry) => entry.name === 'gamma')).toBe(true)
    expect(probe.session.activeWorkspacePath).toBe(BETA.workspaceId)
  })

  it('keeps a re-pick of the same project made while an add was on its way', async () => {
    const { client } = await openLanding({ latencyMs: 30 })
    let adding: Promise<void> = Promise.resolve()
    await act(async () => {
      adding = probe.projects.add!('/home/me/gamma')
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    await act(async () => probe.projects.pick(ALPHA.workspaceId))
    await act(() => adding)
    await settle(client)
    expect(probe.session.activeWorkspacePath).toBe(ALPHA.workspaceId)
  })

  it('picks the later of two adds, whichever answers first', async () => {
    const { client } = await openLanding({ latencyMs: 30 })
    let first: Promise<void> = Promise.resolve()
    let second: Promise<void> = Promise.resolve()
    await act(async () => {
      first = probe.projects.add!('/home/me/gamma')
      second = probe.projects.add!('/home/me/alpha')
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    await act(() => Promise.all([first, second]))
    await settle(client)
    const added = probe.projects.workspaces.find(
      (entry) => entry.name === 'alpha' && entry.path !== ALPHA.workspaceId,
    )
    expect(probe.projects.workspaces.some((entry) => entry.name === 'gamma')).toBe(true)
    expect(probe.session.activeWorkspacePath).toBe(added!.path)
  })

  it('leaves another draft alone when an add answers after its page went', async () => {
    const { client } = await openLanding({ latencyMs: 30 })
    await act(async () => probe.model.setText('Draft A'))
    await settle(client)
    const draftA = probe.session.newSessionDraftId
    let adding: Promise<void> = Promise.resolve()
    await act(async () => {
      adding = probe.projects.add!('/home/me/gamma')
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    // Back to the home, then a new session: draft B, in the landing project.
    await act(async () => probe.go('/'))
    await act(async () => probe.go(BLANK))
    await act(async () => probe.model.setText('Draft B'))
    await act(() => adding)
    await settle(client)
    expect(probe.session.newSessionDraftId).not.toBe(draftA)
    expect(probe.projects.workspaces.some((entry) => entry.name === 'gamma')).toBe(true)
    expect(probe.session.activeWorkspacePath).toBe(ALPHA.workspaceId)
  })

  it('offers no browser or add where the environment does not', async () => {
    await openLanding({
      capabilities: [
        'getEnvironment',
        'listWorkspaces',
        'getProviderCatalog',
        'createSession',
        'openSession',
      ],
    })
    expect(probe.projects.browse).toBeUndefined()
    expect(probe.projects.add).toBeUndefined()
  })
})

describe('drafts on the phone', () => {
  it('says "Not synced" while an edit cannot reach the environment, and not once it has', async () => {
    const { client } = await openLanding()
    await act(async () => probe.model.setText('Typed on the train'))
    await settle(client)
    expect(probe.model.unsynced).toBeNull()

    await act(async () => client.setConnection({ phase: 'reconnecting' }))
    await act(async () => probe.model.setText('Typed on the train, in a tunnel'))
    expect(probe.model.unsynced).toBe(DRAFT_SYNC_EXPLANATION.offline)

    await act(async () => client.setConnection({ phase: 'connected' }))
    await settle(client)
    expect(probe.model.unsynced).toBeNull()
  })

  it('lists a draft written here once the reader is back on the home, live', async () => {
    const { client } = await openLanding()
    await act(async () => probe.model.setText('First line'))
    await settle(client)
    const draftId = probe.session.newSessionDraftId!
    // On its page the draft has no card yet: it gets one once left.
    expect(probe.drafts?.drafts.map((card) => card.draftId)).toEqual([])

    await act(async () => probe.go('/'))
    await settle(client)
    expect(probe.drafts?.drafts.map((card) => card.draftId)).toEqual([draftId])
    expect(probe.drafts?.drafts[0]?.preview).toBe('First line')
  })

  it('discards the draft on screen once its page has gone back, and brings it back on Undo', async () => {
    const { client, moves } = await openLanding()
    await act(async () => probe.model.setText('Maybe later'))
    await settle(client)
    const draftId = probe.session.newSessionDraftId!

    // The page asks, then goes back: nothing is discarded while it is in front.
    await act(async () => discardHandoff.request({ environmentId: E, draftId }))
    expect(probe.drafts?.pendingDiscard).toBeNull()
    await act(async () => probe.go('/'))
    await settle(client)
    const before = moves.length
    expect(probe.drafts?.pendingDiscard?.draftId).toBe(draftId)
    expect(probe.drafts?.drafts).toEqual([])
    expect(discardHandoff.waiting()).toBeNull()

    await act(async () => probe.drafts!.undoDiscard(probe.drafts!.pendingDiscard!.key))
    await settle(client)
    expect(probe.drafts?.drafts.map((card) => card.draftId)).toEqual([draftId])
    expect(client.getState().drafts[draftId]).toBeTruthy()

    // Discarded from its row, and let go: the draft is deleted, and the
    // reader stays on the home.
    await act(async () => probe.drafts!.discardDraft(draftId))
    await act(async () => probe.drafts!.confirmDiscard())
    await settle(client)
    expect(client.getState().drafts[draftId]).toBeUndefined()
    expect(probe.path).toBe('/')
    expect(moves.slice(before)).toEqual([])
  })
})

describe('why a draft cannot be sent', () => {
  const entry = { path: 'C:/a', name: 'a' } as never
  it('says the project is missing, gone or unavailable, in web’s words', () => {
    expect(
      draftSendBlocked({ activeWorkspacePath: null, isDraftProjectRemoved: false }, undefined),
    ).toBe('Pick a project to start the session')
    expect(
      draftSendBlocked({ activeWorkspacePath: null, isDraftProjectRemoved: true }, undefined),
    ).toMatch(/was removed/)
    expect(
      draftSendBlocked({ activeWorkspacePath: 'C:/a', isDraftProjectRemoved: false }, {
        ...(entry as object),
        missing: true,
      } as never),
    ).toBe('a is unavailable. Pick another project to send this draft.')
    expect(
      draftSendBlocked({ activeWorkspacePath: 'C:/a', isDraftProjectRemoved: false }, entry),
    ).toBeNull()
  })
})
