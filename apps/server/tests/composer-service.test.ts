import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_PREFERENCES_GET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  PROVIDER_CATALOG_CAPABILITY,
  type ProviderBootstrap,
} from '@openmanager/protocol/node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComposerService } from '../src/composer-service.js'
import { openComposerStore, type ComposerStore } from '../src/composer-store.js'

const directories: string[] = []
const stores: ComposerStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

const provider: ProviderBootstrap = {
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
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-composer-service-test-'))
  directories.push(directory)
  const store = openComposerStore(directory)
  stores.push(store)
  const runtime = {
    setModel: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue(undefined),
    applyDesiredConfig: vi.fn().mockResolvedValue(undefined),
    providerModels: vi.fn(() => ({})),
    providerModes: vi.fn(() => ({})),
  } as unknown as Parameters<typeof createComposerService>[0]
  const providers = {
    snapshot: () => [provider],
    rejection: () => undefined,
  }
  const target = {
    providerId: 'cursor' as const,
    threadId: 'thread-1',
    workspaceId: 'workspace-1',
    cwd: '/workspace/one',
    sessionId: 'provider-session-1',
  }
  const service = createComposerService(runtime, providers, store, (sessionId) =>
    sessionId === 'session-1' ? Promise.resolve(target) : undefined,
  )
  return { runtime, service, store, target }
}

describe('composer service commands', () => {
  it('gets and patches preferences scoped by workspace and provider', async () => {
    const { service } = await harness()
    expect(
      service.dispatch({
        type: 'command',
        requestId: 'get-1',
        name: COMPOSER_PREFERENCES_GET_CAPABILITY,
        payload: { workspaceId: 'workspace-1', providerId: 'cursor' },
      }),
    ).toMatchObject({ payload: { preference: {} } })

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'set-1',
        name: COMPOSER_PREFERENCES_SET_CAPABILITY,
        payload: {
          workspaceId: 'workspace-1',
          providerId: 'cursor',
          preference: { modelId: 'opus', configValues: { effort: 'high' } },
        },
      }),
    ).toMatchObject({
      payload: { preference: { modelId: 'opus', configValues: { effort: 'high' } } },
    })
  })

  it('applies model, mode and config changes to the live runtime and persists them', async () => {
    const { runtime, service, store, target } = await harness()
    store.setPreference('workspace-1', 'cursor', { configValues: { effort: 'high' } })

    await service.dispatch({
      type: 'command',
      requestId: 'model-1',
      name: COMPOSER_MODEL_SET_CAPABILITY,
      payload: { sessionId: 'session-1', modelId: 'opus' },
    })
    await service.dispatch({
      type: 'command',
      requestId: 'mode-1',
      name: COMPOSER_MODE_SET_CAPABILITY,
      payload: { sessionId: 'session-1', modeId: 'plan' },
    })
    await service.dispatch({
      type: 'command',
      requestId: 'config-1',
      name: COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
      payload: { sessionId: 'session-1', configId: 'fast', value: true },
    })

    expect(runtime.setModel).toHaveBeenCalledWith({ ...target, modelId: 'opus' })
    expect(runtime.applyDesiredConfig).toHaveBeenCalledWith(target, {
      values: { effort: 'high' },
    })
    expect(runtime.setMode).toHaveBeenCalledWith({ ...target, modeId: 'plan' })
    expect(runtime.setConfigOption).toHaveBeenCalledWith({
      ...target,
      configId: 'fast',
      value: true,
    })
    expect(store.getPreference('workspace-1', 'cursor')).toEqual({
      modelId: 'opus',
      modeId: 'plan',
      configValues: { effort: 'high', fast: true },
    })
  })

  it('does not persist a live control that the provider rejects', async () => {
    const { runtime, service, store } = await harness()
    vi.mocked(runtime.setModel).mockRejectedValueOnce(new Error('provider rejected model'))

    await expect(
      service.dispatch({
        type: 'command',
        requestId: 'model-1',
        name: COMPOSER_MODEL_SET_CAPABILITY,
        payload: { sessionId: 'session-1', modelId: 'invalid' },
      }),
    ).rejects.toThrow('provider rejected model')
    expect(store.getPreference('workspace-1', 'cursor')).toEqual({})
  })

  it('persists provider catalogs learned from runtime events', async () => {
    const { service } = await harness()
    service.onRuntimeEvent({
      id: 'event-1',
      seq: 1,
      timestamp: '2026-09-09T00:00:00.000Z',
      providerId: 'cursor',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      sessionId: 'provider-session-1',
      category: 'lifecycle',
      event: 'session_created',
      data: {
        models: {
          availableModels: [{ id: 'opus', displayName: 'Opus' }],
          currentModelId: 'opus',
        },
        modes: {
          availableModes: [{ id: 'plan', displayName: 'Plan' }],
          currentModeId: 'plan',
        },
      },
    })

    expect(
      service.dispatch({
        type: 'command',
        requestId: 'catalog-1',
        name: PROVIDER_CATALOG_CAPABILITY,
        payload: null,
      }),
    ).toMatchObject({
      payload: {
        providers: [
          {
            id: 'cursor',
            profile: {
              providerId: 'cursor',
              availableModels: [{ modelId: 'opus', name: 'Opus' }],
              availableModes: [{ id: 'plan', name: 'Plan' }],
              defaultModelId: 'opus',
              defaultModeId: 'plan',
            },
          },
        ],
      },
    })
  })
})
