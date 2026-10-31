import { describe, expect, it } from 'vitest'
import { packComposerListings, type ComposerListing, type ProofEvent } from '@openmanager/protocol'
import { createMockEnvironmentClient } from '../src/mock'
import {
  applyComposerPreference,
  applyComposerPreferencesReset,
  applyEvent,
  applyProviderCatalog,
  applySnapshot,
  applyWorkspaceList,
  applyWorkspaceRemoved,
  createInitialState,
  selectComposerPreference,
  selectDraftListing,
  selectSessionComposer,
  selectSessionListing,
} from '../src/state'
import { applySessionList } from './seed'
import {
  ENV,
  PROVIDER,
  SESSION,
  SESSION_CREATED,
  SESSION_SUMMARY,
  THREAD,
  WORKSPACE,
  environmentScope,
  event,
  sessionScope,
  threadScope,
} from './fixtures'

type ComposerUpdated = Extract<ProofEvent, { name: 'session.composer.updated' }>
type ThreadListingUpdated = Extract<ProofEvent, { name: 'thread.listing.updated' }>
type WorkspaceListingUpdated = Extract<ProofEvent, { name: 'composer.listing.updated' }>
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

describe('provider listings', () => {
  const review = { name: 'review', description: 'Review the diff' }
  const fast = { type: 'boolean' as const, id: 'fast', name: 'Fast', currentValue: true }
  const listingUpdated = (
    timestamp: string,
    workspaceId: string,
    providerId: string,
    listing: ComposerListing,
  ) => ({
    ...event<WorkspaceListingUpdated>({
      name: 'composer.listing.updated',
      scope: environmentScope,
      payload: { workspaceId, providerId, ...listing },
    }),
    timestamp,
  })
  const withWorkspaces = (...ids: string[]) =>
    applyWorkspaceList(
      createInitialState(),
      ids.map((workspaceId) => ({ ...WORKSPACE, workspaceId })),
    )
  const AT = '2026-10-31T10:00:00.000Z'
  const LATER = '2026-10-31T11:00:00.000Z'

  it('files a chat listing on its thread, replacing the last', () => {
    const state = listed()
    const opened = applySnapshot(state, {
      cursor: { scope: sessionScope, epoch: 'epoch', sequence: 1 },
      state: { session: SESSION_SUMMARY, threads: [THREAD] },
    })
    const update = (listing: ComposerListing) =>
      event<ThreadListingUpdated>({
        name: 'thread.listing.updated',
        scope: threadScope,
        payload: { listing },
      })
    const first = applyEvent(opened, update({ availableCommands: [review] }))
    expect(selectSessionListing(first, SESSION.sessionId)).toEqual({ availableCommands: [review] })
    const second = applyEvent(first, update({ configOptions: [fast] }))
    expect(selectSessionListing(second, SESSION.sessionId)).toEqual({ configOptions: [fast] })
    // A chat this client has no thread for holds nothing until it opens it.
    expect(applyEvent(state, update({}))).toBe(state)
  })

  it('gives a new chat its workspace’s listing, or the provider’s newest elsewhere', () => {
    let state = withWorkspaces('a', 'b', 'c')
    state = applyEvent(state, listingUpdated(AT, 'a', 'claude', { availableCommands: [review] }))
    state = applyEvent(state, listingUpdated(LATER, 'b', 'claude', { configOptions: [fast] }))
    // A field the event does not name stays as held.
    state = applyEvent(state, listingUpdated(LATER, 'a', 'claude', { configOptions: [fast] }))
    expect(state.composerListings.a?.claude).toEqual({
      listing: { availableCommands: [review], configOptions: [fast] },
      updatedAt: LATER,
    })
    expect(selectDraftListing(state, 'availableCommands', 'a', 'claude')).toEqual([review])
    expect(selectDraftListing(state, 'availableCommands', 'c', 'claude')).toEqual([review])
    expect(selectDraftListing(state, 'availableCommands', 'c', 'cursor')).toBeUndefined()

    // An empty list is an answer; it does not fall back.
    state = applyEvent(state, listingUpdated(LATER, 'b', 'claude', { availableCommands: [] }))
    expect(selectDraftListing(state, 'availableCommands', 'b', 'claude')).toEqual([])

    // A listing goes with its workspace, and none comes back for one not listed.
    const removed = applyWorkspaceRemoved(state, 'a')
    expect(removed.composerListings.a).toBeUndefined()
    expect(
      applyEvent(removed, listingUpdated(LATER, 'a', 'claude', { configOptions: [fast] })),
    ).toBe(removed)
  })

  it('takes the environment snapshot’s listings whole, the same as the events built them', () => {
    let live = withWorkspaces(WORKSPACE.workspaceId)
    live = applyEvent(
      live,
      listingUpdated(AT, WORKSPACE.workspaceId, 'claude', { availableCommands: [review] }),
    )
    const snapshot = {
      cursor: { scope: environmentScope, epoch: 'epoch', sequence: 1 },
      state: {
        environment: { environmentId: ENV, name: 'Environment' },
        workspaces: [WORKSPACE],
        sessions: [],
        preferences: [],
        providerProfiles: [],
        listings: packComposerListings([
          {
            workspaceId: WORKSPACE.workspaceId,
            providerId: 'claude',
            listing: { availableCommands: [review] },
            updatedAt: AT,
          },
        ]),
      },
    }
    const fresh = applySnapshot(createInitialState(), snapshot)
    expect(fresh.composerListings).toEqual(live.composerListings)
    // A snapshot that no longer states one takes it away.
    const emptied = applySnapshot(live, {
      ...snapshot,
      state: { ...snapshot.state, listings: packComposerListings([]) },
    })
    expect(emptied.composerListings).toEqual({})
  })
})

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

  it('takes the selection from a listing, and a whole summary that names none clears it', () => {
    let state = applySessionList(applyWorkspaceList(createInitialState(), [WORKSPACE]), [
      { ...SESSION_SUMMARY, composer: { modelId: 'opus' } },
    ])
    expect(selectSessionComposer(state, SESSION.sessionId)).toEqual({ modelId: 'opus' })

    // `session.created` is the whole row: one that names no selection has none.
    state = applyEvent(
      state,
      event<Extract<ProofEvent, { name: 'session.created' }>>({
        name: 'session.created',
        scope: environmentScope,
        payload: { session: SESSION_CREATED },
      }),
    )
    expect(selectSessionComposer(state, SESSION.sessionId)).toBeNull()
  })

  it('restores the selection from an environment snapshot after a reconnect', () => {
    const state = applySnapshot(createInitialState(), {
      cursor: { scope: environmentScope, epoch: 'epoch-1', sequence: 4 },
      state: {
        environment: { environmentId: ENV, name: 'Local' },
        workspaces: [WORKSPACE],
        sessions: [{ ...SESSION_SUMMARY, composer: { modelId: 'opus', modeId: 'plan' } }],
        preferences: [],
        providerProfiles: [],
        listings: { commands: [], configOptions: [], entries: [] },
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
    const state = applyComposerPreference(listed(), target, { modelId: 'opus' }, 1)
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
