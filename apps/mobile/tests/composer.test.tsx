// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentApplicationProviders,
  EnvironmentClientProvider,
  applySlashCommand,
} from '@openmanager/app-core/logic'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeed,
  type ProviderCatalogEntry,
} from '@openmanager/environment-client'

import type { PhoneConnectionState } from '../src/environment/controller'
import type { ComposerModel } from '../src/composer/model'

// The phone's connection, as the controller would report a paired, connected
// environment; the real one needs React Native's runtime.
const connection = { status: 'connected' } as unknown as PhoneConnectionState
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({
  usePhoneConnection: () => connection,
}))

const { useLiveComposerModel } = await import('../src/composer/useLiveComposerModel')
const { ThreadBridge } = await import('../src/composer/thread-port')
const {
  composerFold,
  modelSheetSections,
  permissionChoices,
  pressPrimary,
  primaryAction,
  roomFor,
  slashPopupOf,
  METER_WIDTH,
  MODEL_MIN_WIDTH,
} = await import('../src/composer/model')
const { createComposerUi } = await import('../src/composer/ui-state')

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['claude'] },
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

const READY = {
  summary: 'ready',
  refreshing: false,
  install: 'installed',
  auth: 'authenticated',
  runtime: { state: 'running', liveProcesses: 1, activeTurns: 0 },
  lastProbe: null,
  update: 'current',
} as const
const CLAUDE: ProviderCatalogEntry = {
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
  health: READY,
  profile: {
    providerId: 'claude',
    availableModels: [
      {
        modelId: 'opus',
        name: 'Opus',
        description: 'Opus 5.5 · Best for complex work',
        effortLevels: ['low', 'high'],
        supportsImageInput: true,
      },
      { modelId: 'sonnet', name: 'Sonnet', supportsImageInput: true },
    ],
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
      { id: 'bypassPermissions', name: 'Bypass permissions' },
    ],
    defaultModelId: 'opus',
    defaultModeId: 'default',
    promptCapabilities: { image: true, audio: false, embeddedContext: false },
    updatedAt: 1_700_000_000_000,
  },
} as ProviderCatalogEntry

function seed(turnState: 'completed' | 'running'): MockSeed {
  return {
    workspaces: [WORKSPACE],
    providers: [CLAUDE],
    sessions: [
      {
        session: SESSION,
        providerId: 'claude',
        status: turnState === 'running' ? 'running' : 'idle',
        threads: [THREAD],
        turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: turnState }],
        messages: [],
      },
    ],
  }
}

let model: ComposerModel | null = null
function Probe({ sessionId = SESSION.sessionId }: { sessionId?: string }) {
  const live = useLiveComposerModel(sessionId)
  model = live.model
  return <ThreadBridge port={live.port} />
}
const current = () => model!
/** The one button, pressed as it is drawn: send or stop, whichever it shows. */
const press = () =>
  act(async () =>
    pressPrimary(current().primary, { send: current().send, interrupt: current().interrupt }),
  )

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  model = null
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

const flush = async (rounds = 8) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

async function open(options: Parameters<typeof createMockEnvironmentClient>[0]) {
  const client = createMockEnvironmentClient(options)
  await act(() =>
    root.render(
      <EnvironmentClientProvider client={client}>
        <EnvironmentApplicationProviders storage={null} navigateDraft={async () => undefined}>
          <Probe />
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>,
    ),
  )
  await act(() => client.commands.openSession(SESSION.sessionId))
  await flush()
  return client
}

const environmentScope = (client: MockEnvironmentClient) => ({
  type: 'environment' as const,
  environmentId: client.getState().environment!.environmentId,
})
const threadScope = (client: MockEnvironmentClient) => ({
  type: 'thread' as const,
  environmentId: client.getState().environment!.environmentId,
  ...THREAD,
})
let eventCount = 0
const base = () => ({
  type: 'event' as const,
  eventId: `test-${++eventCount}`,
  timestamp: new Date().toISOString(),
})

/** The environment pushes the session's composer state, as it does after any pick. */
function pushComposer(client: MockEnvironmentClient, composer: Record<string, unknown>) {
  return act(() =>
    client.emit({
      ...base(),
      name: 'session.composer.updated',
      scope: environmentScope(client),
      payload: { sessionId: SESSION.sessionId, composer },
    } as never),
  )
}

const EFFORT = {
  type: 'select',
  id: 'effort',
  name: 'Effort',
  category: 'effort',
  currentValue: 'high',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
}
const FAST = { type: 'boolean', id: 'fast', name: 'Fast mode', currentValue: false }

const callsOf = (client: MockEnvironmentClient, command: string) =>
  client.calls.filter((call) => call.command === command).map((call) => call.input)

const TARGET = { ...THREAD, turnId: 'turn-1' }

describe('the composer picks', () => {
  it('shows the session the environment describes and sends every pick as a command', async () => {
    const client = await open({ seed: seed('completed'), respond: () => null })
    await pushComposer(client, {
      modelId: 'opus',
      modeId: 'default',
      configOptions: [EFFORT, FAST],
      availableCommands: [{ name: 'review', description: 'Review the diff' }],
      usage: { used: 38, size: 100 },
    })
    await flush()

    expect(current().picks).toMatchObject({
      providerId: 'claude',
      modelLabel: 'Opus 5.5',
      mode: { id: 'default', label: 'Default' },
      effort: { id: 'high', label: 'High' },
      usagePercent: 38,
      lockedReason: null,
    })
    // The pills' own settings stay off the Session settings sheet.
    expect(current().settings.map((option) => option.id)).toEqual(['fast'])
    expect(current().modeChoices.map((mode) => mode.id)).toEqual([
      'default',
      'plan',
      'bypassPermissions',
    ])

    await act(async () => current().pickModel('claude', 'sonnet'))
    await act(async () => current().pickMode('plan'))
    await act(async () => current().pickEffort('low'))
    await act(async () => current().setSetting('fast', true))
    await flush()
    expect(callsOf(client, 'setSessionModel')).toEqual([
      { sessionId: SESSION.sessionId, modelId: 'sonnet' },
    ])
    expect(callsOf(client, 'setSessionMode')).toEqual([
      { sessionId: SESSION.sessionId, modeId: 'plan' },
    ])
    expect(callsOf(client, 'setSessionConfigOption')).toEqual([
      { sessionId: SESSION.sessionId, configId: 'effort', value: 'low' },
      { sessionId: SESSION.sessionId, configId: 'fast', value: true },
    ])
    // What shows is what the environment answered with, pushed back to this client.
    expect(current().picks.modelLabel).toBe('Sonnet')
    expect(current().picks.mode).toMatchObject({ id: 'plan' })
  })

  it('lists only the session provider in the model sheet, favourites first', () => {
    const groups = [
      {
        providerId: 'claude' as const,
        providerName: 'Claude Code',
        models: [
          { id: 'opus', name: 'Opus', description: 'Opus 5.5 · Best' },
          { id: 'sonnet', name: 'Sonnet' },
        ],
      },
      { providerId: 'cursor' as const, providerName: 'Cursor', models: [{ id: 'c', name: 'C' }] },
    ]
    const sections = modelSheetSections({
      groups,
      currentProviderId: 'claude',
      canChangeProvider: false,
      favorites: ['claude:sonnet'],
      query: '',
    })
    expect(sections.map((section) => section.id)).toEqual(['favorites', 'claude'])
    expect(sections[0]!.rows.map((row) => row.label)).toEqual(['Sonnet'])
    expect(sections[1]!.rows.map((row) => [row.label, row.hint])).toEqual([
      ['Opus 5.5', 'Best'],
      ['Sonnet', undefined],
    ])
    const draft = modelSheetSections({
      groups,
      currentProviderId: 'claude',
      canChangeProvider: true,
      favorites: [],
      query: 'c',
    })
    expect(draft.map((section) => section.id)).toEqual(['cursor'])
  })
})

describe('the dock folds with the turn', () => {
  it('is B at rest, C while a turn runs, and the prompt while a request waits', () => {
    expect(composerFold({ isStreaming: false, prompt: null })).toBe('rest')
    expect(composerFold({ isStreaming: true, prompt: null })).toBe('running')
    expect(
      composerFold({
        isStreaming: true,
        prompt: { kind: 'permission' } as unknown as Parameters<typeof composerFold>[0]['prompt'],
      }),
    ).toBe('prompt')
  })

  it('turns send into stop while a turn runs, and stops it through the thread', async () => {
    const client = await open({ seed: seed('completed'), respond: () => null })
    expect(current().isStreaming).toBe(false)
    expect(current().primary).toMatchObject({ kind: 'send', enabled: false })

    await act(async () => current().setText('Run the tests'))
    expect(current().primary).toMatchObject({ kind: 'send', enabled: true })
    await press()
    await flush()
    expect(callsOf(client, 'sendTurn')).toEqual([
      expect.objectContaining({ ...THREAD, text: 'Run the tests' }),
    ])
    // Emptied for the send; the turn now runs, and the one button stops it.
    expect(current().text).toBe('')
    expect(current().isStreaming).toBe(true)
    expect(current().primary).toMatchObject({ kind: 'stop', enabled: true })

    // Typing meanwhile sends nothing: steering has not landed on the server.
    await act(async () => current().setText('and then the lint'))
    expect(current().primary.kind).toBe('stop')

    await act(async () => current().interrupt())
    await flush()
    expect(callsOf(client, 'interruptTurn')).toHaveLength(1)
    expect(current().isStreaming).toBe(false)
    expect(current().primary).toMatchObject({ kind: 'send', enabled: true })
  })

  it('says why the button cannot be used rather than doing nothing', () => {
    const base = {
      isStreaming: false,
      canInterrupt: false,
      hasContent: true,
      sending: false,
      uploading: false,
      unavailable: null,
      sendBlockedReason: null,
      imageProblem: null,
      planReview: false,
      hasImages: false,
    }
    expect(primaryAction({ ...base, unavailable: 'Not connected' })).toMatchObject({
      enabled: false,
      reason: 'Not connected',
    })
    expect(primaryAction({ ...base, uploading: true }).reason).toMatch(/upload/)
    expect(primaryAction({ ...base, isStreaming: true })).toMatchObject({
      kind: 'stop',
      enabled: false,
    })
    expect(primaryAction({ ...base, planReview: true, hasImages: true }).enabled).toBe(false)
  })
})

describe('slash commands', () => {
  it('pops the session commands for a bare /name and fills the field with the pick', async () => {
    const client = await open({ seed: seed('completed'), respond: () => null })
    await pushComposer(client, {
      availableCommands: [
        { name: 'review', description: 'Review the diff' },
        { name: 'compact', description: 'Summarise' },
      ],
    })
    await flush()
    const commands = current().slashCommands
    expect(slashPopupOf('/re', commands, false).matches.map((command) => command.name)).toEqual([
      'review',
    ])
    expect(slashPopupOf('/', commands, false).matches).toHaveLength(2)
    expect(slashPopupOf('/review now', commands, false).matches).toEqual([])
    expect(slashPopupOf('/re', commands, true).matches).toEqual([])
    await act(async () => current().setText(applySlashCommand(commands[0]!)))
    expect(current().text).toBe('/review ')
  })
})

describe('images', () => {
  it('uploads a photo when attached, shows it, removes it, and sends what is kept', async () => {
    const bytes = new Blob([new Uint8Array([1, 2, 3, 4])], { type: '' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => bytes }) as unknown as Response),
    )
    const client = await open({ seed: seed('completed'), respond: () => null })
    expect(current().attach).toEqual({ enabled: true, reason: null })

    const photo = { uri: 'file:///photo-1.jpg', name: 'Photo 1.jpg', mimeType: 'image/jpeg' }
    await act(async () => current().attachPhoto(photo))
    await flush()
    // Stored on the environment and named in the session's draft.
    const [kept] = current().images
    expect(kept).toMatchObject({ name: 'Photo 1.jpg', uri: photo.uri })
    expect(kept!.uploading).toBeUndefined()
    const draft = client.getState().drafts?.[SESSION.sessionId]
    expect(draft?.content.artifactIds).toEqual([kept!.id])

    await act(async () => current().removeImage(kept!.id))
    await flush()
    expect(current().images).toEqual([])

    await act(async () => current().attachPhoto({ ...photo, uri: 'file:///photo-2.jpg' }))
    await flush()
    const second = current().images[0]!
    await act(async () => current().setText('What is this?'))
    await press()
    await flush()
    expect(callsOf(client, 'sendTurn')).toEqual([
      expect.objectContaining({ text: 'What is this?', artifactIds: [second.id] }),
    ])
    expect(current().images).toEqual([])
  })

  it('refuses what is not an image the providers take, and says so', async () => {
    await open({ seed: seed('completed'), respond: () => null })
    await act(async () =>
      current().attachPhoto({ uri: 'file:///a.gif', name: 'a.gif', mimeType: 'image/gif' }),
    )
    expect(current().notice).toMatch(/PNG, JPEG, or WebP/)
    expect(current().images).toEqual([])
  })
})

describe('the composer as the prompt', () => {
  it('offers the provider’s own choices, in order, and answers through interaction.respond', async () => {
    const client = await open({ seed: seed('running'), respond: () => null })
    await act(() =>
      client.requestInteraction(TARGET, {
        kind: 'permission',
        interactionId: 'perm-1',
        toolCall: { toolCallId: 'call-1', title: 'Run pnpm test', kind: 'execute' },
        options: [
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          { optionId: 'yes', name: 'Yes, run it', kind: 'allow_once' },
          { optionId: 'always', name: 'Always for pnpm', kind: 'allow_always' },
        ],
        // Past already: only the environment's event may take it away.
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    )
    await flush()
    const prompt = current().prompt
    expect(prompt).toMatchObject({ kind: 'permission', title: 'Run pnpm test', detail: 'execute' })
    if (prompt?.kind !== 'permission') throw new Error('no permission')
    expect(prompt.choices).toEqual([
      { optionId: 'no', label: 'Reject', tone: 'plain' },
      { optionId: 'yes', label: 'Yes, run it', tone: 'primary' },
      { optionId: 'always', label: 'Always for pnpm', tone: 'secondary' },
    ])
    expect(composerFold(current())).toBe('prompt')

    await act(async () => prompt.answer('always'))
    await flush()
    expect(callsOf(client, 'respondToInteraction')).toEqual([
      expect.objectContaining({
        response: {
          kind: 'permission',
          interactionId: 'perm-1',
          outcome: { outcome: 'selected', optionId: 'always' },
        },
      }),
    ])
    // The environment resolved it: gone.
    expect(current().prompt).toBeNull()
  })

  it('goes when another device answers or the request expires, and not before', async () => {
    const client = await open({ seed: seed('running'), respond: () => null })
    const permission = (interactionId: string) => ({
      kind: 'permission' as const,
      interactionId,
      toolCall: { toolCallId: `call-${interactionId}`, title: 'Edit a file' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' as const }],
    })
    await act(() => client.requestInteraction(TARGET, permission('a')))
    await flush()
    expect(current().prompt).toMatchObject({ kind: 'permission', requestId: 'a' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await flush()
    expect(current().prompt).toMatchObject({ requestId: 'a' })

    // Web answers it.
    await act(() =>
      client.emit({
        ...base(),
        name: 'interaction.resolved',
        scope: threadScope(client),
        payload: {
          turnId: 'turn-1',
          response: {
            kind: 'permission',
            interactionId: 'a',
            outcome: { outcome: 'selected', optionId: 'ok' },
          },
          resolvedByClientId: 'web',
        },
      } as never),
    )
    await flush()
    expect(current().prompt).toBeNull()

    await act(() => client.requestInteraction(TARGET, permission('b')))
    await flush()
    expect(current().prompt).toMatchObject({ requestId: 'b' })
    await act(() =>
      client.emit({
        ...base(),
        name: 'interaction.expired',
        scope: threadScope(client),
        payload: {
          turnId: 'turn-1',
          response: {
            kind: 'permission',
            interactionId: 'b',
            outcome: { outcome: 'cancelled', reason: 'timeout' },
          },
        },
      } as never),
    )
    await flush()
    expect(current().prompt).toBeNull()
  })

  it('walks a question set through the shared flow and sends the answers', async () => {
    const client = await open({ seed: seed('running'), respond: () => null })
    await act(() =>
      client.requestInteraction(TARGET, {
        kind: 'question',
        interactionId: 'q-1',
        questions: [
          {
            questionId: 'where',
            prompt: 'Where should it link?',
            options: [
              { optionId: 'checkout', label: 'Checkout' },
              { optionId: 'docs', label: 'Docs' },
            ],
          },
          {
            questionId: 'tiers',
            prompt: 'Which tiers?',
            allowMultiple: true,
            options: [
              { optionId: 'starter', label: 'Starter' },
              { optionId: 'team', label: 'Team' },
            ],
          },
        ],
      }),
    )
    await flush()
    const ask = () => {
      const prompt = current().prompt
      if (prompt?.kind !== 'question') throw new Error('no question')
      return prompt.flow
    }
    expect(ask()).toMatchObject({ index: 0, canAdvance: false, hasReview: true })
    await act(async () => ask().pick(ask().question!, 'docs'))
    await act(async () => ask().advance())
    expect(ask().question?.questionId).toBe('tiers')
    await act(async () => ask().pick(ask().question!, 'starter'))
    await act(async () => ask().pick(ask().question!, 'team'))
    await act(async () => ask().setText('and enterprise'))
    await act(async () => ask().advance())
    expect(ask().onReview).toBe(true)
    await act(async () => ask().advance())
    await flush()
    expect(callsOf(client, 'respondToInteraction')).toEqual([
      expect.objectContaining({
        response: {
          kind: 'question',
          interactionId: 'q-1',
          outcome: {
            outcome: 'answered',
            answers: [
              { questionId: 'where', selectedOptionIds: ['docs'] },
              {
                questionId: 'tiers',
                selectedOptionIds: ['starter', 'team'],
                text: 'and enterprise',
              },
            ],
          },
        },
      }),
    ])
    expect(current().prompt).toBeNull()
  })

  it('builds a plan through the shared plan logic, and turns the field into a change request', async () => {
    const client = await open({ seed: seed('running'), respond: () => null })
    const plan = (interactionId: string) => ({
      kind: 'plan' as const,
      interactionId,
      name: 'Grid and form',
      overview: 'Two pieces',
      markdown: '## Steps',
      todos: [{ id: 't1', content: 'Grid', status: 'pending' as const }],
      continuation: 'same_turn' as const,
    })
    await act(() => client.requestInteraction(TARGET, plan('plan-1')))
    await flush()
    expect(current().prompt).toMatchObject({
      kind: 'plan',
      requestId: 'plan-1',
      buildModeLabel: 'Default',
    })
    expect(current().placeholder).toMatch(/change in the plan/)
    // Images do not go with a change request.
    expect(current().attach.enabled).toBe(false)

    await act(async () => current().setText('Use a masonry grid'))
    // The turn waits on the review, so it still counts as running: the button
    // must ask for the change, not stop the turn.
    expect(current().isStreaming).toBe(true)
    expect(current().primary).toMatchObject({ kind: 'send', enabled: true })
    await press()
    await flush()
    expect(callsOf(client, 'respondToInteraction').at(-1)).toMatchObject({
      response: {
        kind: 'plan',
        interactionId: 'plan-1',
        outcome: { outcome: 'rejected', reason: 'Use a masonry grid' },
      },
    })
    expect(callsOf(client, 'sendTurn')).toEqual([])

    await act(() => client.requestInteraction(TARGET, plan('plan-2')))
    await flush()
    const prompt = current().prompt
    if (prompt?.kind !== 'plan') throw new Error('no plan')
    await act(async () => prompt.build())
    await flush()
    expect(callsOf(client, 'respondToInteraction').at(-1)).toMatchObject({
      response: { kind: 'plan', interactionId: 'plan-2', outcome: { outcome: 'accepted' } },
    })
    expect(current().prompt).toBeNull()
  })

  it('names a permission’s choices by the provider, never a fixed pair', () => {
    expect(permissionChoices([])).toEqual([])
    expect(
      permissionChoices([
        { optionId: 'a', name: '', kind: 'allow_once' },
        { optionId: 'b', name: '', kind: 'reject_always' },
      ]),
    ).toEqual([
      { optionId: 'a', label: 'Allow', tone: 'primary' },
      { optionId: 'b', label: 'Always deny', tone: 'plain' },
    ])
  })
})

describe('the composer UI state', () => {
  it('opens one sheet at a time, and Back closes the sheet before the pulled-up composer', () => {
    const ui = createComposerUi()
    ui.expand()
    ui.open({ kind: 'model' })
    expect(ui.get()).toEqual({ expanded: true, overlay: { kind: 'model' } })
    expect(ui.back()).toBe(true)
    expect(ui.get()).toEqual({ expanded: true, overlay: null })
    expect(ui.back()).toBe(true)
    expect(ui.get().expanded).toBe(false)
    expect(ui.back()).toBe(false)
  })
})

describe('Session settings in the ⋯ menu', () => {
  it('opens the composer sheet once the page has a composer, and says why when it cannot', async () => {
    const { sessionMenuItems } = await import('../src/session/session-menu')
    const input = {
      mark: 'idle' as const,
      settled: false,
      backgroundTaskCount: 0,
      unavailable: null,
      supports: () => true,
    }
    const settingsOf = (items: ReturnType<typeof sessionMenuItems>) =>
      items.find((item) => item.id === 'session-settings')!.disabledReason
    expect(settingsOf(sessionMenuItems({ ...input, settings: null }))).toBeNull()
    expect(settingsOf(sessionMenuItems(input))).toBe('Not on the phone yet')
    expect(settingsOf(sessionMenuItems({ ...input, settings: null, unavailable: 'Offline' }))).toBe(
      'Offline',
    )
  })
})

describe('before the session is open', () => {
  it('keeps what is typed in the page session draft, and a stop is a rejection', async () => {
    const { createThreadPort } = await import('../src/composer/thread-port')
    await expect(createThreadPort().abort('session-1')).rejects.toThrow(/still opening/)

    const client = createMockEnvironmentClient({ seed: seed('completed'), respond: () => null })
    await act(() =>
      root.render(
        <EnvironmentClientProvider client={client}>
          <EnvironmentApplicationProviders storage={null} navigateDraft={async () => undefined}>
            <Probe />
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>,
      ),
    )
    await flush()
    await act(async () => current().setText('typed while it opens'))
    expect(current().primary.reason).toBe('Opening the session…')
    await act(() => client.commands.openSession(SESSION.sessionId))
    await flush()
    expect(current().text).toBe('typed while it opens')
    expect(current().primary.enabled).toBe(true)
  })
})

describe('a refused send', () => {
  it('puts the text back, keeps what was typed since, and stays with its session', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        ...seed('completed'),
        sessions: [
          ...seed('completed').sessions!,
          {
            session: {
              sessionId: 'session-2',
              workspaceId: WORKSPACE.workspaceId,
              title: 'Second',
            },
            providerId: 'claude',
            threads: [{ threadId: 'thread-2', sessionId: 'session-2' }],
            turns: [],
            messages: [],
          },
        ],
      },
      respond: () => null,
    })
    let refuse!: (error: Error) => void
    vi.spyOn(client.commands, 'sendTurn').mockImplementation(
      () => new Promise((_resolve, reject) => (refuse = reject)),
    )
    const page = (sessionId: string) =>
      act(() =>
        root.render(
          <EnvironmentClientProvider client={client}>
            <EnvironmentApplicationProviders storage={null} navigateDraft={async () => undefined}>
              <Probe key={sessionId} sessionId={sessionId} />
            </EnvironmentApplicationProviders>
          </EnvironmentClientProvider>,
        ),
      )
    await page(SESSION.sessionId)
    await act(() => client.commands.openSession(SESSION.sessionId))
    await flush()
    await act(async () => current().setText('Deploy it'))
    await press()
    await flush()
    // Emptied for the send, which is still out.
    expect(current().text).toBe('')
    await act(async () => current().setText('and tag it'))
    await act(async () => refuse(new Error('The environment is busy.')))
    await flush()
    expect(current().text).toBe('Deploy it\nand tag it')
    expect(current().notice).toBe('The environment is busy.')

    // Another send refused after the reader has moved on: it goes back to its own session.
    await act(async () => current().setText('Second try'))
    await press()
    await flush()
    await page('session-2')
    await act(() => client.commands.openSession('session-2'))
    await flush()
    expect(current().text).toBe('')
    await act(async () => refuse(new Error('Still busy.')))
    await flush()
    await page(SESSION.sessionId)
    await act(() => client.commands.openSession(SESSION.sessionId))
    await flush()
    expect(current().text).toBe('Second try')
  })
})

describe('a photo on its way', () => {
  it('holds the send while it is read, and is dropped if the session changes first', async () => {
    let finish!: () => void
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = () => resolve({ blob: async () => bytes } as unknown as Response)
          }),
      ),
    )
    const client = await open({ seed: seed('completed'), respond: () => null })
    await act(async () => current().setText('Look at this'))
    const upload = vi.spyOn(client, 'uploadArtifact')
    await act(async () => {
      current().attachPhoto({ uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' })
    })
    // Being read: the send waits for it.
    expect(current().primary).toMatchObject({ kind: 'send', enabled: false })
    expect(current().primary.reason).toMatch(/upload/)

    // The reader leaves the session before the bytes are read.
    await act(async () => client.setActiveSession(null))
    await act(async () => finish())
    await flush()
    expect(upload).not.toHaveBeenCalled()
    expect(current().images).toEqual([])
    expect(current().notice).toMatch(/session changed/)
    expect(client.getState().drafts?.[SESSION.sessionId]?.content.artifactIds).toBeUndefined()
  })
})

describe('question answers that do not land', () => {
  it('says so on the question, and Submit or Skip tries again', async () => {
    const client = await open({ seed: seed('running'), respond: () => null })
    await act(() =>
      client.requestInteraction(TARGET, {
        kind: 'question',
        interactionId: 'q-fail',
        questions: [
          {
            questionId: 'one',
            prompt: 'Which?',
            options: [{ optionId: 'a', label: 'A' }],
          },
        ],
      }),
    )
    await flush()
    const flow = () => {
      const prompt = current().prompt
      if (prompt?.kind !== 'question') throw new Error('no question')
      return prompt
    }
    const respond = client.commands.respondToInteraction.bind(client.commands)
    const spy = vi
      .spyOn(client.commands, 'respondToInteraction')
      .mockRejectedValueOnce(new Error('Skip refused'))
      .mockRejectedValueOnce(new Error('Submit refused'))
      .mockImplementation(respond)

    await act(async () => flow().flow.skip())
    await flush()
    expect(flow().error).toBe('Skip refused')
    await act(async () => flow().flow.pick(flow().flow.question!, 'a'))
    await act(async () => flow().flow.advance())
    await flush()
    expect(flow().error).toBe('Submit refused')
    expect(flow().flow.submitting).toBe(false)
    expect(flow().flow.canAdvance).toBe(true)
    await act(async () => flow().flow.advance())
    await flush()
    expect(spy).toHaveBeenCalledTimes(3)
    expect(current().prompt).toBeNull()
  })
})

describe('a request arriving while the composer is pulled up', () => {
  it('drops the editor back to the dock, which is the request, and keeps the draft', () => {
    const ui = createComposerUi()
    ui.followPrompt(null)
    ui.expand()
    ui.open({ kind: 'model' })
    ui.followPrompt('perm-1')
    expect(ui.get()).toEqual({ expanded: false, overlay: null })
    // The same request again (a re-render) leaves a reopened editor alone.
    ui.expand()
    ui.followPrompt('perm-1')
    expect(ui.get().expanded).toBe(true)
    ui.followPrompt(null)
    expect(ui.get().expanded).toBe(true)
  })
})

describe('the picks row', () => {
  it('cuts only the model name, and drops the meter before any label', () => {
    expect(roomFor({ row: 0, fixed: 0, meter: true })).toEqual({ model: undefined, meter: true })
    expect(roomFor({ row: 340, fixed: 160, meter: true })).toEqual({
      model: 340 - 160 - METER_WIDTH,
      meter: true,
    })
    // Too narrow for the name with the meter: the meter goes.
    expect(roomFor({ row: 300, fixed: 160, meter: true })).toEqual({ model: 140, meter: false })
    expect(roomFor({ row: 200, fixed: 180, meter: false }).model).toBe(MODEL_MIN_WIDTH)
  })

  it('names each provider group for a screen reader', () => {
    const sections = modelSheetSections({
      groups: [{ providerId: 'cursor', providerName: 'Cursor', models: [{ id: 'c', name: 'C' }] }],
      currentProviderId: 'cursor',
      canChangeProvider: false,
      favorites: ['cursor:c'],
      query: '',
    })
    expect(sections.map((section) => section.label)).toEqual(['Favourites', 'Cursor'])
  })
})

describe('the camera shutter', () => {
  it('lands nowhere once the camera has closed, and closes nothing opened since', async () => {
    const { useCapture } = await import('../src/composer/capture')
    let resolveShot!: (photo: { uri: string; name: string; mimeType: string }) => void
    const onPhoto = vi.fn()
    const onClose = vi.fn()
    let capture: ReturnType<typeof useCapture> | null = null
    function Camera() {
      capture = useCapture({
        take: () => new Promise((resolve) => (resolveShot = resolve)),
        onPhoto,
        onClose,
      })
      return null
    }
    await act(() => root.render(<Camera />))
    await act(async () => {
      void capture!.shoot()
    })
    // Back before the shot comes in.
    await act(async () => capture!.close())
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () =>
      resolveShot({ uri: 'file:///late.jpg', name: 'late', mimeType: 'image/jpeg' }),
    )
    expect(onPhoto).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('the fold', () => {
  const driver = async () => {
    const { createFoldDriver } = await import('../src/composer/fold-transition')
    let now = 1_000
    const calls: string[] = []
    const fold = createFoldDriver({
      now: () => now,
      animate: (from, to) => calls.push(`animate ${from}->${to}`),
      snap: () => calls.push('snap'),
      hold: (delta) => calls.push(`hold ${delta}`),
      release: () => calls.push('release'),
    })
    return { fold, calls, tick: (ms: number) => (now += ms) }
  }

  it('eases the box only through a fold, from its height before to its height after', async () => {
    const { fold, calls, tick } = await driver()
    fold.onKey('rest:')
    fold.onContentHeight(84)
    // Text wrapping at rest: no animation.
    fold.onContentHeight(105)
    expect(calls).toEqual([])
    // A turn starts: the row folds into the chip.
    tick(5000)
    fold.onKey('running:')
    tick(16)
    fold.onContentHeight(52)
    expect(calls).toEqual(['hold -53', 'animate 105->52'])
    fold.onFinished()
    expect(calls.at(-1)).toBe('release')
  })

  it('lands content changes inside the fold window at once, ending the ease', async () => {
    const { fold, calls, tick } = await driver()
    fold.onKey('running:')
    fold.onContentHeight(52)
    tick(1000)
    fold.onKey('prompt:q-1')
    fold.onContentHeight(180)
    expect(calls).toEqual(['hold 128', 'animate 52->180'])
    // The question's next slide, or an error, while it eases: no second animation.
    tick(60)
    fold.onContentHeight(220)
    expect(calls).toEqual(['hold 128', 'animate 52->180', 'snap', 'release'])
    fold.onFinished()
    expect(calls).toHaveLength(4)
    // A fold whose content took too long to measure is not animated late.
    fold.onKey('rest:')
    tick(500)
    fold.onContentHeight(84)
    expect(calls).toHaveLength(4)
  })
})

describe('a photo on its way when the page goes', () => {
  it('is never stored or named once its composer has unmounted', async () => {
    let finish!: () => void
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = () => resolve({ blob: async () => bytes } as unknown as Response)
          }),
      ),
    )
    const client = createMockEnvironmentClient({
      seed: {
        ...seed('completed'),
        sessions: [
          ...seed('completed').sessions!,
          {
            session: {
              sessionId: 'session-2',
              workspaceId: WORKSPACE.workspaceId,
              title: 'Second',
            },
            providerId: 'claude',
            threads: [{ threadId: 'thread-2', sessionId: 'session-2' }],
            turns: [],
            messages: [],
          },
        ],
      },
      respond: () => null,
    })
    const upload = vi.spyOn(client, 'uploadArtifact')
    const page = (sessionId: string) =>
      act(() =>
        root.render(
          <EnvironmentClientProvider client={client}>
            <EnvironmentApplicationProviders storage={null} navigateDraft={async () => undefined}>
              <Probe key={sessionId} sessionId={sessionId} />
            </EnvironmentApplicationProviders>
          </EnvironmentClientProvider>,
        ),
      )
    await page(SESSION.sessionId)
    await act(() => client.commands.openSession(SESSION.sessionId))
    await flush()
    await act(async () => {
      void current().attachPhoto({ uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' })
    })
    // The reader goes to another session: A's composer unmounts, B's mounts.
    await page('session-2')
    await act(() => client.commands.openSession('session-2'))
    await flush()
    await act(async () => finish())
    await flush()
    expect(upload).not.toHaveBeenCalled()
    expect(client.getState().drafts?.[SESSION.sessionId]?.content.artifactIds).toBeUndefined()
    expect(client.getState().drafts?.['session-2']?.content.artifactIds).toBeUndefined()
    expect(current().images).toEqual([])
  })

  it('stores a photo under the session it was attached in', async () => {
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => bytes }) as unknown as Response),
    )
    const client = await open({ seed: seed('completed'), respond: () => null })
    const upload = vi.spyOn(client, 'uploadArtifact')
    await act(async () =>
      current().attachPhoto({ uri: 'file:///b.jpg', name: 'b.jpg', mimeType: 'image/jpeg' }),
    )
    await flush()
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION.sessionId, name: 'b.jpg' }),
    )
  })
})
