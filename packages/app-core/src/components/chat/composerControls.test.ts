import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentpack/contract'
import type { AcpSessionRuntimeState } from '../../providers/composer-provider'
import type { ProviderComposerProfile } from '@openmanager/shared/contracts/composer-profile'
import { deriveComposerControls, withoutBlockedValues } from './composerControls'

const CODEX_MODES = [
  { id: 'supervised', name: 'Supervised' },
  { id: 'auto-accept-edits', name: 'Auto-accept edits' },
  { id: 'auto', name: 'Auto' },
  { id: 'full-access', name: 'Full access' },
]

const SETTINGS: SessionConfigOption[] = [
  {
    type: 'select',
    id: 'effort',
    name: 'Reasoning effort',
    category: 'effort',
    currentValue: 'low',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'ultra', name: 'Ultra', description: 'May start subagents on its own.' },
    ],
  },
  {
    type: 'select',
    id: 'web_search',
    name: 'Web search',
    currentValue: 'cached',
    options: [
      { value: 'disabled', name: 'Off' },
      { value: 'cached', name: 'Cached' },
      { value: 'live', name: 'Live' },
    ],
  },
]

/** A Codex draft as the environment composer resolves it. */
function codexDraft(profile: Partial<ProviderComposerProfile> = {}) {
  const draft: AcpSessionRuntimeState = {
    sessionId: 'draft:/work',
    providerId: 'codex',
    configOptions: SETTINGS,
    models: {
      currentModelId: 'gpt-6.2-sol',
      availableModels: [
        {
          modelId: 'gpt-6.2-sol',
          name: 'GPT-6.2 Sol',
          effortLevels: ['low', 'ultra'],
          supportsAutoMode: true,
          supportsImageInput: true,
        },
        { modelId: 'gpt-6-luna', name: 'GPT-6 Luna', effortLevels: ['low'], supportsAutoMode: true, supportsImageInput: false },
      ],
    },
    modes: { currentModeId: 'auto-accept-edits', availableModes: CODEX_MODES },
  }
  return deriveComposerControls({
    session: {
      activeSessionId: null,
      activeWorkspacePath: '/work',
      isSessionDraftOpen: true,
      defaultProviderId: 'codex',
      localSessionStatus: null,
    },
    composer: {
      acpSessionState: null,
      draftSessionState: draft,
      agentEvents: [],
      providerComposerProfiles: { codex: { updatedAt: 1, ...profile } },
      composerConfigValues: {},
    },
    platform: { providers: [], agentUiStatusByProvider: {}, acpPromptCapabilitiesByProvider: {} },
  })
}

describe('deriveComposerControls for Codex', () => {
  it('offers every Access preset, Auto included, and no Build/Plan pair', () => {
    const controls = codexDraft()
    expect(controls.modeOptions.map((mode) => mode.id)).toEqual([
      'supervised',
      'auto-accept-edits',
      'auto',
      'full-access',
    ])
    expect(controls.currentModeId).toBe('auto-accept-edits')
    expect(controls.modeOptions.some((mode) => mode.id === 'plan')).toBe(false)
  })

  it('shows the model’s efforts by label, its settings, and its own image answer', () => {
    const controls = codexDraft()
    expect(controls.effortOptions).toEqual([
      { id: 'low', name: 'Low' },
      { id: 'ultra', name: 'Ultra', description: 'May start subagents on its own.' },
    ])
    expect(controls.currentEffort).toBe('low')
    expect(controls.configOptions.map((option) => option.id)).toEqual(['effort', 'web_search'])
    expect(controls.catalogImageSupport).toBe(true)
  })

  it('disables a preset a policy rules out, with the reason, and hides blocked setting values', () => {
    const controls = codexDraft({
      policy: {
        blockedModes: [{ id: 'full-access', reason: 'Not allowed by a Codex policy.' }],
        blockedConfigValues: [
          { configId: 'web_search', id: 'live', reason: 'Not allowed by a Codex policy.' },
          { configId: 'effort', id: 'ultra', reason: 'Not allowed by a Codex policy.' },
        ],
      },
    })
    expect(controls.modeOptions.find((mode) => mode.id === 'full-access')).toMatchObject({
      disabledReason: 'Not allowed by a Codex policy.',
    })
    expect(controls.modeOptions.find((mode) => mode.id === 'auto')?.disabledReason).toBeUndefined()
    const webSearch = controls.configOptions.find((option) => option.id === 'web_search')
    expect(webSearch?.type === 'select' && webSearch.options.map((entry) => entry.value)).toEqual([
      'disabled',
      'cached',
    ])
    expect(controls.effortOptions?.map((option) => option.id)).toEqual(['low'])
  })
})

describe('withoutBlockedValues', () => {
  it('keeps the value in force even when it is blocked', () => {
    const [effort] = withoutBlockedValues(SETTINGS, [{ configId: 'effort', id: 'low' }])
    expect(effort?.type === 'select' && effort.options.map((entry) => entry.value)).toEqual([
      'low',
      'ultra',
    ])
  })
})
