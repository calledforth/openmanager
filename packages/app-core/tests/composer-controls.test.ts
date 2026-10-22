import { describe, expect, it } from 'vitest'
import type { ProviderCapabilities, ProviderMetadata } from '@agentpack/contract'
import {
  composerImageSupportMessage,
  deriveComposerControls,
  type ComposerControlsInput,
} from '../src/components/chat/composerControls'
import type { AcpSessionRuntimeState } from '../src/providers/composer-provider'

const CAPABILITIES: ProviderCapabilities = {
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
} as ProviderCapabilities

const CLAUDE: ProviderMetadata = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: CAPABILITIES,
  models: {
    availableModels: [
      {
        id: 'opus',
        displayName: 'Opus',
        effortLevels: ['low', 'high'],
        supportsAutoMode: true,
        supportsImageInput: true,
      },
      { id: 'haiku', displayName: 'Haiku', supportsImageInput: false },
    ],
  },
  modes: {
    availableModes: [
      { id: 'default', displayName: 'Default' },
      { id: 'auto', displayName: 'Auto' },
      { id: 'plan', displayName: 'Plan' },
    ],
  },
}
const CURSOR: ProviderMetadata = {
  id: 'cursor',
  displayName: 'Cursor',
  capabilities: CAPABILITIES,
  models: { availableModels: [{ id: 'composer', displayName: 'Composer' }] },
}

function input(overrides: {
  session?: Partial<ComposerControlsInput['session']>
  composer?: Partial<ComposerControlsInput['composer']>
  platform?: Partial<ComposerControlsInput['platform']>
  activeThreadStatus?: string
}): ComposerControlsInput {
  return {
    session: {
      activeSessionId: 'session-1',
      activeWorkspacePath: 'C:/repo',
      isSessionDraftOpen: false,
      newSessionDraftId: null,
      defaultProviderId: 'claude',
      localSessionStatus: null,
      ...overrides.session,
    },
    composer: {
      acpSessionState: null,
      draftSessionState: null,
      agentEvents: [],
      providerComposerProfiles: {},
      composerConfigValues: {},
      ...overrides.composer,
    },
    platform: {
      providers: [CLAUDE, CURSOR],
      agentUiStatusByProvider: {},
      acpPromptCapabilitiesByProvider: {},
      ...overrides.platform,
    },
    activeThreadStatus: overrides.activeThreadStatus,
  }
}

const SESSION_MODELS = [
  { modelId: 'opus', name: 'Opus', effortLevels: ['low', 'high'], supportsAutoMode: true },
  { modelId: 'haiku', name: 'Haiku' },
]

const session = (state: Partial<AcpSessionRuntimeState>): AcpSessionRuntimeState => ({
  sessionId: 'session-1',
  providerId: 'claude',
  ...state,
})

describe('deriveComposerControls', () => {
  it('takes models from the session over the provider catalog, and the session pick as current', () => {
    const controls = deriveComposerControls(
      input({
        composer: {
          acpSessionState: session({
            models: {
              currentModelId: 'sonnet',
              availableModels: [
                { modelId: 'sonnet', name: 'Sonnet' },
                { modelId: 'opus', name: 'Opus', effortLevels: ['low', 'high'] },
              ],
            },
          }),
        },
      }),
    )
    expect(controls.modelOptions.map((model) => model.id)).toEqual(['sonnet', 'opus'])
    expect(controls.currentModelId).toBe('sonnet')
    // The catalog fills in what the session's rows leave out.
    expect(controls.currentProviderId).toBe('claude')
    expect(controls.currentProviderName).toBe('Claude Code')

    const fromCatalog = deriveComposerControls(input({}))
    expect(fromCatalog.modelOptions.map((model) => model.id)).toEqual(['opus', 'haiku'])
    expect(fromCatalog.currentModelId).toBe('opus')
  })

  it('keys the draft by session, then the draft id, then the project', () => {
    expect(deriveComposerControls(input({})).draftKey).toBe('session:session-1')
    expect(
      deriveComposerControls(
        input({
          session: { activeSessionId: null, isSessionDraftOpen: true, newSessionDraftId: 'd1' },
        }),
      ).draftKey,
    ).toBe('new:d1')
    expect(
      deriveComposerControls(
        input({ session: { activeSessionId: null, isSessionDraftOpen: true } }),
      ).draftKey,
    ).toBe('draft:C:/repo')
    expect(
      deriveComposerControls(
        input({ session: { activeSessionId: null, activeWorkspacePath: null } }),
      ).draftKey,
    ).toBe('no-workspace')
  })

  it('offers auto only on a model that can serve it, once the catalog publishes capabilities', () => {
    const onOpus = deriveComposerControls(
      input({
        composer: {
          acpSessionState: session({
            models: { currentModelId: 'opus', availableModels: SESSION_MODELS },
          }),
        },
      }),
    )
    // Chrome's rows carry no capabilities; the session's do, and they decide.
    expect(onOpus.modeOptions.map((mode) => mode.id)).toEqual(['default', 'auto', 'plan'])
    const onHaiku = deriveComposerControls(
      input({
        composer: {
          acpSessionState: session({
            models: { currentModelId: 'haiku', availableModels: SESSION_MODELS },
            modes: { currentModeId: 'auto' },
          }),
        },
      }),
    )
    expect(onHaiku.modeOptions.map((mode) => mode.id)).toEqual(['default', 'plan'])
    // A remembered `auto` the model cannot serve is not shown as current.
    expect(onHaiku.currentModeId).toBe('default')
    // A provider that has never published capabilities keeps every mode.
    const silent = deriveComposerControls(
      input({
        platform: {
          providers: [
            {
              ...CLAUDE,
              models: { availableModels: [{ id: 'm', displayName: 'M' }] },
            },
          ],
        },
      }),
    )
    expect(silent.modeOptions.map((mode) => mode.id)).toContain('auto')
    expect(silent.planBuildModeId).toBe('default')
  })

  it('reads effort from the session setting, else the remembered value, else the model levels', () => {
    const effort = {
      type: 'select' as const,
      id: 'effort',
      name: 'Effort',
      category: 'effort',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    }
    const live = deriveComposerControls(
      input({ composer: { acpSessionState: session({ configOptions: [effort] }) } }),
    )
    expect(live).toMatchObject({ effortConfigId: 'effort', currentEffort: 'high' })
    expect(live.effortOptions?.map((option) => option.name)).toEqual(['Low', 'High'])

    const remembered = deriveComposerControls(
      input({
        composer: {
          acpSessionState: session({ models: { currentModelId: 'opus' } }),
          composerConfigValues: { effort: 'low' },
        },
      }),
    )
    expect(remembered.effortOptions).toBeUndefined()
    expect(remembered.effortLevels).toEqual(['low', 'high'])
    expect(remembered.currentEffort).toBe('low')

    const blank = deriveComposerControls(input({}))
    expect(blank.currentEffort).toBe('')
  })

  it('says which providers cannot be switched to, and holds a draft on a broken one', () => {
    const controls = deriveComposerControls(
      input({
        session: { activeSessionId: null, isSessionDraftOpen: true, defaultProviderId: 'cursor' },
        platform: { agentUiStatusByProvider: { claude: 'probing', cursor: 'failed' } },
      }),
    )
    expect(controls.currentProviderId).toBe('cursor')
    expect(controls.providerReady).toBe(false)
    expect(controls.canChangeProvider).toBe(true)
    const claude = controls.providerModelGroups.find((group) => group.providerId === 'claude')
    expect(claude?.unavailableReason).toBe('Checking Claude Code…')
    // The current provider is never marked unavailable: staying put is always possible.
    const cursor = controls.providerModelGroups.find((group) => group.providerId === 'cursor')
    expect(cursor?.unavailableReason).toBeUndefined()
    expect(controls.sendBlockedReason).toMatch(/Cursor is unavailable/)

    const inSession = deriveComposerControls(
      input({ platform: { agentUiStatusByProvider: { claude: 'failed' } } }),
    )
    expect(inSession.sendBlockedReason).toBeNull()
    expect(inSession.canChangeProvider).toBe(false)
  })

  it('takes commands from the session listing, the same items for the same listing', () => {
    const availableCommands = [{ name: 'review', description: 'Review the diff' }]
    const state = session({ availableCommands })
    const first = deriveComposerControls(input({ composer: { acpSessionState: state } }))
    const second = deriveComposerControls(input({ composer: { acpSessionState: state } }))
    expect(first.slashCommands).toEqual([{ name: 'review', description: 'Review the diff' }])
    expect(second.slashCommands).toBe(first.slashCommands)
    expect(deriveComposerControls(input({})).slashCommands).toEqual([])
  })

  it('counts a turn as running from the local status first, then the thread', () => {
    expect(deriveComposerControls(input({ activeThreadStatus: 'running' })).isStreaming).toBe(true)
    expect(deriveComposerControls(input({ activeThreadStatus: 'idle' })).isStreaming).toBe(false)
    expect(
      deriveComposerControls(
        input({ session: { localSessionStatus: 'running' }, activeThreadStatus: 'idle' }),
      ).isStreaming,
    ).toBe(true)
  })

  it('reports usage from the session and image support from the catalog', () => {
    const controls = deriveComposerControls(
      input({
        composer: {
          acpSessionState: session({
            models: { currentModelId: 'haiku' },
            usage: { used: 50, size: 200 },
          }),
        },
        platform: { acpPromptCapabilitiesByProvider: { claude: { image: true } as never } },
      }),
    )
    expect(controls.usage?.percent).toBe(25)
    expect(controls.providerImageSupport).toBe(true)
    expect(controls.catalogImageSupport).toBe(false)
  })
})

describe('composerImageSupportMessage', () => {
  const base = {
    canUploadImages: true,
    providerImageSupport: true as boolean | undefined,
    modelImageSupport: true as boolean | null | undefined,
    currentProviderName: 'Claude Code',
    currentModelName: 'Haiku',
  }
  it('says why an image cannot go, in order, and nothing when it can', () => {
    expect(composerImageSupportMessage(base)).toBeNull()
    expect(composerImageSupportMessage({ ...base, modelImageSupport: null })).toBeNull()
    expect(composerImageSupportMessage({ ...base, canUploadImages: false })).toMatch(
      /not available on this host/,
    )
    expect(composerImageSupportMessage({ ...base, providerImageSupport: undefined })).toMatch(
      /Checking whether the provider/,
    )
    expect(composerImageSupportMessage({ ...base, providerImageSupport: false })).toBe(
      'Claude Code does not advertise image prompt support.',
    )
    expect(composerImageSupportMessage({ ...base, modelImageSupport: undefined })).toMatch(
      /Checking whether the selected model/,
    )
    expect(composerImageSupportMessage({ ...base, modelImageSupport: false })).toBe(
      'Haiku cannot read images. Choose a vision-capable model.',
    )
  })
})
