import { describe, expect, it } from 'vitest'
import type { ProofEvent } from '@openmanager/protocol'
import { createMockEnvironmentClient } from '../src/mock'
import {
  applyComposerPreference,
  applyComposerPreferencesReset,
  applyEvent,
  applyProviderCatalog,
  applySessionList,
  applySnapshot,
  applyWorkspaceList,
  createInitialState,
  selectComposerPreference,
  selectSessionComposer,
} from '../src/state'
import {
  ENV,
  PROVIDER,
  SESSION,
  SESSION_SUMMARY,
  THREAD,
  WORKSPACE,
  environmentScope,
  event,
} from './fixtures'

type ComposerUpdated = Extract<ProofEvent, { name: 'session.composer.updated' }>
type PreferencesUpdated = Extract<ProofEvent, { name: 'composer.preferences.updated' }>
type CatalogUpdated = Extract<ProofEvent, { name: 'provider.catalog.updated' }>

const SIBLING = { ...SESSION_SUMMARY, sessionId: 'session-2' }

const composerUpdated = (sessionId: string, composer: ComposerUpdated['payload']['composer']) =>
  event<ComposerUpdated>({
    name: 'session.composer.updated',
    scope: environmentScope,
    payload: { sessionId, composer },
  })

const listed = () =>
  applySessionList(applyWorkspaceList(createInitialState(), [WORKSPACE]), [
    SESSION_SUMMARY,
    SIBLING,
  ])

describe('live session composer state', () => {
  it('follows a selection another client or the agent made, for that session only', () => {
    const state = applyEvent(
      listed(),
      composerUpdated(SESSION.sessionId, { modelId: 'opus', modeId: 'plan' }),
    )
    expect(selectSessionComposer(state, SESSION.sessionId)).toEqual({
      modelId: 'opus',
      modeId: 'plan',
    })
    expect(selectSessionComposer(state, SIBLING.sessionId)).toBeNull()
  })

  it('keeps state by identity when a replayed event repeats the selection', () => {
    const update = composerUpdated(SESSION.sessionId, { modelId: 'opus' })
    const state = applyEvent(listed(), update)
    expect(applyEvent(state, structuredClone(update))).toBe(state)
  })

  it('ignores a selection for a session this client has not listed', () => {
    const state = listed()
    expect(applyEvent(state, composerUpdated('unlisted', { modelId: 'opus' }))).toBe(state)
  })

  it('takes the selection from a listing and keeps it when a bare session arrives', () => {
    let state = applySessionList(applyWorkspaceList(createInitialState(), [WORKSPACE]), [
      { ...SESSION_SUMMARY, composer: { modelId: 'opus' } },
    ])
    expect(selectSessionComposer(state, SESSION.sessionId)).toEqual({ modelId: 'opus' })

    // `session.created` and session snapshots carry no summary fields at all.
    state = applyEvent(
      state,
      event<Extract<ProofEvent, { name: 'session.created' }>>({
        name: 'session.created',
        scope: environmentScope,
        payload: { session: SESSION },
      }),
    )
    expect(selectSessionComposer(state, SESSION.sessionId)).toEqual({ modelId: 'opus' })
  })

  it('restores the selection from an environment snapshot after a reconnect', () => {
    const state = applySnapshot(createInitialState(), {
      cursor: { scope: environmentScope, epoch: 'epoch-1', sequence: 4 },
      state: {
        environment: { environmentId: ENV, name: 'Local' },
        workspaces: [WORKSPACE],
        sessions: [{ ...SESSION_SUMMARY, composer: { modelId: 'opus', modeId: 'plan' } }],
      },
    })
    expect(selectSessionComposer(state, SESSION.sessionId)).toEqual({
      modelId: 'opus',
      modeId: 'plan',
    })
  })
})

describe('live preferences and catalog', () => {
  const target = { workspaceId: WORKSPACE.workspaceId, providerId: PROVIDER.id }
  const preferencesUpdated = (workspaceId: string) =>
    event<PreferencesUpdated>({
      name: 'composer.preferences.updated',
      scope: environmentScope,
      payload: { workspaceId, providerId: PROVIDER.id, preference: { modelId: 'opus' } },
    })

  it('loads the draft preference another client wrote', () => {
    const state = applyEvent(listed(), preferencesUpdated(WORKSPACE.workspaceId))
    expect(selectComposerPreference(state, target.workspaceId, target.providerId)).toEqual({
      modelId: 'opus',
    })
  })

  it('does not give a preference back to a workspace this client no longer lists', () => {
    const state = listed()
    expect(applyEvent(state, preferencesUpdated('removed-workspace'))).toBe(state)
  })

  it('reads every held preference as unloaded once a gap made them untrustworthy', () => {
    const state = applyComposerPreference(listed(), target, { modelId: 'opus' })
    const reset = applyComposerPreferencesReset(state)
    expect(selectComposerPreference(reset, target.workspaceId, target.providerId)).toBeNull()
    expect(applyComposerPreferencesReset(reset)).toBe(reset)
  })

  it('patches a loaded provider with the catalog the environment just learned', () => {
    const profile = {
      providerId: PROVIDER.id,
      availableModels: [{ modelId: 'fable', name: 'Fable' }],
      updatedAt: 2,
    }
    const update = event<CatalogUpdated>({
      name: 'provider.catalog.updated',
      scope: environmentScope,
      payload: { profile },
    })
    const state = applyEvent(applyProviderCatalog(createInitialState(), [PROVIDER]), update)
    expect(state.providers[PROVIDER.id]).toMatchObject({ displayName: 'OpenCode', profile })
    expect(applyEvent(state, structuredClone(update))).toBe(state)

    // An unloaded catalog is read whole, health included, not pieced together.
    const empty = createInitialState()
    expect(applyEvent(empty, update)).toBe(empty)
  })
})

describe('mock session setters', () => {
  it('change one session and leave its sibling in the same workspace alone', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        workspaces: [WORKSPACE],
        providers: [PROVIDER],
        sessions: [
          { session: SESSION, threads: [THREAD], providerId: PROVIDER.id },
          {
            session: { ...SESSION, sessionId: SIBLING.sessionId },
            threads: [{ threadId: 'thread-2', sessionId: SIBLING.sessionId }],
            providerId: PROVIDER.id,
          },
        ],
      },
    })
    await client.commands.setSessionModel({ sessionId: SESSION.sessionId, modelId: 'opus' })
    await client.commands.setSessionModel({ sessionId: SIBLING.sessionId, modelId: 'sonnet' })
    await client.commands.setSessionMode({ sessionId: SESSION.sessionId, modeId: 'plan' })
    await client.commands.setSessionConfigOption({
      sessionId: SESSION.sessionId,
      configId: 'effort',
      value: 'high',
    })

    expect(selectSessionComposer(client.getState(), SESSION.sessionId)).toEqual({
      modelId: 'opus',
      modeId: 'plan',
      configValues: { effort: 'high' },
    })
    expect(selectSessionComposer(client.getState(), SIBLING.sessionId)).toEqual({
      modelId: 'sonnet',
    })
  })
})
