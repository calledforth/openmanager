import { describe, expect, it } from 'vitest'
import {
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  ComposerCommandSchemas,
  ComposerResponseSchemas,
  PROVIDER_CATALOG_CAPABILITY,
} from '@openmanager/protocol'

describe('composer command wire contract', () => {
  it('validates catalog and partial preference commands', () => {
    expect(
      ComposerCommandSchemas[PROVIDER_CATALOG_CAPABILITY].parse({
        type: 'command',
        requestId: 'catalog-1',
        name: PROVIDER_CATALOG_CAPABILITY,
        payload: null,
      }),
    ).toMatchObject({ name: PROVIDER_CATALOG_CAPABILITY })

    expect(
      ComposerCommandSchemas[COMPOSER_PREFERENCES_SET_CAPABILITY].parse({
        type: 'command',
        requestId: 'preference-1',
        name: COMPOSER_PREFERENCES_SET_CAPABILITY,
        payload: {
          workspaceId: 'workspace-1',
          providerId: 'cursor',
          preference: { modelId: 'claude-opus', configValues: { effort: 'high', fast: true } },
        },
      }),
    ).toMatchObject({ payload: { preference: { modelId: 'claude-opus' } } })
  })

  it('rejects unsupported config values and empty selections', () => {
    expect(
      ComposerCommandSchemas[COMPOSER_CONFIG_OPTION_SET_CAPABILITY].safeParse({
        type: 'command',
        requestId: 'config-1',
        name: COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
        payload: { sessionId: 'session-1', configId: 'effort', value: 4 },
      }).success,
    ).toBe(false)
    expect(
      ComposerCommandSchemas[COMPOSER_MODEL_SET_CAPABILITY].safeParse({
        type: 'command',
        requestId: 'model-1',
        name: COMPOSER_MODEL_SET_CAPABILITY,
        payload: { sessionId: 'session-1', modelId: '' },
      }).success,
    ).toBe(false)
  })

  it('validates provider profiles returned by the catalog', () => {
    const profile = ComposerResponseSchemas[PROVIDER_CATALOG_CAPABILITY].parse({
        type: 'response',
        requestId: 'catalog-1',
        payload: {
          providers: [
            {
              id: 'cursor',
              displayName: 'Cursor',
              capabilities: {
                canSetModel: true,
                canSetMode: true,
                canSetConfigOption: true,
                canDeleteSession: true,
                canLoadSession: true,
                canListSessions: true,
                canCancelPrompt: true,
                supportsPlans: true,
                supportsAvailableCommands: true,
                supportsUsage: true,
                supportsPermissionRequests: true,
                supportsAuthentication: true,
                supportsThoughtStreaming: true,
                supportsSubtasks: true,
                supportsExtensions: true,
                supportsQuestions: true,
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
                providerId: 'cursor',
                availableModels: [{ modelId: 'claude-opus', name: 'Claude Opus' }],
                updatedAt: 1,
              },
            },
          ],
        },
      }).payload.providers[0]?.profile
    expect(profile).toMatchObject({ providerId: 'cursor' })
    expect(profile).not.toHaveProperty('defaultModelId')
  })
})
