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
import { createComposerService, desiredSessionConfig } from '../src/composer-service.js'
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
    modelImageInputSupport: vi.fn(async () => new Map<string, boolean | null>()),
  } as unknown as Parameters<typeof createComposerService>[0] & {
    modelImageInputSupport: ReturnType<typeof vi.fn>
  }
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
    service.observeProbe('cursor', {
      result: {
        authMethods: [],
        authenticated: true,
        sessionListAdvertised: false,
        loadSessionAdvertised: false,
      },
      sessions: undefined,
      commands: undefined,
      models: { availableModels: [{ id: 'stale', displayName: 'Stale Probe Model' }] },
      modes: undefined,
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

  it('persists a provider-corrected mode when the selected mode becomes unavailable', async () => {
    const { service, store } = await harness()
    store.setPreference('workspace-1', 'cursor', { modelId: 'opus', modeId: 'auto' })

    service.onRuntimeEvent({
      id: 'event-1',
      seq: 1,
      timestamp: '2026-09-09T00:00:00.000Z',
      providerId: 'cursor',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      sessionId: 'provider-session-1',
      category: 'session',
      event: 'current_mode_update',
      data: {
        currentModeId: 'default',
        availableModes: [{ id: 'default', displayName: 'Default' }],
      },
    })

    expect(store.getPreference('workspace-1', 'cursor')).toEqual({
      modelId: 'opus',
      modeId: 'default',
    })
  })

  it('stores an explicitly empty live catalog and ignores invalid oversized metadata', async () => {
    const { service, store } = await harness()
    store.upsertProfile('cursor', {
      availableModels: [{ modelId: 'old', name: 'Old' }],
    })
    const event = {
      id: 'event-1',
      seq: 1,
      timestamp: '2026-09-09T00:00:00.000Z',
      providerId: 'cursor' as const,
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      sessionId: 'provider-session-1',
      category: 'session' as const,
      event: 'current_model_update' as const,
    }

    service.onRuntimeEvent({ ...event, data: { availableModels: [] } })
    expect(store.getProfile('cursor')?.availableModels).toEqual([])

    expect(() =>
      service.onRuntimeEvent({
        ...event,
        data: {
          availableModels: Array.from({ length: 2_049 }, (_, index) => ({
            id: `model-${index}`,
            displayName: `Model ${index}`,
          })),
        },
      }),
    ).not.toThrow()
    expect(store.getProfile('cursor')?.availableModels).toEqual([])
  })
})

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('what a provider and its models accept in a prompt', () => {
  const initialized = (promptCapabilities?: Record<string, boolean>) => ({
    id: 'event-1',
    seq: 1,
    timestamp: '2026-09-23T00:00:00.000Z',
    providerId: 'cursor' as const,
    threadId: 'desktop-bootstrap:cursor',
    category: 'lifecycle' as const,
    event: 'initialized' as const,
    data: {
      agentInfo: { name: 'cursor-agent' },
      capabilities: provider.capabilities,
      authMethods: [],
      ...(promptCapabilities ? { promptCapabilities } : {}),
    },
  })

  it('records the handshake answer on the profile and publishes it', async () => {
    const { service, store } = await harness()
    const published: unknown[] = []
    const publishing = createComposerService(
      { modelImageInputSupport: async () => new Map() } as unknown as Parameters<
        typeof createComposerService
      >[0],
      { snapshot: () => [provider], rejection: () => undefined },
      store,
      () => undefined,
      { publish: (name, payload) => published.push({ name, payload }) },
    )
    publishing.onRuntimeEvent(initialized({ image: true }))
    expect(store.getProfile('cursor')).toMatchObject({
      agentInfo: { name: 'cursor-agent' },
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    })
    expect(published).toEqual([
      {
        name: 'provider.catalog.updated',
        payload: {
          profile: expect.objectContaining({
            promptCapabilities: { image: true, audio: false, embeddedContext: false },
          }),
        },
      },
    ])
    // The same answer from the next process is not a change worth an event.
    publishing.onRuntimeEvent(initialized({ image: true }))
    expect(published).toHaveLength(1)
    // A handshake that says nothing is "text only", recorded as such rather
    // than left blank for the composer to wait on. Legacy runtimes may still
    // omit the field entirely; that is the one case nothing is recorded.
    publishing.onRuntimeEvent(initialized({}))
    expect(store.getProfile('cursor')?.promptCapabilities).toEqual({
      image: false,
      audio: false,
      embeddedContext: false,
    })
    service.onRuntimeEvent(initialized())
    expect(store.getProfile('cursor')?.promptCapabilities).toEqual({
      image: false,
      audio: false,
      embeddedContext: false,
    })
  })

  it('takes the probe answer too, without a live session', async () => {
    const { service, store } = await harness()
    service.observeProbe('cursor', {
      result: {
        authMethods: [],
        authenticated: true,
        sessionListAdvertised: false,
        loadSessionAdvertised: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      sessions: undefined,
      commands: undefined,
      models: undefined,
      modes: undefined,
    })
    expect(store.getProfile('cursor')?.promptCapabilities).toEqual({
      image: true,
      audio: false,
      embeddedContext: true,
    })
  })

  it('asks the runtime which listed models read images and lands the answers on the rows', async () => {
    const { runtime, service, store } = await harness()
    runtime.modelImageInputSupport.mockImplementation(async (_provider: string, ids: string[]) =>
      new Map(
        ids.map((id) => [id, id === 'anthropic/sonnet' ? true : id === 'openai/o1' ? false : null]),
      ),
    )
    service.onRuntimeEvent({
      id: 'event-1',
      seq: 1,
      timestamp: '2026-09-23T00:00:00.000Z',
      providerId: 'cursor',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      sessionId: 'provider-session-1',
      category: 'lifecycle',
      event: 'session_created',
      data: {
        models: {
          availableModels: [
            { id: 'anthropic/sonnet', displayName: 'Sonnet' },
            { id: 'openai/o1', displayName: 'o1' },
            { id: 'local/llama', displayName: 'Llama' },
          ],
          currentModelId: 'anthropic/sonnet',
        },
      },
    })
    await settle()
    expect(runtime.modelImageInputSupport).toHaveBeenCalledWith('cursor', [
      'anthropic/sonnet',
      'openai/o1',
      'local/llama',
    ])
    expect(store.getProfile('cursor')?.availableModels).toEqual([
      { modelId: 'anthropic/sonnet', name: 'Sonnet', supportsImageInput: true },
      { modelId: 'openai/o1', name: 'o1', supportsImageInput: false },
      // Unanswered stays absent: unknown, not refused.
      { modelId: 'local/llama', name: 'Llama' },
    ])

    // A relisting from the next session carries no flags, and must not lose
    // them; only the genuinely new row is asked about.
    runtime.modelImageInputSupport.mockClear()
    service.onRuntimeEvent({
      id: 'event-2',
      seq: 2,
      timestamp: '2026-09-23T00:00:01.000Z',
      providerId: 'cursor',
      threadId: 'thread-2',
      workspaceId: 'workspace-1',
      sessionId: 'provider-session-2',
      category: 'session',
      event: 'current_model_update',
      data: {
        availableModels: [
          { id: 'openai/o1', displayName: 'o1' },
          { id: 'anthropic/sonnet', displayName: 'Sonnet' },
          { id: 'anthropic/opus', displayName: 'Opus' },
        ],
        currentModelId: 'openai/o1',
      },
    })
    expect(store.getProfile('cursor')?.availableModels).toEqual([
      { modelId: 'openai/o1', name: 'o1', supportsImageInput: false },
      { modelId: 'anthropic/sonnet', name: 'Sonnet', supportsImageInput: true },
      { modelId: 'anthropic/opus', name: 'Opus' },
    ])
    await settle()
    expect(runtime.modelImageInputSupport).toHaveBeenCalledTimes(1)
    expect(runtime.modelImageInputSupport).toHaveBeenCalledWith('cursor', ['anthropic/opus'])
  })

  it('asks again after the hold about rows the lookup could not answer, but not about answered ones', async () => {
    const { runtime, store } = await harness()
    const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = []
    const service = createComposerService(
      runtime,
      { snapshot: () => [provider], rejection: () => undefined },
      store,
      () => undefined,
      {
        modelImageInputRetryMs: 1_000,
        scheduleModelImageInputRetry: (run, delayMs) => {
          const timer = { run, delayMs, cancelled: false }
          timers.push(timer)
          return () => {
            timer.cancelled = true
          }
        },
      },
    )
    // First ask: the CLI is down for `a/*`, so those ids come back unmentioned;
    // `b/known` is answered "nobody can say", which is final.
    runtime.modelImageInputSupport.mockImplementationOnce(
      async () => new Map<string, boolean | null>([['b/known', null]]),
    )
    service.onRuntimeEvent({
      id: 'event-1',
      seq: 1,
      timestamp: '2026-09-23T00:00:00.000Z',
      providerId: 'cursor',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      sessionId: 'provider-session-1',
      category: 'session',
      event: 'current_model_update',
      data: {
        availableModels: [
          { id: 'a/one', displayName: 'One' },
          { id: 'b/known', displayName: 'Known' },
        ],
      },
    })
    await settle()
    expect(timers).toHaveLength(1)
    expect(timers[0]).toMatchObject({ delayMs: 1_000, cancelled: false })

    // The hold lifts and the CLI is back.
    runtime.modelImageInputSupport.mockImplementationOnce(
      async (_provider: string, ids: string[]) =>
        new Map<string, boolean | null>(ids.map((id) => [id, id === 'a/one' ? true : null])),
    )
    timers[0]!.run()
    await settle()
    expect(runtime.modelImageInputSupport).toHaveBeenLastCalledWith('cursor', ['a/one', 'b/known'])
    expect(store.getProfile('cursor')?.availableModels).toEqual([
      { modelId: 'a/one', name: 'One', supportsImageInput: true },
      { modelId: 'b/known', name: 'Known' },
    ])
    // `b/known` was answered `null` both times: final, nothing left to retry.
    expect(timers).toHaveLength(1)
  })

  it('merges a slow answer into the catalog as it is by then, and re-asks for rows that arrived meanwhile', async () => {
    const { runtime, service, store } = await harness()
    let release!: (answers: Map<string, boolean | null>) => void
    runtime.modelImageInputSupport
      .mockImplementationOnce(
        () => new Promise<Map<string, boolean | null>>((resolve) => (release = resolve)),
      )
      .mockImplementation(async (_provider: string, ids: string[]) =>
        new Map(ids.map((id) => [id, true])),
      )
    const listing = (seq: number, ids: string[]) => ({
      id: `event-${seq}`,
      seq,
      timestamp: '2026-09-23T00:00:00.000Z',
      providerId: 'cursor' as const,
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      sessionId: 'provider-session-1',
      category: 'session' as const,
      event: 'current_model_update' as const,
      data: { availableModels: ids.map((id) => ({ id, displayName: id })) },
    })
    service.onRuntimeEvent(listing(1, ['a/one', 'a/two']))
    await settle()
    // While the CLI runs, the catalog changes under it.
    service.onRuntimeEvent(listing(2, ['a/two', 'a/three']))
    release(
      new Map([
        ['a/one', false],
        ['a/two', true],
      ]),
    )
    await settle()
    await settle()
    // `a/one` is gone and stays gone; `a/two` got its answer; `a/three` was
    // asked about in a second pass rather than left unknown.
    expect(store.getProfile('cursor')?.availableModels).toEqual([
      { modelId: 'a/two', name: 'a/two', supportsImageInput: true },
      { modelId: 'a/three', name: 'a/three', supportsImageInput: true },
    ])
    expect(runtime.modelImageInputSupport).toHaveBeenCalledTimes(2)
    expect(runtime.modelImageInputSupport).toHaveBeenLastCalledWith('cursor', ['a/three'])
  })
})

describe('durable runtime config mapping', () => {
  it('maps configValues to runtime values without auto-enforcing the display mode', () => {
    expect(
      desiredSessionConfig({
        modelId: 'opus',
        modeId: 'plan',
        configValues: { effort: 'high', fast: true },
      }),
    ).toEqual({
      modelId: 'opus',
      values: { effort: 'high', fast: true },
    })
    expect(desiredSessionConfig({})).toBeUndefined()
  })
})
