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
import { ThemeProvider } from '../src/providers/theme-provider'
import { ChatWorkspace } from '../src/components/chat/ChatWorkspace'
import {
  QuickAgentHost,
  QuickAgentPalette,
  requestQuickAgent,
  useQuickAgentOpen,
  type QuickAgentEnvironments,
} from '../src/components/command/QuickAgentPalette'

vi.mock('../src/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
}))

const project = (name: string, extra: Partial<Workspace> = {}): Workspace => ({
  workspaceId: `C:/${name}`,
  name,
  path: `C:/${name}`,
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false },
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
    canSteer: false,
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
    available: true,
    refreshing: false,
    install: 'installed',
    auth: 'authenticated',
    runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
    lastProbe: null,
    update: 'current',
  },
  limits: { supported: false, reading: null, refreshing: false, lastRefresh: null },
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
/** Every navigation the providers asked for. */
let navigations: string[] = []

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // A fresh store per test: Start another is remembered there.
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
    key: (index: number) => [...stored.keys()][index] ?? null,
    get length() {
      return stored.size
    },
  })
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
  vi.unstubAllGlobals()
})

const settle = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 6; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

/** A host with draft pages, on a session, with the palette over it. */
function Host({ client }: { client: MockEnvironmentClient }) {
  const [route, setRoute] = useState<{ sessionId: string } | { draftId: string | null }>({
    sessionId: SESSION.sessionId,
  })
  return (
    <EnvironmentApplicationProviders
      onLanding={'draftId' in route}
      landingDraftId={'draftId' in route ? route.draftId : null}
      navigateSession={async (sessionId) => {
        navigations.push(sessionId ? `/sessions/${sessionId}` : '/')
        setRoute(sessionId ? { sessionId } : { draftId: null })
        if (sessionId) await client.commands.openSession(sessionId).catch(() => undefined)
        else client.setActiveSession(null)
      }}
      navigateDraft={async (draftId) => {
        navigations.push(`/drafts/${draftId}`)
        client.setActiveSession(null)
        setRoute({ draftId })
      }}
    >
      <ChatWorkspace />
      <QuickAgentPalette />
    </EnvironmentApplicationProviders>
  )
}

async function mount(client: MockEnvironmentClient) {
  navigations = []
  await act(() =>
    root.render(
      <ThemeProvider>
        <EnvironmentClientProvider client={client}>
          <Host client={client} />
        </EnvironmentClientProvider>
      </ThemeProvider>,
    ),
  )
  await act(() => client.commands.openSession(SESSION.sessionId))
  await settle(client)
}

const palette = () => document.querySelector<HTMLElement>('[data-quick-agent]')
const paletteField = () => palette()!.querySelector('textarea')!
const pageField = () => container.querySelector('textarea')!
const notice = () => document.querySelector('[role="status"]')?.textContent ?? ''

const press = async (target: EventTarget, key: string, init: Partial<KeyboardEventInit> = {}) => {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init }),
    )
  })
}

const type = async (field: HTMLTextAreaElement, text: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(() => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The draft the palette is writing: the one new-session draft it saved. */
const savedDraft = (client: MockEnvironmentClient) => {
  const [draftId] = selectNewSessionDraftIds(client.getState())
  return draftId
}

describe('quick New agent palette', () => {
  it('opens on N outside a field, in the project on screen, over the page', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    expect(palette()).toBeNull()

    await press(document.body, 'n')
    expect(palette()).not.toBeNull()
    expect(document.activeElement).toBe(paletteField())
    expect(palette()!.textContent).toContain('alpha')
    expect(palette()!.textContent).toContain('New agent')
    // The page underneath is untouched.
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(navigations).toEqual([])
  })

  it('leaves N alone while a field has the keys, and Ctrl+Shift+O opens it from one', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    pageField().focus()
    await press(pageField(), 'n')
    expect(palette()).toBeNull()

    await type(pageField(), 'half a thought')
    await press(pageField(), 'O', { ctrlKey: true, shiftKey: true })
    expect(palette()).not.toBeNull()
    expect(pageField().value).toBe('half a thought')
  })

  it('opens from the command palette', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await act(() => {
      expect(requestQuickAgent()).toBe(true)
    })
    expect(palette()).not.toBeNull()
  })

  it('keeps what was written as a draft on Escape, listed with the rest, and stays on the page', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await press(document.body, 'n')
    await type(paletteField(), 'Add rate limiting')
    await settle(client)

    await press(paletteField(), 'Escape')
    await settle(client)
    expect(palette()).toBeNull()
    const draftId = savedDraft(client)
    expect(draftId).toBeTruthy()
    expect(selectDraftContent(client.getState(), draftId!)?.text).toBe('Add rate limiting')
    expect(selectDraftTarget(client.getState(), draftId!)).toMatchObject({
      type: 'new_session',
      workspaceId: ALPHA.workspaceId,
    })
    expect(client.getState().drafts[draftId!]).toBeDefined()
    expect(notice()).toContain('Saved to drafts in alpha')
    expect(navigations).toEqual([])
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
  })

  it('saves nothing when closed empty', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await press(document.body, 'n')
    await press(paletteField(), 'Escape')
    await settle(client)
    expect(palette()).toBeNull()
    expect(client.getState().draftEdits).toEqual({})
    expect(selectNewSessionDraftIds(client.getState())).toEqual([])
    expect(notice()).not.toContain('Saved')
  })

  it('starts the agent in the background on Enter, and says so', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await press(document.body, 'n')
    await type(paletteField(), 'Write a CONTRIBUTING.md')
    await settle(client)
    const draftId = savedDraft(client)

    await press(paletteField(), 'Enter')
    await settle(client)
    const create = client.calls.find((call) => call.command === 'createSession')
    expect(create?.input).toMatchObject({
      workspaceId: ALPHA.workspaceId,
      firstMessage: 'Write a CONTRIBUTING.md',
      draftId,
    })
    // Sent as a draft: the environment deleted it with the session's creation.
    expect(selectNewSessionDraftIds(client.getState())).toEqual([])
    expect(palette()).toBeNull()
    // Still on the session that was open.
    expect(navigations).toEqual([])
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(notice()).toContain('Agent started in alpha')

    // Open goes to it.
    const sessionId = (create?.input as { sessionId: string }).sessionId
    await act(() => {
      ;[...document.querySelectorAll<HTMLButtonElement>('[role="status"] button')]
        .find((button) => button.textContent === 'Open')!
        .click()
    })
    await settle(client)
    expect(navigations).toEqual([`/sessions/${sessionId}`])
  })

  it('starts it in the project picked, keeping what was written', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await press(document.body, 'n')
    await type(paletteField(), 'Fix the build')
    await settle(client)

    await act(() => {
      palette()!.querySelector<HTMLButtonElement>('button[aria-label^="Project"]')!.click()
    })
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes('beta'),
    )!
    await act(() => {
      option.click()
    })
    await settle(client)
    expect(palette()!.textContent).toContain('beta')
    expect(paletteField().value).toBe('Fix the build')

    await press(paletteField(), 'Enter')
    await settle(client)
    expect(client.calls.find((call) => call.command === 'createSession')?.input).toMatchObject({
      workspaceId: BETA.workspaceId,
      firstMessage: 'Fix the build',
    })
  })

  it('stays open with the text and the reason when the launch is refused', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    vi.spyOn(client.commands, 'createSession').mockRejectedValue(new Error('Refused.'))
    await press(document.body, 'n')
    await type(paletteField(), 'try this')
    await press(paletteField(), 'Enter')
    await settle(client)
    expect(palette()).not.toBeNull()
    expect(paletteField().value).toBe('try this')
    expect(palette()!.textContent).toContain('Refused.')
    expect(navigations).toEqual([])
  })

  it('closes a menu of its own on Escape, not itself', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await press(document.body, 'n')
    await act(() => {
      palette()!.querySelector<HTMLButtonElement>('button[aria-label^="Project"]')!.click()
    })
    expect(palette()!.querySelector('[aria-expanded="true"]')).not.toBeNull()
    await press(document.activeElement ?? document.body, 'Escape')
    expect(palette()).not.toBeNull()
    expect(palette()!.querySelector('[aria-expanded="true"]')).toBeNull()

    await press(paletteField(), 'Escape')
    expect(palette()).toBeNull()
  })

  it('switches to another draft from the Drafts menu, keeping the one it left', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    const saved = 'saved-draft'
    await act(() => {
      client.drafts!.edit(
        saved,
        { type: 'new_session', workspaceId: BETA.workspaceId, sessionId: 'saved-session' },
        { text: 'Tidy the README' },
      )
    })
    await act(() => client.drafts!.flush())
    await settle(client)

    await press(document.body, 'n')
    await type(paletteField(), 'Something new')
    await settle(client)
    const drafts = palette()!.querySelector<HTMLButtonElement>('button[aria-label^="Drafts"]')!
    // The card's own draft is not counted: the other one is.
    expect(drafts.getAttribute('aria-label')).toBe('Drafts: 1 more')

    await act(() => {
      drafts.click()
    })
    const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes('Tidy the README'),
    )!
    expect(row.textContent).toContain('beta')
    await act(() => {
      row.click()
    })
    await settle(client)
    expect(paletteField().value).toBe('Tidy the README')
    expect(palette()!.textContent).toContain('beta')
    // What was being written stays, as a draft of its own.
    const left = selectNewSessionDraftIds(client.getState()).filter((id) => id !== saved)
    expect(left).toHaveLength(1)
    expect(selectDraftContent(client.getState(), left[0]!)?.text).toBe('Something new')
    // The page underneath is untouched.
    expect(navigations).toEqual([])
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)

    // Enter starts the draft that was switched to.
    await press(paletteField(), 'Enter')
    await settle(client)
    expect(client.calls.find((call) => call.command === 'createSession')?.input).toMatchObject({
      workspaceId: BETA.workspaceId,
      firstMessage: 'Tidy the README',
      draftId: saved,
    })
  })

  it('steps through drafts with Alt+] and Alt+[', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await act(() => {
      client.drafts!.edit(
        'first',
        { type: 'new_session', workspaceId: ALPHA.workspaceId, sessionId: 'first-session' },
        { text: 'First draft' },
      )
    })
    await settle(client)
    await press(document.body, 'n')
    await press(paletteField(), ']', { altKey: true, code: 'BracketRight' } as KeyboardEventInit)
    await settle(client)
    expect(paletteField().value).toBe('First draft')
  })

  it('leaves a fresh card after starting one, with Start another on', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await press(document.body, 'n')
    const toggle = palette()!.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(() => {
      toggle.click()
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    await type(paletteField(), 'One of several')
    await press(paletteField(), 'Enter')
    await settle(client)
    expect(client.calls.filter((call) => call.command === 'createSession')).toHaveLength(1)
    expect(notice()).toContain('Agent started in alpha')
    // Still open, empty, in the same project, for the next one.
    expect(palette()).not.toBeNull()
    expect(paletteField().value).toBe('')
    expect(palette()!.textContent).toContain('alpha')
  })
})

describe('quick New agent palette across environments', () => {
  const GAMMA = project('gamma', { lastActivityAt: '2026-10-03T10:00:00.000Z' })

  /** The page on `here`, and a card that can move to `there` without the page moving. */
  function TwoEnvironments({
    here,
    there,
    environments,
  }: {
    here: MockEnvironmentClient
    there: MockEnvironmentClient
    environments: QuickAgentEnvironments
  }) {
    return (
      <QuickAgentHost environments={environments}>
        <EnvironmentClientProvider client={here}>
          <EnvironmentApplicationProviders environmentId="here">
            <QuickAgentPalette environmentId="here" />
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>
        <Elsewhere there={there} />
      </QuickAgentHost>
    )
  }
  function Elsewhere({ there }: { there: MockEnvironmentClient }) {
    const open = useQuickAgentOpen()
    if (open?.environmentId !== 'there') return null
    return (
      <EnvironmentClientProvider client={there}>
        <EnvironmentApplicationProviders environmentId="there">
          <QuickAgentPalette environmentId="there" primary={false} />
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>
    )
  }

  it('moves the draft to another environment, text and all, and starts it there', async () => {
    const here = createMockEnvironmentClient({
      seed: { ...SEED, environment: { environmentId: 'here', name: 'Here' } },
    })
    const there = createMockEnvironmentClient({
      seed: {
        workspaces: [GAMMA],
        providers: [OPENCODE],
        environment: { environmentId: 'there', name: 'There' },
      },
    })
    const carried: string[] = []
    const environments: QuickAgentEnvironments = {
      environments: [
        { environmentId: 'here', label: 'Here', reachable: true },
        { environmentId: 'there', label: 'There', reachable: true },
      ],
      clientOf: (environmentId) => (environmentId === 'there' ? there : here),
      carry: (environmentId, from) => {
        carried.push(`${from.environmentId}->${environmentId}`)
        const text = selectDraftContent(here.getState(), from.draftId)?.text ?? ''
        const copy = { draftId: 'copy', sessionId: 'copy-session', workspaceId: GAMMA.workspaceId }
        there.drafts!.edit(
          copy.draftId,
          { type: 'new_session', workspaceId: copy.workspaceId, sessionId: copy.sessionId },
          { text },
        )
        return copy
      },
      openDraft: () => undefined,
      openSession: () => undefined,
      openNewSession: () => undefined,
    }
    await act(() =>
      root.render(
        <ThemeProvider>
          <TwoEnvironments here={here} there={there} environments={environments} />
        </ThemeProvider>,
      ),
    )
    await settle(here)
    await settle(there)

    await press(document.body, 'n')
    expect(palette()!.textContent).toContain('Here')
    await type(paletteField(), 'Run it over there')
    await settle(here)

    await act(() => {
      palette()!.querySelector<HTMLButtonElement>('button[aria-label^="Environment"]')!.click()
    })
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes('There'),
    )!
    await act(() => {
      option.click()
    })
    await settle(there)
    expect(carried).toEqual(['here->there'])
    expect(document.querySelectorAll('[data-quick-agent]')).toHaveLength(1)
    expect(paletteField().value).toBe('Run it over there')
    expect(palette()!.textContent).toContain('gamma')

    await press(paletteField(), 'Enter')
    await settle(there)
    expect(there.calls.find((call) => call.command === 'createSession')?.input).toMatchObject({
      workspaceId: GAMMA.workspaceId,
      firstMessage: 'Run it over there',
      draftId: 'copy',
    })
    expect(here.calls.some((call) => call.command === 'createSession')).toBe(false)
    expect(notice()).toContain('Agent started in gamma')
  })
})
