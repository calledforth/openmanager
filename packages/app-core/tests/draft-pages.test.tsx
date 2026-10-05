// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  selectDraftContent,
  selectDraftTarget,
  selectNewSessionDraftIds,
  type MockEnvironmentClient,
  type MockSeed,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'
import type { Workspace } from '@openmanager/protocol'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import { useActiveThreadState } from '../src/providers/active-thread-provider'
import { useComposerState, type ComposerStateValue } from '../src/providers/composer-provider'
import { useSessionState, type SessionStateValue } from '../src/providers/session-provider'
import { ThemeProvider } from '../src/providers/theme-provider'
import { rememberSentDraft } from '../src/providers/draft-pages'
import { ChatWorkspace } from '../src/components/chat/ChatWorkspace'

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

const OPENCODE: ProviderCatalogEntry = {
  id: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canListSessions: true,
    canCancelPrompt: true,
    supportsPlans: false,
    supportsAvailableCommands: false,
    supportsUsage: false,
    supportsPermissionRequests: true,
    supportsAuthentication: false,
    supportsThoughtStreaming: false,
    supportsSubtasks: false,
    supportsExtensions: false,
    supportsQuestions: false,
  },
  health: {
    summary: 'ready',
    refreshing: false,
    install: 'installed',
    auth: 'authenticated',
    runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
    lastProbe: null,
    update: 'current',
  },
  profile: {
    providerId: 'opencode',
    availableModels: [
      { modelId: 'sonnet', name: 'Sonnet' },
      { modelId: 'opus', name: 'Opus' },
    ],
    availableModes: [
      { id: 'build', name: 'Build' },
      { id: 'plan', name: 'Plan' },
    ],
    defaultModelId: 'sonnet',
    defaultModeId: 'build',
    updatedAt: 1_700_000_000_000,
  },
}

const SEED: MockSeed = {
  workspaces: [ALPHA, BETA],
  providers: [OPENCODE],
  composerPreferences: {
    [ALPHA.workspaceId]: { opencode: { modelId: 'opus' } },
    [BETA.workspaceId]: { opencode: { modelId: 'sonnet' } },
  },
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
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  globalThis.localStorage?.clear()
  vi.unstubAllGlobals()
})

const settle = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 6; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

/** Where a host with draft pages is: `/`, `/drafts/<id>` or `/sessions/<id>`. */
type Route = { draftId: string | null } | { sessionId: string }
const pathOf = (route: Route) =>
  'sessionId' in route
    ? `/sessions/${route.sessionId}`
    : route.draftId
      ? `/drafts/${route.draftId}`
      : '/'

const probe = {} as {
  session: SessionStateValue
  composer: ComposerStateValue
  thread: ReturnType<typeof useActiveThreadState>
  route: Route
  go: (route: Route) => void
}
/** Every navigation the providers asked for, as `push /path` or `replace /path`. */
let navigations: string[] = []

function Capture() {
  probe.session = useSessionState()
  probe.composer = useComposerState()
  probe.thread = useActiveThreadState()
  return null
}

/** A host with draft pages over an in-memory address, opening sessions as the web does. */
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
      <ChatWorkspace />
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
const contentOf = (client: MockEnvironmentClient, draftId: string) =>
  selectDraftContent(client.getState(), draftId)

describe('draft pages', () => {
  it('opens `/` blank, and gives the draft its address on the first character without a new composer', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
    await mount(client)
    const draftId = probe.session.newSessionDraftId!
    expect(draftId).toBeTruthy()
    expect(probe.session.activeWorkspacePath).toBe(ALPHA.workspaceId)
    // Nothing is saved, and the address stays `/`, for a blank page.
    expect(client.getState().draftEdits).toEqual({})
    expect(navigations).toEqual([])

    const textarea = composer()
    textarea.focus()
    await type('h')
    await settle(client)
    // The address changed in place: replaced, not pushed.
    expect(navigations).toEqual([`replace /drafts/${draftId}`])
    expect(pathOf(probe.route)).toBe(`/drafts/${draftId}`)
    expect(probe.session.newSessionDraftId).toBe(draftId)
    // The same composer, still focused, with what was typed.
    expect(composer()).toBe(textarea)
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe('h')
    expect(contentOf(client, draftId)?.text).toBe('h')

    await type('hello')
    expect(navigations).toHaveLength(1)
  })

  it('keeps a model or mode pick on the page without saving a draft or giving it an address', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await act(() => probe.composer.setDraftModel('sonnet'))
    await act(() => probe.composer.setDraftMode('plan'))
    await settle(client)
    expect(probe.composer.draftSessionState).toMatchObject({
      models: { currentModelId: 'sonnet' },
      modes: { currentModeId: 'plan' },
    })
    expect(navigations).toEqual([])
    expect(client.getState().draftEdits).toEqual({})
    expect(client.calls.map((call) => call.command)).not.toContain('setComposerPreference')

    // The first text saves the draft with them.
    await type('plan it')
    act(() => client.drafts!.flush())
    await settle(client)
    expect(contentOf(client, probe.session.newSessionDraftId!)).toEqual({
      text: 'plan it',
      providerId: 'opencode',
      preference: { modelId: 'sonnet', modeId: 'plan' },
    })
  })

  it('opens several drafts one after another, each back intact by its address', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    // New agent on an empty page leaves nothing behind.
    await act(() => probe.session.createSession(ALPHA.workspaceId))
    await act(() => probe.session.createSession(ALPHA.workspaceId))
    await settle(client)
    expect(client.getState().draftEdits).toEqual({})
    expect(selectNewSessionDraftIds(client.getState())).toEqual([])

    await type('first draft')
    const first = probe.session.newSessionDraftId!
    await act(() => probe.session.createSession(BETA.workspaceId))
    await settle(client)
    // A blank page in the project asked for.
    expect(pathOf(probe.route)).toBe('/')
    expect(probe.session.newSessionDraftId).not.toBe(first)
    expect(probe.session.activeWorkspacePath).toBe(BETA.workspaceId)
    expect(composer().value).toBe('')

    await type('second draft')
    const second = probe.session.newSessionDraftId!
    act(() => client.drafts!.flush())
    await settle(client)
    expect(selectNewSessionDraftIds(client.getState()).sort()).toEqual([first, second].sort())

    // Back to the first by its address: its text, its project.
    await act(() => probe.go({ draftId: first }))
    await settle(client)
    expect(probe.session.newSessionDraftId).toBe(first)
    expect(probe.session.activeWorkspacePath).toBe(ALPHA.workspaceId)
    expect(composer().value).toBe('first draft')
    await act(() => probe.go({ draftId: second }))
    await settle(client)
    expect(composer().value).toBe('second draft')
    expect(probe.session.activeWorkspacePath).toBe(BETA.workspaceId)

    // `/` is blank again, and does not reopen either of them.
    await act(() => probe.go({ draftId: null }))
    await settle(client)
    expect(composer().value).toBe('')
    expect([first, second]).not.toContain(probe.session.newSessionDraftId)
  })

  it('moves a draft to another project with its text and explicit picks; seeded picks follow the project', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    // Seeded from ALPHA's last-used model.
    expect(probe.composer.draftSessionState?.models?.currentModelId).toBe('opus')
    await act(() => probe.composer.setDraftMode('plan'))
    await type('keep me')
    const draftId = probe.session.newSessionDraftId!

    await act(() => probe.session.setDraftWorkspace!(BETA.workspaceId))
    await settle(client)
    expect(probe.session.newSessionDraftId).toBe(draftId)
    expect(probe.session.activeWorkspacePath).toBe(BETA.workspaceId)
    expect(composer().value).toBe('keep me')
    expect(probe.composer.draftSessionState).toMatchObject({
      // Seeded: now BETA's.
      models: { currentModelId: 'sonnet' },
      // Picked: kept.
      modes: { currentModeId: 'plan' },
    })
    expect(selectDraftTarget(client.getState(), draftId)).toMatchObject({
      workspaceId: BETA.workspaceId,
    })
    // The address is the same draft's.
    expect(pathOf(probe.route)).toBe(`/drafts/${draftId}`)

    // Sent from where it is now, as the session minted with it.
    const sessionId = (selectDraftTarget(client.getState(), draftId) as { sessionId: string })
      .sessionId
    await act(() => probe.thread.sendMessage('keep me'))
    await settle(client)
    expect(client.calls.find((call) => call.command === 'createSession')?.input).toMatchObject({
      workspaceId: BETA.workspaceId,
      draftId,
      sessionId,
      modeId: 'plan',
    })
    // The session takes the draft's place in the history.
    expect(navigations.at(-1)).toBe(`replace /sessions/${sessionId}`)
    expect(client.getState().activeSessionId).toBe(sessionId)
  })

  it('leaves the draft as it was when its send fails', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await type('try this')
    const draftId = probe.session.newSessionDraftId!
    vi.spyOn(client.commands, 'createSession').mockRejectedValue(new Error('Refused.'))
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(),
    )
    await settle(client)
    expect(pathOf(probe.route)).toBe(`/drafts/${draftId}`)
    expect(probe.session.newSessionDraftId).toBe(draftId)
    expect(composer().value).toBe('try this')
  })

  it('opens a draft named by its address, in its own project', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    const target = {
      type: 'new_session' as const,
      workspaceId: BETA.workspaceId,
      sessionId: 'later',
    }
    await client.commands.saveDraft({
      draftId: 'saved',
      baseRevision: 0,
      target,
      content: { text: 'from another device' },
    })
    await mount(client, { draftId: 'saved' })
    expect(probe.session.isDraftLoading).toBe(false)
    expect(probe.session.newSessionDraftId).toBe('saved')
    expect(probe.session.activeWorkspacePath).toBe(BETA.workspaceId)
    expect(composer().value).toBe('from another device')

    // Cleared, so the environment's copy goes: the page stays where it is.
    await type('')
    act(() => client.drafts!.flush())
    await settle(client)
    expect(client.getState().drafts.saved).toBeUndefined()
    expect(navigations).toEqual([])
    expect(probe.session.newSessionDraftId).toBe('saved')
    await type('second thoughts')
    act(() => client.drafts!.flush())
    await settle(client)
    expect(selectDraftTarget(client.getState(), 'saved')).toMatchObject({
      workspaceId: BETA.workspaceId,
      sessionId: 'later',
    })
  })

  it('waits for the listing before falling back to a blank page for an address it cannot place', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    // Not listed yet: the draft may still arrive, so no blank composer stands in for it.
    act(() => client.disconnect())
    await mount(client, { draftId: 'never-heard-of' })
    expect(client.getState().draftsListed).toBe(false)
    expect(probe.session.isDraftLoading).toBe(true)
    expect(probe.session.isSessionDraftOpen).toBe(false)
    expect(container.querySelector('textarea')?.value ?? '').toBe('')
    expect(container.textContent).toContain('Opening your workspace')
    expect(navigations).toEqual([])

    act(() => client.connect())
    await settle(client)
    expect(navigations).toEqual(['replace /'])
    expect(probe.session.isSessionDraftOpen).toBe(true)
    expect(probe.session.newSessionDraftId).not.toBe('never-heard-of')
    expect(composer().value).toBe('')
  })

  it('leads the address of a draft sent from here to its session', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    rememberSentDraft('sent-draft', SESSION.sessionId)
    await mount(client, { draftId: 'sent-draft' })
    expect(navigations).toEqual([`replace /sessions/${SESSION.sessionId}`])
    await settle(client)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
  })

  it('keeps a draft whose project was removed, and lets another project take it', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await client.commands.saveDraft({
      draftId: 'orphan',
      baseRevision: 0,
      target: { type: 'new_session', workspaceId: null, sessionId: 'orphan-session' },
      content: { text: 'still here' },
    })
    await mount(client, { draftId: 'orphan' })
    expect(probe.session.isSessionDraftOpen).toBe(true)
    expect(probe.session.activeWorkspacePath).toBeNull()
    expect(container.textContent).toContain('This draft’s project was removed')
    expect(composer().value).toBe('still here')

    await act(() => probe.session.setDraftWorkspace!(ALPHA.workspaceId))
    await settle(client)
    expect(probe.session.activeWorkspacePath).toBe(ALPHA.workspaceId)
    expect(selectDraftTarget(client.getState(), 'orphan')).toMatchObject({
      workspaceId: ALPHA.workspaceId,
      sessionId: 'orphan-session',
    })
    expect(composer().disabled).toBe(false)
  })

  it('keeps a pick whose provider is down, and holds the send with the reason', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        ...SEED,
        providers: [
          {
            ...OPENCODE,
            health: {
              ...OPENCODE.health,
              summary: 'error',
              install: 'missing',
              runtime: { state: 'stopped', liveProcesses: 0, activeTurns: 0 },
              // A reading with nothing running only counts while its probe is fresh.
              lastProbe: { outcome: 'failed', at: new Date().toISOString(), durationMs: 5 },
            },
          },
        ],
      },
    })
    await client.commands.saveDraft({
      draftId: 'picked',
      baseRevision: 0,
      target: { type: 'new_session', workspaceId: ALPHA.workspaceId, sessionId: 'picked-session' },
      content: { text: 'wait for it', providerId: 'opencode', preference: { modelId: 'sonnet' } },
    })
    await mount(client, { draftId: 'picked' })
    expect(probe.composer.draftSessionState).toMatchObject({
      providerId: 'opencode',
      models: { currentModelId: 'sonnet' },
    })
    expect(container.textContent).toContain('OpenCode is unavailable')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(
      true,
    )
  })
})
