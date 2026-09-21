// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  EnvironmentClientError,
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  WIRE_COMMANDS,
  type EnvironmentCommandName,
  type MockSeed,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import { useActiveThreadState } from '../src/providers/active-thread-provider'
import { useComposerState, type ComposerStateValue } from '../src/providers/composer-provider'
import { useSessionState, type SessionStateValue } from '../src/providers/session-provider'
import { MockEnvironmentApp } from '../src/testing/mock-environment-app'

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['opencode', 'cursor', 'claude'] },
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const SIBLING = { sessionId: 'session-2', workspaceId: WORKSPACE.workspaceId, title: 'Second' }

const READY = {
  summary: 'ready',
  refreshing: false,
  install: 'installed',
  auth: 'authenticated',
  runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
  lastProbe: null,
  update: 'current',
} as const
const CAPABILITIES = {
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
}
const OPENCODE: ProviderCatalogEntry = {
  id: 'opencode',
  displayName: 'OpenCode',
  capabilities: CAPABILITIES,
  health: READY,
  profile: {
    providerId: 'opencode',
    availableModels: [
      { modelId: 'sonnet', name: 'Sonnet' },
      { modelId: 'opus', name: 'Opus', effortLevels: ['low', 'high'] },
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
const CURSOR: ProviderCatalogEntry = {
  id: 'cursor',
  displayName: 'Cursor',
  capabilities: CAPABILITIES,
  health: READY,
  profile: {
    providerId: 'cursor',
    availableModels: [{ modelId: 'composer', name: 'Composer' }],
    updatedAt: 1_700_000_000_000,
  },
}
const BROKEN_CLAUDE: ProviderCatalogEntry = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: CAPABILITIES,
  health: {
    ...READY,
    summary: 'error',
    install: 'missing',
    runtime: { state: 'stopped', liveProcesses: 0, activeTurns: 0 },
    // A reading with nothing running only counts while its probe is fresh.
    lastProbe: { outcome: 'failed', at: new Date().toISOString(), durationMs: 5 },
  },
  profile: {
    providerId: 'claude',
    availableModels: [{ modelId: 'default', name: 'Default' }],
    updatedAt: 1_700_000_000_000,
  },
}

const SEED: MockSeed = {
  workspaces: [WORKSPACE],
  providers: [OPENCODE, CURSOR, BROKEN_CLAUDE],
  sessions: [
    {
      session: SESSION,
      providerId: 'opencode',
      threads: [{ threadId: 't1', sessionId: SESSION.sessionId }],
    },
    {
      session: SIBLING,
      providerId: 'opencode',
      threads: [{ threadId: 't2', sessionId: SIBLING.sessionId }],
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

type Probe = {
  composer: ComposerStateValue
  session: SessionStateValue
  thread: ReturnType<typeof useActiveThreadState>
}
const probe = {} as Probe
function Capture() {
  probe.composer = useComposerState()
  probe.session = useSessionState()
  probe.thread = useActiveThreadState()
  return null
}

async function mount(client: MockEnvironmentClient) {
  await act(() =>
    root.render(
      <EnvironmentClientProvider client={client}>
        <EnvironmentApplicationProviders collapsedWorkspaceStorage={null}>
          <Capture />
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>,
    ),
  )
  await settle(client)
}

const openDraft = async (client: MockEnvironmentClient) => {
  await act(() => probe.session.createSession(WORKSPACE.workspaceId))
  await settle(client)
}
const commandsOf = (client: MockEnvironmentClient) => client.calls.map((call) => call.command)
const inputOf = (client: MockEnvironmentClient, command: string) =>
  client.calls.find((call) => call.command === command)?.input

describe('the composer over the environment client', () => {
  it('publishes catalogs from the client and the draft resolves to the profile defaults', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    expect(Object.keys(probe.composer.providerComposerProfiles)).toEqual([
      'opencode',
      'cursor',
      'claude',
    ])
    expect(probe.composer.draftSessionState).toBeNull()

    await openDraft(client)
    expect(probe.composer.draftSessionState).toMatchObject({
      providerId: 'opencode',
      models: { currentModelId: 'sonnet' },
      modes: { currentModeId: 'build' },
    })
    expect(probe.composer.draftSessionState?.models?.availableModels).toHaveLength(2)
    // The workspace's last-used preference is read for the draft it seeds.
    expect(inputOf(client, 'getComposerPreference')).toEqual({
      workspaceId: WORKSPACE.workspaceId,
      providerId: 'opencode',
    })
  })

  it('opens a draft on what the workspace last used', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        ...SEED,
        composerPreferences: {
          [WORKSPACE.workspaceId]: {
            opencode: { modelId: 'opus', configValues: { effort: 'high' } },
          },
        },
      },
    })
    await mount(client)
    await openDraft(client)
    expect(probe.composer.draftSessionState?.models?.currentModelId).toBe('opus')
    expect(probe.composer.composerConfigValues).toEqual({ effort: 'high' })
  })

  it('files a draft pick as the workspace preference when it is made', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await openDraft(client)

    await act(() => probe.composer.setDraftModel('opus'))
    await act(() => probe.composer.setDraftConfigOption('effort', 'high'))
    await act(() => probe.composer.setDraftConfigOption('fast', true))
    await act(() => probe.composer.setDraftMode('plan'))
    await settle(client)
    const filed = client.calls
      .filter((call) => call.command === 'setComposerPreference')
      .map((call) => call.input)
    const target = { workspaceId: WORKSPACE.workspaceId, providerId: 'opencode' }
    expect(filed).toEqual([
      { ...target, preference: { modelId: 'opus' } },
      { ...target, preference: { configValues: { effort: 'high' } } },
      // The values are replaced as a whole, so earlier ones ride along.
      { ...target, preference: { configValues: { effort: 'high', fast: true } } },
      { ...target, preference: { modeId: 'plan' } },
    ])

    // Never sent, and already what the workspace remembers.
    expect(probe.composer.sessionLaunchPreferences(WORKSPACE.workspaceId, 'opencode')).toEqual({
      preferredConfigValues: { effort: 'high', fast: true },
    })
  })

  it('shows a pick that could not be filed and keeps it for the launch', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await openDraft(client)
    vi.spyOn(client.commands, 'setComposerPreference').mockRejectedValue(
      new EnvironmentClientError('unavailable', 'Preference refused.'),
    )
    await act(() => probe.composer.setDraftModel('opus'))
    await settle(client)
    expect(probe.composer.error).toBe('Preference refused.')
    expect(probe.composer.draftSessionState?.models?.currentModelId).toBe('opus')
  })

  it('opens a draft on the provider the workspace last ran', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        ...SEED,
        sessions: [
          ...SEED.sessions!,
          {
            session: {
              sessionId: 'session-3',
              workspaceId: WORKSPACE.workspaceId,
              title: 'Latest',
            },
            providerId: 'cursor',
            updatedAt: '2999-01-01T00:00:00.000Z',
            threads: [{ threadId: 't3', sessionId: 'session-3' }],
          },
        ],
      },
    })
    await mount(client)
    await openDraft(client)
    expect(probe.composer.draftSessionState?.providerId).toBe('cursor')
    expect(probe.composer.draftLaunchPreferences(WORKSPACE.workspaceId).providerId).toBe('cursor')

    // A pick made here outranks it.
    await act(() => probe.composer.setDraftProvider('opencode'))
    expect(probe.composer.draftSessionState?.providerId).toBe('opencode')
  })

  it('holds draft picks locally and launches the session with them', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await openDraft(client)

    await act(() => probe.composer.setDraftProvider('cursor', 'composer'))
    expect(probe.composer.draftSessionState).toMatchObject({
      providerId: 'cursor',
      models: { currentModelId: 'composer' },
    })
    await act(() => probe.composer.setDraftProvider('opencode'))
    await act(() => probe.composer.setDraftModel('opus'))
    await act(() => probe.composer.setDraftConfigOption('effort', 'high'))
    expect(probe.composer.draftSessionState?.models?.currentModelId).toBe('opus')
    expect(probe.composer.composerConfigValues).toEqual({ effort: 'high' })
    expect(probe.composer.draftLaunchPreferences(WORKSPACE.workspaceId)).toEqual({
      providerId: 'opencode',
      preferredModelId: 'opus',
      preferredModeId: 'build',
      preferredConfigValues: { effort: 'high' },
    })

    await act(() => probe.thread.sendMessage('hello'))
    await settle(client)
    const commands = commandsOf(client)
    // Filed once more at launch, whole, right before the session is created.
    expect(commands.lastIndexOf('setComposerPreference')).toBe(
      commands.indexOf('createSession') - 1,
    )
    expect(
      client.calls.filter((call) => call.command === 'setComposerPreference').at(-1)?.input,
    ).toEqual({
      workspaceId: WORKSPACE.workspaceId,
      providerId: 'opencode',
      preference: { modelId: 'opus', configValues: { effort: 'high' } },
    })
    expect(inputOf(client, 'createSession')).toMatchObject({
      providerId: 'opencode',
      firstMessage: 'hello',
    })
    expect(commands).not.toContain('setSessionMode')

    // The picks are filed now. A later draft follows what the workspace
    // remembers by then, not what this one held.
    client.emit({
      type: 'event',
      eventId: 'preference-moved-on',
      timestamp: new Date().toISOString(),
      name: 'composer.preferences.updated',
      scope: { type: 'environment', environmentId: 'mock-environment' },
      payload: {
        workspaceId: WORKSPACE.workspaceId,
        providerId: 'opencode',
        preference: { modelId: 'sonnet' },
      },
    })
    await openDraft(client)
    expect(probe.composer.draftSessionState?.models?.currentModelId).toBe('sonnet')
    expect(probe.composer.composerConfigValues).toEqual({})
  })

  it('keeps the picks of a newer draft opened while an earlier one was launching', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await openDraft(client)
    await act(() => probe.composer.setDraftModel('opus'))

    let sending!: Promise<void>
    await act(() => {
      sending = probe.thread.sendMessage('hello')
    })
    await act(() => probe.session.createSession(WORKSPACE.workspaceId))
    await act(() => probe.composer.setDraftConfigOption('effort', 'high'))
    await settle(client)
    await act(() => sending)

    expect(commandsOf(client)).toContain('createSession')
    expect(probe.session.isSessionDraftOpen).toBe(true)
    expect(probe.composer.composerConfigValues).toEqual({ effort: 'high' })
  })

  it('refuses picks the environment could not launch with', async () => {
    const limited = (Object.keys(WIRE_COMMANDS) as EnvironmentCommandName[]).filter(
      (command) => command !== 'setComposerPreference' && command !== 'setSessionMode',
    )
    const client = createMockEnvironmentClient({
      capabilities: limited,
      seed: {
        ...SEED,
        composerPreferences: { [WORKSPACE.workspaceId]: { opencode: { modeId: 'plan' } } },
      },
    })
    await mount(client)
    await openDraft(client)
    // A remembered mode cannot be applied here, so the draft does not claim it.
    expect(probe.composer.draftSessionState?.modes?.currentModeId).toBe('build')

    await act(() => probe.composer.setDraftModel('opus'))
    expect(probe.composer.error).toBe('This environment cannot change that for a new chat.')
    expect(probe.composer.draftSessionState?.models?.currentModelId).toBe('sonnet')
    await act(() => probe.composer.setDraftMode('plan'))
    expect(probe.composer.draftSessionState?.modes?.currentModeId).toBe('build')

    // What is shown is what runs: one plain create on the provider's defaults.
    await act(() => probe.thread.sendMessage('hello'))
    await settle(client)
    expect(inputOf(client, 'createSession')).toMatchObject({ firstMessage: 'hello' })
    expect(commandsOf(client)).not.toContain('sendTurn')
  })

  it('switches a new session into the picked mode before its first prompt', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await openDraft(client)
    await act(() => probe.composer.setDraftMode('plan'))
    expect(probe.composer.draftSessionState?.modes?.currentModeId).toBe('plan')

    await act(() => probe.thread.sendMessage('plan this'))
    await settle(client)
    const commands = commandsOf(client)
    expect(inputOf(client, 'createSession')).not.toHaveProperty('firstMessage')
    expect(commands.indexOf('createSession')).toBeLessThan(commands.indexOf('setSessionMode'))
    expect(commands.indexOf('setSessionMode')).toBeLessThan(commands.indexOf('sendTurn'))
    expect(inputOf(client, 'sendTurn')).toMatchObject({ text: 'plan this' })
    const sessionId = client.getState().activeSessionId!
    expect(client.getState().sessions[sessionId]?.composer?.modeId).toBe('plan')
  })

  it('does not prompt in the wrong mode when the switch fails', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await openDraft(client)
    await act(() => probe.composer.setDraftMode('plan'))
    const setSessionMode = vi
      .spyOn(client.commands, 'setSessionMode')
      .mockRejectedValue(new EnvironmentClientError('unavailable', 'Mode switch refused.'))

    let failure: unknown
    await act(() => probe.thread.sendMessage('plan this').catch((err) => (failure = err)))
    await settle(client)
    expect(setSessionMode).toHaveBeenCalled()
    expect((failure as Error).message).toBe('Mode switch refused.')
    expect(commandsOf(client)).toContain('deleteSession')
    expect(commandsOf(client)).not.toContain('sendTurn')
    expect(probe.session.isSessionDraftOpen).toBe(true)
  })

  it('refuses a provider known to be broken', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await openDraft(client)
    await act(() => probe.composer.setDraftProvider('claude'))
    expect(probe.composer.draftSessionState?.providerId).toBe('opencode')
    expect(probe.composer.error).toBe('Claude Code is unavailable. Retry it from Settings.')
    // A pick that works clears the failure.
    await act(() => probe.composer.setDraftProvider('cursor'))
    expect(probe.composer.error).toBeNull()
  })

  it('changes one session through the environment and follows what it pushes', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await act(() => probe.session.selectSession(WORKSPACE.workspaceId, SESSION.sessionId))
    await settle(client)
    expect(probe.composer.acpSessionState).toMatchObject({
      sessionId: SESSION.sessionId,
      providerId: 'opencode',
      models: { currentModelId: 'sonnet' },
    })

    await act(() => probe.composer.setSessionModel(SESSION.sessionId, 'opus'))
    await act(() => probe.composer.setSessionMode(SESSION.sessionId, 'plan'))
    await act(() => probe.composer.setSessionConfigOption(SESSION.sessionId, 'effort', 'high'))
    await settle(client)
    expect(probe.composer.acpSessionState).toMatchObject({
      models: { currentModelId: 'opus' },
      modes: { currentModeId: 'plan' },
    })
    expect(probe.composer.composerConfigValues).toEqual({ effort: 'high' })

    // The sibling keeps its own model even though the workspace now
    // remembers `opus` as last used.
    client.emit({
      type: 'event',
      eventId: 'sibling-composer',
      timestamp: new Date().toISOString(),
      name: 'session.composer.updated',
      scope: { type: 'environment', environmentId: 'mock-environment' },
      payload: { sessionId: SIBLING.sessionId, composer: { modelId: 'sonnet' } },
    })
    await act(() => probe.session.selectSession(WORKSPACE.workspaceId, SIBLING.sessionId))
    await settle(client)
    expect(client.getState().composerPreferences[WORKSPACE.workspaceId]?.opencode?.modelId).toBe(
      'opus',
    )
    expect(probe.composer.acpSessionState?.models?.currentModelId).toBe('sonnet')
  })

  it('lists the slash commands a session reports, and lends them to a draft', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    await act(() => probe.session.selectSession(WORKSPACE.workspaceId, SESSION.sessionId))
    await settle(client)
    expect(probe.composer.acpSessionState?.availableCommands).toBeUndefined()

    client.emit({
      type: 'event',
      eventId: 'session-commands',
      timestamp: new Date().toISOString(),
      name: 'session.composer.updated',
      scope: { type: 'environment', environmentId: 'mock-environment' },
      payload: {
        sessionId: SESSION.sessionId,
        composer: {
          modelId: 'opus',
          availableCommands: [
            { name: 'review', description: 'Review the diff' },
            { name: 'search', description: 'Search', placeholder: 'query' },
          ],
        },
      },
    })
    await settle(client)
    expect(probe.composer.acpSessionState?.availableCommands).toEqual([
      { name: 'review', description: 'Review the diff' },
      {
        name: 'search',
        description: 'Search',
        input: { type: 'unstructured', placeholder: 'query' },
      },
    ])
    // The sibling has reported none of its own.
    await act(() => probe.session.selectSession(WORKSPACE.workspaceId, SIBLING.sessionId))
    await settle(client)
    expect(probe.composer.acpSessionState?.availableCommands).toBeUndefined()

    // A draft has no session yet, so it offers what the provider listed last.
    await openDraft(client)
    expect(probe.composer.draftSessionState?.availableCommands?.map((c) => c.name)).toEqual([
      'review',
      'search',
    ])
    await act(() => probe.composer.setDraftProvider('cursor'))
    expect(probe.composer.draftSessionState?.availableCommands).toBeUndefined()
  })

  it('does not lend a draft the commands of an older session once a newer one lists none', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await mount(client)
    const list = (
      sessionId: string,
      availableCommands: Array<{ name: string; description: string }>,
    ) =>
      client.emit({
        type: 'event',
        eventId: `commands-${sessionId}`,
        timestamp: new Date().toISOString(),
        name: 'session.composer.updated',
        scope: { type: 'environment', environmentId: 'mock-environment' },
        payload: { sessionId, composer: { availableCommands } },
      })
    list(SESSION.sessionId, [{ name: 'review', description: 'Review the diff' }])
    list(SIBLING.sessionId, [])
    // The draft is opened from the sibling, whose empty listing is the answer.
    await act(() => probe.session.selectSession(WORKSPACE.workspaceId, SIBLING.sessionId))
    await settle(client)
    await openDraft(client)
    expect(probe.composer.draftSessionState?.availableCommands).toEqual([])
  })

  it('surfaces a failed session change in the composer and clears it on the next', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await act(() => root.render(<MockEnvironmentApp client={client} />))
    await settle(client)
    const row = [...container.querySelectorAll<HTMLElement>('[role="button"], button, a')].find(
      (node) => node.textContent?.includes('First'),
    )!
    await act(() => row.click())
    await settle(client)

    vi.spyOn(client.commands, 'setSessionModel').mockRejectedValueOnce(
      new EnvironmentClientError('unavailable', 'OpenCode refused the model.'),
    )
    const trigger = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Sonnet'),
    )!
    await act(() => trigger.click())
    const option = () =>
      [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) =>
        node.textContent?.includes('Opus'),
      )!
    await act(() => option().click())
    await settle(client)
    expect(container.textContent).toContain('OpenCode refused the model.')

    await act(() => trigger.click())
    await act(() => option().click())
    await settle(client)
    expect(container.textContent).not.toContain('OpenCode refused the model.')
    expect(trigger.textContent).toContain('Opus')
  })

  it('lists a broken provider in the draft picker without letting it be chosen', async () => {
    const client = createMockEnvironmentClient({ seed: SEED })
    await act(() => root.render(<MockEnvironmentApp client={client} />))
    await settle(client)
    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="New Agent"]')!.click(),
    )
    await settle(client)
    const trigger = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Sonnet'),
    )!
    await act(() => trigger.click())
    await act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[role="tab"][aria-label="Claude Code"]')!
        .click(),
    )
    const option = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (node) => node.textContent?.includes('Default'),
    )!
    expect(option.getAttribute('aria-disabled')).toBe('true')
    expect(document.body.textContent).toContain('Claude Code is unavailable')
    await act(() => option.click())
    expect(trigger.textContent).toContain('Sonnet')
  })
})
