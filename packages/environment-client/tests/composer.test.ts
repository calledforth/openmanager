import { describe, expect, it } from 'vitest'
import { createMockEnvironmentClient } from '../src/mock'
import {
  applyComposerPreference,
  applyProviderCatalog,
  applyWorkspaceList,
  applyWorkspaceRemoved,
  createInitialState,
  selectComposerPreference,
  selectProviderCatalog,
} from '../src/state'
import type { EnvironmentCommandName } from '../src/types'
import { BARE_PROVIDER, PROVIDER, SESSION, THREAD, WORKSPACE } from './fixtures'

const TARGET = { workspaceId: WORKSPACE.workspaceId, providerId: PROVIDER.id }
const COMPOSER_COMMANDS = [
  'getProviderCatalog',
  'getComposerPreference',
  'setComposerPreference',
  'setSessionModel',
  'setSessionMode',
  'setSessionConfigOption',
] as const satisfies readonly EnvironmentCommandName[]

const seed = {
  workspaces: [WORKSPACE],
  providers: [PROVIDER],
  sessions: [{ session: SESSION, threads: [THREAD], providerId: PROVIDER.id }],
}

describe('composer state', () => {
  it('replaces the catalog wholesale and keeps unchanged entries by identity', () => {
    const other = { ...BARE_PROVIDER, id: 'cursor', displayName: 'Cursor' }
    const first = applyProviderCatalog(createInitialState(), [PROVIDER, other])
    expect(selectProviderCatalog(first).map((provider) => provider.id)).toEqual([
      'opencode',
      'cursor',
    ])

    expect(applyProviderCatalog(first, structuredClone([PROVIDER, other]))).toBe(first)

    const renamed = applyProviderCatalog(first, [{ ...PROVIDER, displayName: 'OpenCode 2' }])
    expect(selectProviderCatalog(renamed).map((provider) => provider.displayName)).toEqual([
      'OpenCode 2',
    ])
    expect(renamed.providers.cursor).toBeUndefined()
  })

  it('keeps preferences per workspace and provider and drops them with the workspace', () => {
    let state = applyWorkspaceList(createInitialState(), [WORKSPACE])
    expect(selectComposerPreference(state, TARGET.workspaceId, TARGET.providerId)).toBeNull()

    state = applyComposerPreference(state, TARGET, { modelId: 'opus' })
    state = applyComposerPreference(state, { ...TARGET, providerId: 'cursor' }, {})
    expect(selectComposerPreference(state, TARGET.workspaceId, TARGET.providerId)).toEqual({
      modelId: 'opus',
    })
    // Loaded and empty is different from never loaded.
    expect(selectComposerPreference(state, TARGET.workspaceId, 'cursor')).toEqual({})
    expect(selectComposerPreference(state, 'elsewhere', TARGET.providerId)).toBeNull()
    expect(applyComposerPreference(state, TARGET, { modelId: 'opus' })).toBe(state)

    state = applyWorkspaceRemoved(state, WORKSPACE.workspaceId)
    expect(state.composerPreferences).toEqual({})
  })
})

describe('mock composer commands', () => {
  it('rejects every composer command the environment does not advertise', async () => {
    const client = createMockEnvironmentClient({ seed, capabilities: ['listWorkspaces'] })
    const { commands } = client
    const attempts = [
      commands.getProviderCatalog(),
      commands.getComposerPreference(TARGET),
      commands.setComposerPreference({ ...TARGET, preference: { modelId: 'opus' } }),
      commands.setSessionModel({ sessionId: SESSION.sessionId, modelId: 'opus' }),
      commands.setSessionMode({ sessionId: SESSION.sessionId, modeId: 'plan' }),
      commands.setSessionConfigOption({
        sessionId: SESSION.sessionId,
        configId: 'effort',
        value: 'high',
      }),
    ]
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({ code: 'capability_missing' })
    }
    for (const command of COMPOSER_COMMANDS) expect(client.supports(command)).toBe(false)
    expect(client.getState().providers).toEqual({})
    expect(client.getState().composerPreferences).toEqual({})
  })

  it('gates each composer command on its own capability', async () => {
    const client = createMockEnvironmentClient({ seed, capabilities: ['getProviderCatalog'] })
    expect(await client.commands.getProviderCatalog()).toEqual([PROVIDER])
    await expect(client.commands.getComposerPreference(TARGET)).rejects.toMatchObject({
      code: 'capability_missing',
      details: { command: 'getComposerPreference' },
    })
  })

  it('reads the catalog into state for the pickers', async () => {
    const client = createMockEnvironmentClient({ seed })
    expect(await client.commands.getProviderCatalog()).toEqual([PROVIDER])
    const [provider] = selectProviderCatalog(client.getState())
    expect(provider?.profile?.availableModels?.map((model) => model.modelId)).toEqual([
      'sonnet',
      'opus',
    ])
    expect(provider?.profile?.availableModes?.map((mode) => mode.id)).toEqual(['build', 'plan'])
  })

  it('loads a remembered preference into state only once it is read', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        ...seed,
        composerPreferences: { [WORKSPACE.workspaceId]: { [PROVIDER.id]: { modelId: 'opus' } } },
      },
    })
    const read = () =>
      selectComposerPreference(client.getState(), TARGET.workspaceId, TARGET.providerId)
    expect(read()).toBeNull()
    expect(await client.commands.getComposerPreference(TARGET)).toEqual({ modelId: 'opus' })
    expect(read()).toEqual({ modelId: 'opus' })
  })

  it('merges preference patches the way the environment does', async () => {
    const client = createMockEnvironmentClient({ seed })
    await client.commands.setComposerPreference({ ...TARGET, preference: { modelId: 'opus' } })
    const merged = await client.commands.setComposerPreference({
      ...TARGET,
      preference: { modeId: 'plan' },
    })
    expect(merged).toEqual({ modelId: 'opus', modeId: 'plan' })
    expect(
      selectComposerPreference(client.getState(), TARGET.workspaceId, TARGET.providerId),
    ).toEqual(merged)
  })

  it('remembers session model, mode and config choices for the session workspace', async () => {
    const client = createMockEnvironmentClient({ seed })
    const sessionId = SESSION.sessionId
    await client.commands.setSessionModel({ sessionId, modelId: 'opus' })
    await client.commands.setSessionMode({ sessionId, modeId: 'plan' })
    await client.commands.setSessionConfigOption({ sessionId, configId: 'effort', value: 'high' })
    const preference = await client.commands.setSessionConfigOption({
      sessionId,
      configId: 'fast',
      value: true,
    })
    expect(preference).toEqual({
      modelId: 'opus',
      modeId: 'plan',
      configValues: { effort: 'high', fast: true },
    })
    expect(
      selectComposerPreference(client.getState(), TARGET.workspaceId, TARGET.providerId),
    ).toEqual(preference)
    expect(client.calls.map((call) => call.command)).toEqual([
      'setSessionModel',
      'setSessionMode',
      'setSessionConfigOption',
      'setSessionConfigOption',
    ])
  })

  it('rejects unknown providers, unknown sessions and wire-invalid input', async () => {
    const client = createMockEnvironmentClient({ seed })
    await expect(
      client.commands.getComposerPreference({ ...TARGET, providerId: 'missing' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      client.commands.setSessionModel({ sessionId: 'missing', modelId: 'opus' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      client.commands.setSessionModel({ sessionId: SESSION.sessionId, modelId: '' }),
    ).rejects.toMatchObject({ code: 'validation' })
    expect(client.getState().composerPreferences).toEqual({})
  })
})
