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
  status: 'connected',
  environments: [],
  selectedId: null,
  endpoint: null,
  activity: 'active',
} as unknown as PhoneConnectionState
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({
  usePhoneConnection: () => connection,
}))

const { useLiveComposerModel, draftSendBlocked } =
  await import('../src/composer/useLiveComposerModel')
const { ThreadBridge } = await import('../src/composer/thread-port')
const { pressPrimary } = await import('../src/composer/model')
const { useProjectSource } = await import('../src/draft/useProjectSource')
const { useReadOnlySession } = await import('../src/session/useReadOnlySession')
const { landingOf, draftHref, sessionHref } = await import('../src/environment/landing-route')
const { createPhoneNavigation, ARRIVAL_TIMEOUT_MS } = await import('../src/environment/navigation')
const { svgOfDataUrl } = await import('../src/ui/project-icon')

describe('the landing, by address', () => {
  it('reads the blank page, a draft page, and everything else', () => {
    expect(landingOf('/draft/new')).toEqual({ onLanding: true, draftId: null })
    expect(landingOf('/draft/d%201')).toEqual({ onLanding: true, draftId: 'd 1' })
    expect(landingOf('/draft/abc/')).toEqual({ onLanding: true, draftId: 'abc' })
    expect(landingOf('/')).toEqual({ onLanding: false, draftId: null })
    expect(landingOf('/session/s1')).toEqual({ onLanding: false, draftId: null })
    expect(landingOf('/draft/')).toEqual({ onLanding: false, draftId: null })
    expect(landingOf('/draft/a/b')).toEqual({ onLanding: false, draftId: null })
    expect(draftHref(null)).toBe('/draft/new')
    expect(draftHref('d 1')).toBe('/draft/d%201')
    expect(sessionHref('s/1')).toBe('/session/s%2F1')
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
    const navigation = createPhoneNavigation(router)
    navigation.arrived('/draft/new')
    let settled = false
    const claimed = navigation.navigateDraft('d1', { replace: true }).then(() => {
      settled = true
    })
    expect(moves).toEqual(['setParams {"draftId":"d1"}'])
    await Promise.resolve()
    expect(settled).toBe(false)
    navigation.arrived('/draft/d1')
    await claimed
    expect(settled).toBe(true)
  })

  it('replaces the draft page with its session, and pushes from anywhere else', async () => {
    const { moves, router } = fakeRouter()
    const navigation = createPhoneNavigation(router)
    navigation.arrived('/draft/d1')
    const sent = navigation.navigateSession('s1', { replace: true })
    navigation.arrived('/session/s1')
    await sent
    const blank = navigation.navigateSession(null)
    navigation.arrived('/draft/new')
    await blank
    const draft = navigation.navigateDraft('d2')
    navigation.arrived('/draft/d2')
    await draft
    expect(moves).toEqual(['replace /session/s1', 'push /draft/new', 'push /draft/d2'])
  })

  it('a blank page asked for on a draft page is that page, and nothing moves to where it is', async () => {
    const { moves, router } = fakeRouter()
    const navigation = createPhoneNavigation(router)
    navigation.arrived('/draft/d1')
    const blank = navigation.navigateSession(null, { replace: true })
    navigation.arrived('/draft/new')
    await blank
    await navigation.navigateDraft('d1', { replace: true }).catch(() => undefined)
    expect(moves[0]).toBe('setParams {"draftId":"new"}')
    // Already there: answered at once, with no second move.
    navigation.arrived('/draft/d1')
    await navigation.navigateDraft('d1')
    expect(moves).toHaveLength(2)
  })

  it('opens no session in place of a page the reader has left', async () => {
    const { moves, router } = fakeRouter()
    const stayed: string[] = []
    const navigation = createPhoneNavigation(router, { stayed: (id) => stayed.push(id) })
    navigation.arrived('/')
    await navigation.navigateSession('s1', { replace: true })
    expect(moves).toEqual([])
    expect(stayed).toEqual(['s1'])
    // Asked for outright (not in a page's place), it still opens.
    const pushed = navigation.navigateSession('s2')
    navigation.arrived('/session/s2')
    await pushed
    expect(moves).toEqual(['push /session/s2'])
  })

  it('settles a navigation the address never reaches', async () => {
    vi.useFakeTimers()
    try {
      const { router } = fakeRouter()
      const navigation = createPhoneNavigation(router)
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
  folders: { '/home/me': ['alpha', 'beta', 'gamma'], '/home/me/gamma': [] },
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
  const [path, setPath] = useState('/draft/new')
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
          setPath(draftHref(params.draftId === 'new' ? null : params.draftId!))
        },
      },
      {
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
  const sessionId = path.startsWith('/session/')
    ? decodeURIComponent(path.slice('/session/'.length))
    : null
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
    expect(probe.model.project).toEqual({
      name: 'alpha',
      workspaceId: ALPHA.workspaceId,
      pickable: true,
    })
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

  it('creates the session with the draft, echoes the first message, and lands on its page', async () => {
    const { client, moves } = await openLanding({ latencyMs: 30 })
    await act(async () => probe.model.setText('Fix the flaky test'))
    await settle(client)
    // The first text gives the page its draft's address, in place.
    const draftId = probe.session.newSessionDraftId!
    expect(draftId).toBeTruthy()
    expect(moves).toEqual([`setParams {"draftId":"${draftId}"}`])
    expect(probe.path).toBe(`/draft/${draftId}`)
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
    expect(moves.at(-1)).toBe(`replace /session/${sessionId}`)
    expect(probe.path).toBe(`/session/${sessionId}`)

    // The session's page opens it, though the launch already made it the
    // client's active one: only an open subscribes it, so the reply arrives.
    const opens = callsOf(client, 'openSession')
    expect(opens).toContain(sessionId)
    await settle(client)
    expect(probe.page?.phase).toBe('ready')
    const replies = () =>
      probe.page!.messages.filter((message) => message.role === 'assistant').length
    await vi.waitFor(async () => {
      await settle(client)
      expect(replies()).toBeGreaterThan(0)
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
    await act(async () => probe.go('/draft/new'))
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
    expect(probe.model.project?.name).toBe('gamma')
  })

  it('offers no browser or add where the environment does not', async () => {
    await openLanding({
      capabilities: [
        'getEnvironment',
        'listWorkspaces',
        'listSessions',
        'getProviderCatalog',
        'createSession',
        'openSession',
      ],
    })
    expect(probe.projects.browse).toBeUndefined()
    expect(probe.projects.add).toBeUndefined()
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
