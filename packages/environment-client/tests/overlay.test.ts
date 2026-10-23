import { describe, expect, it } from 'vitest'
import { cacheState } from '../src/cache-state'
import { dropOverlayEntry, preferenceKey, settleAnswered, updateOverlay } from '../src/overlay'
import {
  applyActiveSession,
  applyComposerPreference,
  applyEvent,
  applyThreadHydration,
  applyWorkspaceList,
  createInitialState,
} from '../src/state'
import { applySessionList, loadThread } from './seed'
import { createEnvironmentStore } from '../src/store'
import {
  SESSION,
  SESSION_CREATED,
  SESSION_SUMMARY,
  THREAD,
  WORKSPACE,
  environmentScope,
  event,
  sessionScope,
  threadScope,
  turnStarted,
} from './fixtures'

/**
 * The pending overlay (docs/sync-foundations.md §3.2): the user's own
 * unconfirmed actions, composed over server state for display and never
 * written into it. Each entry goes once server state shows what it asked
 * for, or its command fails.
 */
const listed = () =>
  applySessionList(applyWorkspaceList(createInitialState(), [WORKSPACE]), [SESSION_SUMMARY])

/** The session's thread, created and loaded. */
const withThread = (state: ReturnType<typeof createInitialState>) =>
  applyThreadHydration(
    applyEvent(
      state,
      event({ name: 'thread.created', scope: sessionScope, payload: { thread: THREAD } }),
    ),
    THREAD.threadId,
    'ready',
  )

const sessionUpdated = (payload: Record<string, unknown>) =>
  event({
    name: 'session.updated',
    scope: environmentScope,
    payload: { sessionId: SESSION.sessionId, ...payload },
  })

describe('the pending overlay', () => {
  it('composes nothing while nothing is pending: the same object', () => {
    const store = createEnvironmentStore(listed())
    expect(store.getState()).toBe(store.getServerState())
  })

  it('shows a rename until server state has it, and never writes it there', () => {
    const store = createEnvironmentStore(listed())
    store.update((state) =>
      updateOverlay(state, 'renames', (entries) => ({
        ...entries,
        [SESSION.sessionId]: { ticket: 1, title: 'Mine', from: null },
      })),
    )
    expect(store.getState().sessions[SESSION.sessionId]).toMatchObject({
      title: 'Mine',
      titleSource: 'user',
    })
    expect(store.getServerState().sessions[SESSION.sessionId]?.title).toBeNull()
    store.update((state) =>
      applyEvent(state, sessionUpdated({ title: 'Mine', titleSource: 'user' })),
    )
    expect(store.getState().pending.renames).toEqual({})
    expect(store.getState().sessions[SESSION.sessionId]?.title).toBe('Mine')
  })

  it('lets a newer title replace a pending rename, and a failure put the old one back', () => {
    const store = createEnvironmentStore(listed())
    // `from` is what server state held when the rename was asked for.
    const rename = (ticket: number, from: string | null) =>
      store.update((state) =>
        updateOverlay(state, 'renames', (entries) => ({
          ...entries,
          [SESSION.sessionId]: { ticket, title: 'Mine', from },
        })),
      )
    rename(1, null)
    store.update((state) =>
      applyEvent(state, sessionUpdated({ title: 'Agent title', titleSource: 'provider' })),
    )
    expect(store.getState().sessions[SESSION.sessionId]?.title).toBe('Agent title')
    rename(2, 'Agent title')
    // An older request's failure does not take the newer one's entry.
    store.update((state) => dropOverlayEntry(state, 'renames', SESSION.sessionId, 1))
    expect(store.getState().sessions[SESSION.sessionId]?.title).toBe('Mine')
    store.update((state) => dropOverlayEntry(state, 'renames', SESSION.sessionId, 2))
    expect(store.getState().sessions[SESSION.sessionId]?.title).toBe('Agent title')
  })

  it('keeps the latest settle click until its answer and server state agree', () => {
    const store = createEnvironmentStore(listed())
    const click = (ticket: number, settled: boolean) =>
      store.update((state) =>
        updateOverlay(state, 'settles', (entries) => ({
          ...entries,
          [SESSION.sessionId]: { ticket, settled, inFlight: true, at: '2026-10-23T10:00:00.000Z' },
        })),
      )
    click(1, true)
    click(2, false)
    // Server state already agrees with the latest click, but its answer is out.
    expect(store.getState().pending.settles[SESSION.sessionId]).toBeDefined()
    // The first click's echo arrives: not what the latest click asked for.
    store.update((state) =>
      applyEvent(state, sessionUpdated({ settledAt: '2026-10-23T10:00:00.100Z' })),
    )
    expect(store.getState().sessions[SESSION.sessionId]?.settledAt).toBeNull()
    store.update((state) => settleAnswered(state, SESSION.sessionId, 1))
    expect(store.getState().pending.settles[SESSION.sessionId]).toMatchObject({ inFlight: true })
    store.update((state) => settleAnswered(state, SESSION.sessionId, 2))
    store.update((state) => applyEvent(state, sessionUpdated({ settledAt: null })))
    expect(store.getState().pending.settles).toEqual({})
    expect(store.getState().sessions[SESSION.sessionId]?.settledAt).toBeNull()
  })

  it('shows an acknowledged result as not done until server state says so', () => {
    const done = applyEvent(listed(), sessionUpdated({ doneAt: '2026-10-23T10:00:00.000Z' }))
    const store = createEnvironmentStore(done)
    store.update((state) =>
      updateOverlay(state, 'acks', (entries) => ({
        ...entries,
        [SESSION.sessionId]: { ticket: 1 },
      })),
    )
    expect(store.getState().sessions[SESSION.sessionId]?.doneAt).toBeNull()
    expect(store.getServerState().sessions[SESSION.sessionId]?.doneAt).not.toBeNull()
    store.update((state) => applyEvent(state, sessionUpdated({ doneAt: null })))
    expect(store.getState().pending.acks).toEqual({})
  })

  it('hides a session being removed, and shows it again when the removal fails', () => {
    const store = createEnvironmentStore(listed())
    store.update((state) =>
      updateOverlay(state, 'removals', (entries) => ({
        ...entries,
        [SESSION.sessionId]: { ticket: 1, kind: 'session' },
      })),
    )
    expect(store.getState().sessions[SESSION.sessionId]).toBeUndefined()
    expect(store.getState().sessionOrder).toEqual([])
    store.update((state) => dropOverlayEntry(state, 'removals', SESSION.sessionId, 1))
    expect(store.getState().sessions[SESSION.sessionId]).toBeDefined()
  })

  it('hides an answered prompt until server state no longer lists it', () => {
    const asked = applyEvent(
      applyEvent(withThread(listed()), turnStarted('turn-1')),
      event({
        name: 'interaction.requested',
        scope: threadScope,
        payload: {
          turnId: 'turn-1',
          turnState: 'waiting',
          interaction: {
            kind: 'question',
            interactionId: 'question-1',
            questions: [{ questionId: 'q', prompt: 'Which?', options: [] }],
          },
        },
      }),
    )
    const store = createEnvironmentStore(asked)
    store.update((state) =>
      updateOverlay(state, 'answers', (entries) => ({
        ...entries,
        'question-1': { threadId: THREAD.threadId },
      })),
    )
    expect(store.getState().threads[THREAD.threadId]?.interactions).toEqual([])
    expect(store.getServerState().threads[THREAD.threadId]?.interactions).toHaveLength(1)
    store.update((state) =>
      applyEvent(
        state,
        event({
          name: 'interaction.resolved',
          scope: threadScope,
          payload: {
            turnId: 'turn-1',
            turnState: 'running',
            response: {
              kind: 'question',
              interactionId: 'question-1',
              outcome: { outcome: 'cancelled' },
            },
          },
        }),
      ),
    )
    expect(store.getState().pending.answers).toEqual({})
  })

  it('shows a created session and its first message until the chat itself holds them', () => {
    const store = createEnvironmentStore(applyWorkspaceList(createInitialState(), [WORKSPACE]))
    const first = turnStarted('turn-1', 'Start', 'cmd-1').payload
    store.update((state) =>
      applyActiveSession(
        updateOverlay(state, 'creates', (entries) => ({
          ...entries,
          [SESSION.sessionId]: {
            session: { ...SESSION_CREATED, status: 'running' },
            thread: THREAD,
            firstTurn: first,
          },
        })),
        SESSION.sessionId,
      ),
    )
    const shown = store.getState()
    expect(shown.sessions[SESSION.sessionId]).toMatchObject({ status: 'running' })
    expect(shown.threads[THREAD.threadId]?.messages.map((message) => message.messageId)).toEqual([
      first.userMessage!.messageId,
    ])
    expect(store.getServerState().sessions).toEqual({})
    // The announcement arrives: listed, but the chat has not loaded yet.
    store.update((state) =>
      applyEvent(
        state,
        event({
          name: 'session.created',
          scope: environmentScope,
          payload: { session: SESSION_CREATED },
        }),
      ),
    )
    expect(store.getState().pending.creates[SESSION.sessionId]).toMatchObject({ listed: true })
    expect(store.getState().threads[THREAD.threadId]?.messages).toHaveLength(1)
    // The chat loads, then its turn arrives: the server's own state replaces the entry.
    store.update(withThread)
    expect(store.getState().pending.creates[SESSION.sessionId]).toBeDefined()
    store.update((state) => applyEvent(state, turnStarted('turn-1', 'Start', 'cmd-1')))
    expect(store.getState().pending.creates).toEqual({})
    expect(store.getState().threads[THREAD.threadId]?.messages).toHaveLength(1)
  })

  it('forgets a created session deleted before its chat loaded', () => {
    const store = createEnvironmentStore(applyWorkspaceList(createInitialState(), [WORKSPACE]))
    store.update((state) =>
      applyActiveSession(
        updateOverlay(state, 'creates', (entries) => ({
          ...entries,
          [SESSION.sessionId]: { session: SESSION_CREATED, thread: THREAD },
        })),
        SESSION.sessionId,
      ),
    )
    store.update((state) =>
      applyEvent(
        state,
        event({
          name: 'session.created',
          scope: environmentScope,
          payload: { session: SESSION_CREATED },
        }),
      ),
    )
    store.update((state) =>
      applyEvent(
        state,
        event({
          name: 'session.deleted',
          scope: environmentScope,
          payload: { sessionId: SESSION.sessionId },
        }),
      ),
    )
    expect(store.getState().pending.creates).toEqual({})
    expect(store.getState().sessions[SESSION.sessionId]).toBeUndefined()
  })

  it('shows the newest acknowledged preference until server state holds its revision', () => {
    const target = { workspaceId: WORKSPACE.workspaceId, providerId: 'opencode' }
    const key = preferenceKey(target)
    const store = createEnvironmentStore(
      applyComposerPreference(listed(), target, { modelId: 'sonnet' }, 1),
    )
    store.update((state) =>
      updateOverlay(state, 'preferences', (entries) => ({
        ...entries,
        [key]: [
          {
            ticket: 2,
            ...target,
            patch: {},
            listed: true,
            acknowledged: { revision: 3, preference: { modelId: 'opus' } },
          },
          {
            ticket: 1,
            ...target,
            patch: {},
            listed: true,
            acknowledged: { revision: 2, preference: { modelId: 'haiku' } },
          },
          { ticket: 3, ...target, patch: { modeId: 'plan' }, listed: true },
        ],
      })),
    )
    expect(store.getState().composerPreferences[target.workspaceId]?.opencode).toEqual({
      modelId: 'opus',
      modeId: 'plan',
    })
    store.update((state) => applyComposerPreference(state, target, { modelId: 'opus' }, 3))
    // Both acknowledged entries are behind the server now; the unanswered one stays.
    expect(store.getState().pending.preferences[key]).toHaveLength(1)
    expect(store.getState().composerPreferences[target.workspaceId]?.opencode).toEqual({
      modelId: 'opus',
      modeId: 'plan',
    })
  })

  it('is never cached: the commands it waits on belong to the old transport', () => {
    const state = updateOverlay(listed(), 'acks', (entries) => ({
      ...entries,
      [SESSION.sessionId]: { ticket: 1 },
    }))
    expect(cacheState(state).pending.acks).toEqual({})
  })
})
