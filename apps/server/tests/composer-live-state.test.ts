import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
  COMPOSER_MODEL_SET_CAPABILITY,
  COMPOSER_MODE_SET_CAPABILITY,
  COMPOSER_PREFERENCES_SET_CAPABILITY,
  type ComposerListing,
  type ProviderBootstrap,
} from '@openmanager/protocol/node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComposerService } from '../src/composer-service.js'
import type { ComposerStore } from '../src/composer-store.js'
import { openTestComposerStore } from './helpers/composer-store.js'

const directories: string[] = []
const stores: ComposerStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

const provider = { id: 'claude' } as ProviderBootstrap

/** Two sessions of one provider in one workspace, each on its own runtime thread. */
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-composer-live-test-'))
  directories.push(directory)
  // Everything a client hears: the selection the service publishes, and the
  // profile and preference events the store commits.
  const published: Array<{ name: string; payload: unknown }> = []
  const store = openTestComposerStore(directory, (event) =>
    published.push({ name: event.name, payload: event.payload }),
  )
  stores.push(store)
  const runtime = {
    setModel: vi.fn().mockResolvedValue(undefined),
    setMode: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue(undefined),
    applyDesiredConfig: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof createComposerService>[0]
  const route = (threadId: string) => ({
    providerId: 'claude' as const,
    threadId,
    workspaceId: 'workspace-1',
    cwd: '/workspace/one',
    sessionId: `provider-${threadId}`,
  })
  const threads: Record<string, string> = { 'thread-a': 'session-a', 'thread-b': 'session-b' }
  let workspace: ComposerListing | undefined
  const service = createComposerService(
    runtime,
    { snapshot: () => [provider], rejection: () => undefined },
    store,
    (sessionId) =>
      sessionId === 'session-a'
        ? Promise.resolve(route('thread-a'))
        : sessionId === 'session-b'
          ? Promise.resolve(route('thread-b'))
          : undefined,
    {
      publish: (name, payload) => published.push({ name, payload }),
      publishThreadListing: (target, listing) =>
        published.push({ name: 'thread.listing.updated', payload: { ...target, listing } }),
      sessionForThread: (threadId) => threads[threadId],
      listingTarget: () => ({ workspaceId: 'workspace-1', providerId: 'claude' }),
      readWorkspaceListing: () => workspace,
    },
  )
  const named = (name: string) =>
    published.filter((event) => event.name === name).map((event) => event.payload)
  const holdWorkspaceListing = (listing: ComposerListing) => {
    workspace = listing
  }
  return { runtime, service, store, published, named, holdWorkspaceListing }
}

const runtimeEvent = (threadId: string) => ({
  id: 'event-1',
  seq: 1,
  timestamp: '2026-09-19T00:00:00.000Z',
  providerId: 'claude' as const,
  threadId,
  workspaceId: 'workspace-1',
  sessionId: `provider-${threadId}`,
})

const setModel = (sessionId: string, modelId: string) => ({
  type: 'command' as const,
  requestId: `model-${sessionId}-${modelId}`,
  name: COMPOSER_MODEL_SET_CAPABILITY,
  payload: { sessionId, modelId },
})

describe('per-session composer selection', () => {
  it('keeps one session on its model when a sibling in the same workspace switches', async () => {
    const { service } = await harness()
    await service.dispatch(setModel('session-a', 'opus'))
    await service.dispatch(setModel('session-b', 'fable'))

    expect(service.sessionComposer('session-a')).toEqual({ modelId: 'opus' })
    expect(service.sessionComposer('session-b')).toEqual({ modelId: 'fable' })
    // Each runtime is configured for its own session, not the workspace's last pick.
    const desired = (threadId: string) =>
      service.desiredFor({ providerId: 'claude', workspacePath: 'workspace-1', threadId })
    expect(desired('thread-a')).toEqual({ modelId: 'opus' })
    expect(desired('thread-b')).toEqual({ modelId: 'fable' })
  })

  it('remembers the last pick as the workspace preference for the next draft', async () => {
    const { service, store } = await harness()
    await service.dispatch(setModel('session-a', 'opus'))
    await service.dispatch(setModel('session-b', 'fable'))

    expect(store.getPreference('workspace-1', 'claude')).toEqual({ modelId: 'fable' })
    // A thread with no session of its own yet launches with that preference.
    expect(
      service.desiredFor({
        providerId: 'claude',
        workspacePath: 'workspace-1',
        threadId: 'thread-new',
      }),
    ).toEqual({ modelId: 'fable' })
  })

  it('keeps config values per session and re-applies the session values after a model change', async () => {
    const { runtime, service } = await harness()
    await service.dispatch({
      type: 'command',
      requestId: 'config-a',
      name: COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
      payload: { sessionId: 'session-a', configId: 'effort', value: 'high' },
    })
    await service.dispatch({
      type: 'command',
      requestId: 'config-b',
      name: COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
      payload: { sessionId: 'session-b', configId: 'effort', value: 'low' },
    })
    await service.dispatch(setModel('session-a', 'opus'))

    expect(service.sessionComposer('session-a').configValues).toEqual({ effort: 'high' })
    expect(service.sessionComposer('session-b').configValues).toEqual({ effort: 'low' })
    expect(runtime.applyDesiredConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: 'thread-a' }),
      { values: { effort: 'high' } },
    )
  })

  it('seeds a session without a selection from the workspace preference, then lets it own it', async () => {
    const { service, store } = await harness()
    store.setPreference('workspace-1', 'claude', {
      modelId: 'opus',
      configValues: { effort: 'high' },
    })
    service.onRuntimeEvent({
      ...runtimeEvent('thread-a'),
      category: 'lifecycle',
      event: 'session_loaded',
      data: {
        models: { currentModelId: 'default', availableModels: [] },
        modes: { currentModeId: 'plan', availableModes: [] },
      },
    })
    expect(service.sessionComposer('session-a')).toEqual({
      modelId: 'opus',
      modeId: 'plan',
      configValues: { effort: 'high' },
    })

    store.setPreference('workspace-1', 'claude', { modelId: 'fable' })
    service.onRuntimeEvent({
      ...runtimeEvent('thread-a'),
      category: 'lifecycle',
      event: 'session_loaded',
      data: { models: { currentModelId: 'default', availableModels: [] } },
    })
    expect(service.sessionComposer('session-a').modelId).toBe('opus')
  })

  it('restores a session to its own mode after its process restarts', async () => {
    const { service } = await harness()
    await service.dispatch({
      type: 'command',
      requestId: 'mode-a',
      name: COMPOSER_MODE_SET_CAPABILITY,
      payload: { sessionId: 'session-a', modeId: 'bypassPermissions' },
    })
    const mode = (id: string) => ({ id, displayName: id })
    const modes = [mode('default'), mode('plan'), mode('bypassPermissions')]
    const loaded = (currentModeId: string, availableModes = modes) =>
      service.onRuntimeEvent({
        ...runtimeEvent('thread-a'),
        category: 'lifecycle',
        event: 'session_loaded',
        data: { modes: { currentModeId, availableModes } },
      })

    // A restarted process reports the provider's default before the session's
    // mode is re-applied. That report must not overwrite what it will become.
    loaded('default')
    expect(service.sessionComposer('session-a').modeId).toBe('bypassPermissions')
    expect(
      service.desiredFor({
        providerId: 'claude',
        workspacePath: 'workspace-1',
        threadId: 'thread-a',
      }),
    ).toEqual({ modeId: 'bypassPermissions' })
    // The sibling never picked a mode, so the workspace's last pick is not
    // forced on it.
    expect(
      service.desiredFor({
        providerId: 'claude',
        workspacePath: 'workspace-1',
        threadId: 'thread-b',
      }),
    ).toBeUndefined()

    // A mode the provider stopped offering gives way to what it reports.
    loaded('default', [mode('default'), mode('plan')])
    expect(service.sessionComposer('session-a').modeId).toBe('default')
  })

  it("follows the agent's own mode switch, so a restart restores where it went", async () => {
    const { service } = await harness()
    await service.dispatch({
      type: 'command',
      requestId: 'mode-a',
      name: COMPOSER_MODE_SET_CAPABILITY,
      payload: { sessionId: 'session-a', modeId: 'plan' },
    })
    // An approved plan: the agent leaves plan on its own.
    service.onRuntimeEvent({
      ...runtimeEvent('thread-a'),
      category: 'session',
      event: 'current_mode_update',
      data: { currentModeId: 'default', availableModes: [] },
    })
    expect(
      service.desiredFor({
        providerId: 'claude',
        workspacePath: 'workspace-1',
        threadId: 'thread-a',
      }),
    ).toEqual({ modeId: 'default' })
  })

  it('keeps a launched session on the picks it launched with while a sibling launches', async () => {
    const { service, store } = await harness()
    // Draft A launches: its picks are filed and it keeps what came back.
    const launchedA = service.launchPreference('workspace-1', 'claude', {
      modelId: 'opus',
      configValues: { effort: 'high' },
    })
    service.seedSession('session-a', launchedA)
    // Draft B launches before A's provider has reported anything.
    service.seedSession(
      'session-b',
      service.launchPreference('workspace-1', 'claude', { modelId: 'fable' }),
    )
    expect(store.getPreference('workspace-1', 'claude')).toEqual({
      modelId: 'fable',
      configValues: { effort: 'high' },
    })

    service.onRuntimeEvent({
      ...runtimeEvent('thread-a'),
      category: 'lifecycle',
      event: 'session_created',
      data: { models: { currentModelId: 'default', availableModels: [] } },
    })
    expect(service.sessionComposer('session-a')).toMatchObject({
      modelId: 'opus',
      configValues: { effort: 'high' },
    })
    expect(
      service.desiredFor({
        providerId: 'claude',
        workspacePath: 'workspace-1',
        threadId: 'thread-a',
      }),
    ).toEqual({ modelId: 'opus', values: { effort: 'high' } })
    // With no picks, a launch reads what the workspace remembers.
    expect(service.launchPreference('workspace-1', 'claude')).toEqual({
      modelId: 'fable',
      configValues: { effort: 'high' },
    })
  })
})

describe('composer broadcasts', () => {
  it('announces a session change to every client, and the preference it leaves behind', async () => {
    const { service, named } = await harness()
    await service.dispatch(setModel('session-a', 'opus'))
    await service.dispatch({
      type: 'command',
      requestId: 'mode-a',
      name: COMPOSER_MODE_SET_CAPABILITY,
      payload: { sessionId: 'session-a', modeId: 'plan' },
    })

    expect(named('session.composer.updated')).toEqual([
      { sessionId: 'session-a', composer: { modelId: 'opus' } },
      { sessionId: 'session-a', composer: { modelId: 'opus', modeId: 'plan' } },
    ])
    expect(named('composer.preferences.updated').at(-1)).toEqual({
      workspaceId: 'workspace-1',
      providerId: 'claude',
      preference: { modelId: 'opus', modeId: 'plan' },
      // Two changes, counted by the server.
      revision: 2,
    })
  })

  it('says nothing when a write changes nothing', async () => {
    const { service, published } = await harness()
    await service.dispatch(setModel('session-a', 'opus'))
    const before = published.length
    await service.dispatch(setModel('session-a', 'opus'))
    expect(published).toHaveLength(before)
  })

  it('announces a draft preference written without any session', async () => {
    const { service, named } = await harness()
    service.dispatch({
      type: 'command',
      requestId: 'preference-1',
      name: COMPOSER_PREFERENCES_SET_CAPABILITY,
      payload: {
        workspaceId: 'workspace-1',
        providerId: 'claude',
        preference: { modelId: 'opus' },
      },
    })
    expect(named('composer.preferences.updated')).toEqual([
      {
        workspaceId: 'workspace-1',
        providerId: 'claude',
        preference: { modelId: 'opus' },
        revision: 1,
      },
    ])
    expect(named('session.composer.updated')).toEqual([])
  })

  it('follows a mode the agent switched by itself, for that session only', async () => {
    const { service, named } = await harness()
    service.onRuntimeEvent({
      ...runtimeEvent('thread-a'),
      category: 'session',
      event: 'current_mode_update',
      data: { currentModeId: 'acceptEdits' },
    })

    expect(named('session.composer.updated')).toEqual([
      { sessionId: 'session-a', composer: { modeId: 'acceptEdits' } },
    ])
    expect(service.sessionComposer('session-b')).toEqual({})
  })

  it('records the mode a plan build starts in', async () => {
    const { service, named } = await harness()
    service.recordSessionMode('session-a', 'acceptEdits')
    expect(named('session.composer.updated')).toEqual([
      { sessionId: 'session-a', composer: { modeId: 'acceptEdits' } },
    ])
  })

  it('keeps the chosen model when the agent reports another, unless the choice is gone', async () => {
    const { service } = await harness()
    await service.dispatch(setModel('session-a', 'opus'))
    const report = (availableModels: Array<{ id: string; displayName: string }>) =>
      service.onRuntimeEvent({
        ...runtimeEvent('thread-a'),
        category: 'session',
        event: 'current_model_update',
        data: { currentModelId: 'sonnet', availableModels },
      })

    report([
      { id: 'opus', displayName: 'Opus' },
      { id: 'sonnet', displayName: 'Sonnet' },
    ])
    expect(service.sessionComposer('session-a').modelId).toBe('opus')

    report([{ id: 'sonnet', displayName: 'Sonnet' }])
    expect(service.sessionComposer('session-a').modelId).toBe('sonnet')
  })

  it('carries config option listings and drops ones the protocol cannot express', async () => {
    const { service } = await harness()
    service.onRuntimeEvent({
      ...runtimeEvent('thread-a'),
      category: 'session',
      event: 'config_option_update',
      data: {
        configOptions: [
          { type: 'boolean', id: 'fast', name: 'Fast mode', currentValue: true },
          { type: 'boolean', id: '', name: 'Nameless', currentValue: false },
        ],
      },
    })
    expect(service.threadListing('thread-a').configOptions).toEqual([
      { type: 'boolean', id: 'fast', name: 'Fast mode', currentValue: true },
    ])
  })

  it('carries the slash commands a session lists, and the listing that replaces them', async () => {
    const { service, named } = await harness()
    const list = (availableCommands: Array<Record<string, unknown>>) =>
      service.onRuntimeEvent({
        ...runtimeEvent('thread-a'),
        category: 'session',
        event: 'available_commands_update',
        data: { availableCommands },
      } as Parameters<typeof service.onRuntimeEvent>[0])

    list([
      { name: 'review', description: 'Review the diff' },
      { name: 'search', description: '', input: { type: 'unstructured', placeholder: 'query' } },
      { name: '', description: 'Nameless' },
    ])
    const listed = [
      { name: 'review', description: 'Review the diff' },
      { name: 'search', description: '', placeholder: 'query' },
    ]
    expect(named('thread.listing.updated')).toEqual([
      {
        sessionId: 'session-a',
        threadId: 'thread-a',
        listing: { availableCommands: listed },
      },
    ])
    // Nothing a provider lists reaches the sidebar's stream as a session's.
    expect(named('session.composer.updated')).toEqual([])
    expect(service.threadListing('thread-b')).toEqual({})

    // A reloaded session lists again; the same listing is not news, none is.
    list([
      { name: 'review', description: 'Review the diff' },
      { name: 'search', description: '', input: { type: 'unstructured', placeholder: 'query' } },
    ])
    expect(named('thread.listing.updated')).toHaveLength(1)
    list([])
    expect(service.threadListing('thread-a').availableCommands).toEqual([])
  })

  it('keeps what a provider listed for the next chat in the workspace', async () => {
    const { service, named, holdWorkspaceListing } = await harness()
    const report = (threadId: string, event: string, data: unknown) =>
      service.onRuntimeEvent({
        ...runtimeEvent(threadId),
        category: 'session',
        event,
        data,
      } as Parameters<typeof service.onRuntimeEvent>[0])
    const review = { name: 'review', description: 'Review the diff' }
    const select = (currentValue: string) => ({
      type: 'select' as const,
      id: 'style',
      name: 'Style',
      currentValue,
      options: [{ value: 'plain', name: 'Plain' }],
    })
    const target = { workspaceId: 'workspace-1', providerId: 'claude' }

    report('thread-a', 'available_commands_update', { availableCommands: [review] })
    expect(named('composer.listing.updated')).toEqual([{ ...target, availableCommands: [review] }])
    holdWorkspaceListing({ availableCommands: [review] })

    // The same commands from a sibling are not news.
    report('thread-b', 'available_commands_update', { availableCommands: [review] })
    expect(named('composer.listing.updated')).toHaveLength(1)

    // Settings announce alone, and empty settings are a session yet to report.
    report('thread-a', 'config_option_update', { configOptions: [] })
    expect(named('composer.listing.updated')).toHaveLength(1)
    report('thread-a', 'config_option_update', { configOptions: [select('plain')] })
    expect(named('composer.listing.updated')[1]).toEqual({
      ...target,
      configOptions: [select('plain')],
    })
    holdWorkspaceListing({ availableCommands: [review], configOptions: [select('plain')] })

    // A value alone changes what a chat shows, not what a provider offers.
    report('thread-b', 'config_option_update', { configOptions: [select('other')] })
    expect(named('composer.listing.updated')).toHaveLength(2)
    expect(named('thread.listing.updated')).toHaveLength(4)

    // An empty command list is the provider offering none: the next chat has none.
    report('thread-b', 'available_commands_update', { availableCommands: [] })
    expect(named('composer.listing.updated')[2]).toEqual({ ...target, availableCommands: [] })
  })

  it('carries the context usage a provider reports, and nothing for one that reports none', async () => {
    const { service, named } = await harness()
    const report = (data: {
      used: number
      size: number
      cost?: { amount: number; currency: string }
    }) =>
      service.onRuntimeEvent({
        ...runtimeEvent('thread-a'),
        category: 'session',
        event: 'usage_update',
        data,
      })

    report({ used: 19_433, size: 200_000, cost: { amount: 0.42, currency: 'USD' } })
    expect(named('session.composer.updated')).toEqual([
      {
        sessionId: 'session-a',
        composer: {
          usage: { used: 19_433, size: 200_000, cost: { amount: 0.42, currency: 'USD' } },
        },
      },
    ])
    // A sibling whose provider never reports usage has no meter to show.
    expect(service.sessionComposer('session-b').usage).toBeUndefined()

    // The same reading is not news, and one without a window size is not a reading.
    report({ used: 19_433, size: 200_000, cost: { amount: 0.42, currency: 'USD' } })
    report({ used: 25_000, size: 0 })
    expect(named('session.composer.updated')).toHaveLength(1)

    report({ used: 23_854, size: 200_000 })
    expect(service.sessionComposer('session-a').usage).toEqual({ used: 23_854, size: 200_000 })
  })

  it('announces a catalog once per real change', async () => {
    const { service, named } = await harness()
    const created = {
      ...runtimeEvent('thread-a'),
      category: 'lifecycle' as const,
      event: 'session_created' as const,
      data: {
        models: { currentModelId: 'opus', availableModels: [{ id: 'opus', displayName: 'Opus' }] },
      },
    }
    service.onRuntimeEvent(created)
    service.onRuntimeEvent(created)

    expect(named('provider.catalog.updated')).toHaveLength(1)
    expect(named('provider.catalog.updated')[0]).toMatchObject({
      profile: {
        providerId: 'claude',
        availableModels: [{ modelId: 'opus', name: 'Opus' }],
        defaultModelId: 'opus',
      },
    })
  })

  it('keeps answering with a selection whose durable write failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-composer-live-test-'))
    directories.push(directory)
    const store = openTestComposerStore(directory)
    stores.push(store)
    // The persisted row is what the event projector would have written.
    let persisted: { modelId?: string } | undefined
    let failing = true
    const service = createComposerService(
      {
        setModel: vi.fn().mockResolvedValue(undefined),
      } as unknown as Parameters<typeof createComposerService>[0],
      { snapshot: () => [provider], rejection: () => undefined },
      store,
      () =>
        Promise.resolve({
          providerId: 'claude' as const,
          threadId: 'thread-a',
          workspaceId: 'workspace-1',
          cwd: '/workspace/one',
          sessionId: 'provider-thread-a',
        }),
      {
        publish: (name, payload) => {
          if (name !== 'session.composer.updated') return
          if (failing) throw new Error('event log is down')
          persisted = (payload as { composer: { modelId?: string } }).composer
        },
        sessionForThread: () => 'session-a',
        readSessionComposer: () => persisted,
      },
    )

    // The provider already switched, so the next prompt must not switch it back.
    await service.dispatch(setModel('session-a', 'opus'))
    expect(persisted).toBeUndefined()
    expect(service.sessionComposer('session-a')).toEqual({ modelId: 'opus' })
    expect(
      service.desiredFor({ providerId: 'claude', workspacePath: 'workspace-1', threadId: 't' }),
    ).toEqual({ modelId: 'opus' })

    // Once a write lands, the persisted row is the only copy again.
    failing = false
    await service.dispatch(setModel('session-a', 'fable'))
    expect(persisted).toEqual({ modelId: 'fable' })
    persisted = { modelId: 'sonnet' }
    expect(service.sessionComposer('session-a')).toEqual({ modelId: 'sonnet' })
  })

  it('never lets a failing publisher fail the command or the runtime event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-composer-live-test-'))
    directories.push(directory)
    const store = openTestComposerStore(directory)
    stores.push(store)
    const service = createComposerService(
      {
        setModel: vi.fn().mockResolvedValue(undefined),
      } as unknown as Parameters<typeof createComposerService>[0],
      { snapshot: () => [provider], rejection: () => undefined },
      store,
      () =>
        Promise.resolve({
          providerId: 'claude' as const,
          threadId: 'thread-a',
          workspaceId: 'workspace-1',
          cwd: '/workspace/one',
          sessionId: 'provider-thread-a',
        }),
      {
        publish: () => {
          throw new Error('event log is down')
        },
        sessionForThread: () => 'session-a',
      },
    )

    await expect(service.dispatch(setModel('session-a', 'opus'))).resolves.toMatchObject({
      payload: { preference: { modelId: 'opus' } },
    })
    expect(() =>
      service.onRuntimeEvent({
        ...runtimeEvent('thread-a'),
        category: 'session',
        event: 'current_mode_update',
        data: { currentModeId: 'plan' },
      }),
    ).not.toThrow()
  })
})
