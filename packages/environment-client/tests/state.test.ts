import { describe, expect, it } from 'vitest'
import { ProofEventSchema, type ScopeSnapshot } from '@openmanager/protocol'
import {
  applyEnvironment,
  applyEvent,
  applyInteractionResolved,
  applySessionHistory,
  applySessionOpen,
  applySnapshot,
  applyTurnSendFailed,
  applyTurnSending,
  applyTurnStarted,
  createInitialState,
  selectActiveThread,
  selectActiveTurn,
  selectPendingInteractions,
  selectRecentWorkspaces,
  selectSessionList,
  selectWorkspaces,
} from '../src/state'
import type { EnvironmentState } from '../src/types'
import {
  ENV,
  SESSION,
  THREAD,
  WORKSPACE,
  completed,
  delta,
  environmentScope,
  event,
  permission,
  sessionScope,
  threadScope,
  turnStarted,
} from './fixtures'

const seeded = (): EnvironmentState => {
  let state = createInitialState()
  state = applyEvent(
    state,
    event({
      name: 'workspace.updated',
      scope: environmentScope,
      payload: { workspace: WORKSPACE },
    }),
  )
  state = applyEvent(
    state,
    event({ name: 'session.created', scope: environmentScope, payload: { session: SESSION } }),
  )
  state = applyEvent(
    state,
    event({ name: 'thread.created', scope: sessionScope, payload: { thread: THREAD } }),
  )
  return { ...state, activeSessionId: SESSION.sessionId, activeThreadId: THREAD.threadId }
}

describe('applyEnvironment', () => {
  it('keeps the state when the same environment is announced again', () => {
    const named = applyEnvironment(createInitialState(), { environmentId: ENV, name: 'devbox' })
    expect(applyEnvironment(named, { environmentId: ENV, name: 'devbox' })).toBe(named)
    expect(applyEnvironment(named, { environmentId: ENV, name: 'laptop' }).environment).toEqual({
      environmentId: ENV,
      name: 'laptop',
    })
  })
})

describe('applyEvent', () => {
  it('fixtures are protocol-valid events', () => {
    for (const fixture of [turnStarted(), delta('turn-1', 'm', 'x'), completed()]) {
      expect(ProofEventSchema.safeParse(fixture).success).toBe(true)
    }
  })

  it('builds the session list from environment-scoped events', () => {
    const state = seeded()
    expect(selectSessionList(state, WORKSPACE.workspaceId)).toEqual([
      { ...SESSION, status: 'idle', threadIds: [THREAD.threadId] },
    ])
  })

  it('returns the same state when an event changes nothing', () => {
    const state = seeded()
    const again = applyEvent(
      state,
      event({ name: 'thread.created', scope: sessionScope, payload: { thread: THREAD } }),
    )
    expect(again).toBe(state)
  })

  it('streams a turn: running, deltas coalesce, then completed', () => {
    let state = applyEvent(seeded(), turnStarted())
    expect(selectSessionList(state)[0]?.status).toBe('running')
    expect(selectActiveTurn(state)?.turnId).toBe('turn-1')

    state = applyEvent(state, delta('turn-1', 'assistant-1', 'Hel'))
    state = applyEvent(state, delta('turn-1', 'assistant-1', 'lo'))
    const thread = selectActiveThread(state)!
    expect(thread.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(thread.messages[1]?.content).toEqual([{ type: 'text', text: 'Hello' }])

    state = applyEvent(state, completed())
    expect(selectSessionList(state)[0]?.status).toBe('idle')
    expect(selectActiveTurn(state)).toBeNull()
  })

  it('is idempotent for duplicated turn.started deliveries', () => {
    const once = applyEvent(seeded(), turnStarted())
    const twice = applyEvent(once, turnStarted())
    expect(selectActiveThread(twice)?.turns).toHaveLength(1)
    expect(selectActiveThread(twice)?.messages).toHaveLength(1)
  })

  it('tracks pending interactions and returns the turn to running when resolved', () => {
    let state = applyEvent(seeded(), turnStarted())
    state = applyEvent(
      state,
      event({
        name: 'interaction.requested',
        scope: threadScope,
        payload: { turnId: 'turn-1', interaction: permission },
      }),
    )
    expect(selectPendingInteractions(state)).toHaveLength(1)
    expect(selectSessionList(state)[0]?.status).toBe('waiting')

    state = applyEvent(
      state,
      event({
        name: 'interaction.resolved',
        scope: threadScope,
        payload: {
          turnId: 'turn-1',
          response: {
            kind: 'permission',
            interactionId: permission.interactionId,
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
        },
      }),
    )
    expect(selectPendingInteractions(state)).toHaveLength(0)
    expect(selectSessionList(state)[0]?.status).toBe('running')
  })

  it('optimistic resolve returns the turn to running and makes the later event a no-op', () => {
    let state = applyEvent(seeded(), turnStarted())
    state = applyEvent(
      state,
      event({
        name: 'interaction.requested',
        scope: threadScope,
        payload: { turnId: 'turn-1', interaction: permission },
      }),
    )
    state = applyInteractionResolved(state, THREAD, permission.interactionId)
    expect(selectPendingInteractions(state)).toHaveLength(0)
    expect(selectActiveTurn(state)?.state).toBe('running')
    expect(selectSessionList(state)[0]?.status).toBe('running')

    const replayed = applyEvent(
      state,
      event({
        name: 'interaction.resolved',
        scope: threadScope,
        payload: {
          turnId: 'turn-1',
          response: {
            kind: 'permission',
            interactionId: permission.interactionId,
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
        },
      }),
    )
    expect(replayed).toBe(state)
  })

  it('records failures and marks the session as errored', () => {
    let state = applyEvent(seeded(), turnStarted())
    state = applyEvent(
      state,
      event({
        name: 'turn.failed',
        scope: threadScope,
        payload: { turnId: 'turn-1', reason: 'provider_error', message: 'boom' },
      }),
    )
    expect(selectActiveThread(state)?.failures).toEqual([
      { turnId: 'turn-1', reason: 'provider_error', message: 'boom' },
    ])
    expect(selectSessionList(state)[0]?.status).toBe('error')
  })

  it('removes a workspace and its sessions when the environment announces the removal', () => {
    const state = seeded()
    const next = applyEvent(
      state,
      event({
        name: 'workspace.removed',
        scope: environmentScope,
        payload: { workspaceId: WORKSPACE.workspaceId },
      }),
    )
    expect(next.workspaceOrder).toEqual([])
    expect(next.sessionOrder).toEqual([])
    expect(next.activeSessionId).toBeNull()
    expect(
      applyEvent(
        next,
        event({
          name: 'workspace.removed',
          scope: environmentScope,
          payload: { workspaceId: 'other' },
        }),
      ),
    ).toBe(next)
  })

  it('applies a rename from another client without changing session identity or status', () => {
    const previous = seeded()
    const state = applyEvent(
      previous,
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId, title: 'Other client title' },
      }),
    )
    expect(state.sessions[SESSION.sessionId]).toEqual({
      ...previous.sessions[SESSION.sessionId],
      title: 'Other client title',
    })
  })

  it('drops the active selection when the session is deleted', () => {
    const state = applyEvent(
      seeded(),
      event({
        name: 'session.deleted',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId },
      }),
    )
    expect(state.activeSessionId).toBeNull()
    expect(state.threads[THREAD.threadId]).toBeUndefined()
  })

  it('keeps the parent session id announced with a child session', () => {
    const child = {
      sessionId: 'session-child',
      workspaceId: WORKSPACE.workspaceId,
      title: 'Subagent',
      parentSessionId: SESSION.sessionId,
    }
    const state = applyEvent(
      seeded(),
      event({ name: 'session.created', scope: environmentScope, payload: { session: child } }),
    )
    expect(state.sessions[child.sessionId]).toMatchObject({
      parentSessionId: SESSION.sessionId,
      status: 'idle',
    })
    // A top-level session gains no parent from the same code path.
    expect(state.sessions[SESSION.sessionId]).not.toHaveProperty('parentSessionId')
  })

  it('cascades a parent deletion to its descendants and leaves other sessions alone', () => {
    const nested = (sessionId: string, parentSessionId: string) => ({
      session: { sessionId, workspaceId: WORKSPACE.workspaceId, title: sessionId, parentSessionId },
      thread: { threadId: `${sessionId}-thread`, sessionId },
    })
    const unrelated = {
      session: {
        sessionId: 'session-other',
        workspaceId: WORKSPACE.workspaceId,
        title: 'Other',
      },
      thread: { threadId: 'thread-other', sessionId: 'session-other' },
    }
    let state = seeded()
    for (const entry of [
      nested('session-child', SESSION.sessionId),
      nested('session-grandchild', 'session-child'),
      unrelated,
    ]) {
      state = applyEvent(
        state,
        event({
          name: 'session.created',
          scope: environmentScope,
          payload: { session: entry.session },
        }),
      )
      state = applyEvent(
        state,
        event({
          name: 'thread.created',
          scope: { type: 'session', environmentId: ENV, sessionId: entry.session.sessionId },
          payload: { thread: entry.thread },
        }),
      )
    }
    // The grandchild is the active selection, so deleting the root must clear it.
    state = {
      ...state,
      activeSessionId: 'session-grandchild',
      activeThreadId: 'session-grandchild-thread',
      sessionOpenFailure: { sessionId: 'session-child', message: 'boom' },
    }

    const deleted = applyEvent(
      state,
      event({
        name: 'session.deleted',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId },
      }),
    )
    expect(Object.keys(deleted.sessions)).toEqual(['session-other'])
    expect(deleted.sessionOrder).toEqual(['session-other'])
    expect(Object.keys(deleted.threads)).toEqual(['thread-other'])
    expect(deleted.activeSessionId).toBeNull()
    expect(deleted.activeThreadId).toBeNull()
    expect(deleted.sessionOpenFailure).toBeNull()
  })

  it('removes a loaded child when its never-loaded parent is deleted', () => {
    const child = {
      sessionId: 'session-child',
      workspaceId: WORKSPACE.workspaceId,
      title: 'Child',
      parentSessionId: 'parent-1',
    }
    // Only the child arrives: a paginated list can deliver it before the parent.
    let state = applyEvent(
      seeded(),
      event({ name: 'session.created', scope: environmentScope, payload: { session: child } }),
    )
    state = applyEvent(
      state,
      event({
        name: 'thread.created',
        scope: { type: 'session', environmentId: ENV, sessionId: child.sessionId },
        payload: { thread: { threadId: 'session-child-thread', sessionId: child.sessionId } },
      }),
    )
    expect(state.sessionOrder).toContain(child.sessionId)

    const deleted = applyEvent(
      state,
      event({
        name: 'session.deleted',
        scope: environmentScope,
        payload: { sessionId: 'parent-1' },
      }),
    )
    expect(deleted.sessions[child.sessionId]).toBeUndefined()
    expect(deleted.threads['session-child-thread']).toBeUndefined()
    expect(deleted.sessionOrder).not.toContain(child.sessionId)
    expect(deleted.sessionOrder).toEqual([SESSION.sessionId])
  })

  it('keeps the same state when an unknown session with no descendants is deleted', () => {
    const state = seeded()
    expect(
      applyEvent(
        state,
        event({
          name: 'session.deleted',
          scope: environmentScope,
          payload: { sessionId: 'session-never-seen' },
        }),
      ),
    ).toBe(state)
  })
})

describe('optimistic sends', () => {
  const sending = (commandId: string, text = 'hello') =>
    applyTurnSending(seeded(), THREAD, { commandId, text })

  it('echoes a pending message and confirms it from the response', () => {
    const state = sending('cmd-1')
    expect(state.threads[THREAD.threadId]?.outbox).toEqual([
      { commandId: 'cmd-1', text: 'hello', status: 'pending' },
    ])
    const confirmed = applyTurnStarted(state, THREAD, {
      ...turnStarted('turn-1', 'hello', 'cmd-1').payload,
    })
    expect(confirmed.threads[THREAD.threadId]?.outbox).toEqual([])
    expect(confirmed.threads[THREAD.threadId]?.messages).toHaveLength(1)
  })

  it('confirms the echo from the event and applies a repeat of it once', () => {
    const started = turnStarted('turn-1', 'hello', 'cmd-1')
    const confirmed = applyEvent(sending('cmd-1'), started)
    expect(confirmed.threads[THREAD.threadId]?.outbox).toEqual([])
    const again = applyEvent(confirmed, started)
    expect(again.threads[THREAD.threadId]?.messages).toHaveLength(1)
    expect(again.threads[THREAD.threadId]?.turns).toHaveLength(1)
  })

  it('keeps a failed send on screen and reuses its row when it is retried', () => {
    const failed = applyTurnSendFailed(sending('cmd-1'), THREAD, 'cmd-1', 'Provider is down')
    expect(failed.threads[THREAD.threadId]?.outbox).toEqual([
      { commandId: 'cmd-1', text: 'hello', status: 'failed', error: 'Provider is down' },
    ])
    const retried = applyTurnSending(failed, THREAD, { commandId: 'cmd-1', text: 'hello' })
    expect(retried.threads[THREAD.threadId]?.outbox).toEqual([
      { commandId: 'cmd-1', text: 'hello', status: 'pending' },
    ])
  })

  it('ignores a failure for a send that is already confirmed', () => {
    const confirmed = applyEvent(sending('cmd-1'), turnStarted('turn-1', 'hello', 'cmd-1'))
    expect(applyTurnSendFailed(confirmed, THREAD, 'cmd-1', 'too late')).toBe(confirmed)
  })

  it('clears a failed echo the environment turns out to have accepted', () => {
    const state = applyTurnSendFailed(sending('cmd-1'), THREAD, 'cmd-1', 'Connection lost')
    const reconnected = applySnapshot(state, {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 2 },
      state: {
        thread: THREAD,
        turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
        messages: [
          {
            messageId: 'user-1',
            threadId: THREAD.threadId,
            turnId: 'turn-1',
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
        ],
        reasoning: [],
        tools: [],
        interactions: [],
      },
    })
    expect(reconnected.threads[THREAD.threadId]?.outbox).toEqual([])
    expect(reconnected.threads[THREAD.threadId]?.messages).toHaveLength(1)
  })

  it('clears only one echo per arriving message when the same text was sent twice', () => {
    let state = sending('cmd-1')
    state = applyEvent(state, turnStarted('turn-1', 'hello', 'cmd-1'))
    state = applyTurnSendFailed(
      applyTurnSending(state, THREAD, { commandId: 'cmd-2', text: 'hello' }),
      THREAD,
      'cmd-2',
      'Connection lost',
    )
    // The history page only re-states the message this client already has, so
    // the second send is still the one that failed.
    const hydrated = applySessionHistory(state, THREAD, {
      messages: state.threads[THREAD.threadId]!.messages,
      turns: state.threads[THREAD.threadId]!.turns,
      interactions: [],
      nextCursor: null,
    })
    expect(hydrated.threads[THREAD.threadId]?.outbox).toEqual([
      { commandId: 'cmd-2', text: 'hello', status: 'failed', error: 'Connection lost' },
    ])
  })

  it('keeps unconfirmed sends when a snapshot replaces the thread', () => {
    const state = applyTurnSendFailed(sending('cmd-1'), THREAD, 'cmd-1', 'Provider is down')
    const replaced = applySnapshot(state, {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 1 },
      state: {
        thread: THREAD,
        turns: [],
        messages: [],
        reasoning: [],
        tools: [],
        interactions: [],
      },
    })
    expect(replaced.threads[THREAD.threadId]?.outbox).toHaveLength(1)
  })
})

describe('snapshots', () => {
  it('applies a thread snapshot wholesale and marks it hydrated', () => {
    const snapshot: ScopeSnapshot = {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 3 },
      state: {
        thread: THREAD,
        turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
        messages: [
          {
            messageId: 'm-1',
            threadId: THREAD.threadId,
            turnId: 'turn-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        ],
        reasoning: [],
        tools: [{ toolCallId: 'tool-1', turnId: 'turn-1', status: 'completed' }],
        interactions: [],
      },
    }
    const state = applySnapshot(applyEvent(seeded(), turnStarted()), snapshot)
    const thread = state.threads[THREAD.threadId]!
    expect(thread.hydration).toBe('ready')
    expect(thread.messages).toHaveLength(1)
    expect(thread.tools[0]?.status).toBe('completed')
    expect(state.sessions[SESSION.sessionId]?.status).toBe('idle')
  })

  it('applies an environment snapshot to workspaces and sessions', () => {
    const state = applySnapshot(createInitialState(), {
      cursor: { scope: environmentScope, epoch: 'epoch', sequence: 1 },
      state: {
        environment: { environmentId: ENV, name: 'Local' },
        workspaces: [WORKSPACE],
        sessions: [
          {
            ...SESSION,
            status: 'idle',
            providerId: 'opencode',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
        ],
      },
    })
    expect(state.environment?.name).toBe('Local')
    expect(selectSessionList(state)).toHaveLength(1)
  })

  it('moves workspace activity forward on session starts and turns without a relisting', () => {
    let state = createInitialState()
    state = applyEvent(
      state,
      event({
        name: 'workspace.updated',
        scope: environmentScope,
        payload: { workspace: WORKSPACE },
      }),
    )
    expect(selectRecentWorkspaces(state)).toEqual([])

    state = applyEvent(
      state,
      event({ name: 'session.created', scope: environmentScope, payload: { session: SESSION } }),
    )
    expect(state.workspaces[WORKSPACE.workspaceId]?.lastActivityAt).toBe('2026-09-10T00:00:00.000Z')
    expect(selectRecentWorkspaces(state).map((w) => w.workspaceId)).toEqual([WORKSPACE.workspaceId])

    state = applyEvent(
      state,
      event({ name: 'thread.created', scope: sessionScope, payload: { thread: THREAD } }),
    )
    const later = { ...turnStarted(), timestamp: '2026-09-11T00:00:00.000Z' }
    state = applyEvent(state, later)
    expect(state.workspaces[WORKSPACE.workspaceId]?.lastActivityAt).toBe('2026-09-11T00:00:00.000Z')

    // A stale event (older timestamp) never moves activity backwards.
    const stale = { ...completed(), timestamp: '2026-09-09T00:00:00.000Z' }
    state = applyEvent(state, stale)
    expect(state.workspaces[WORKSPACE.workspaceId]?.lastActivityAt).toBe('2026-09-11T00:00:00.000Z')
  })

  it('orders recent workspaces by last activity and skips unused or missing ones', () => {
    const at = (name: string, lastActivityAt: string | null, exists = true) => ({
      ...WORKSPACE,
      workspaceId: name,
      path: name,
      name,
      lastActivityAt,
      exists,
    })
    const state = applySnapshot(createInitialState(), {
      cursor: { scope: environmentScope, epoch: 'epoch', sequence: 1 },
      state: {
        environment: { environmentId: ENV, name: 'Local' },
        workspaces: [
          at('stale', '2026-09-01T00:00:00.000Z'),
          at('never', null),
          at('fresh', '2026-09-12T00:00:00.000Z'),
          at('gone', '2026-09-13T00:00:00.000Z', false),
          at('middle', '2026-09-10T00:00:00.000Z'),
        ],
        sessions: [],
      },
    })
    // Listing order is preserved for the sidebar; recents are a separate view.
    expect(selectWorkspaces(state).map((w) => w.name)).toEqual([
      'stale',
      'never',
      'fresh',
      'gone',
      'middle',
    ])
    expect(selectRecentWorkspaces(state).map((w) => w.name)).toEqual(['fresh', 'middle', 'stale'])
    expect(selectRecentWorkspaces(state, 2).map((w) => w.name)).toEqual(['fresh', 'middle'])
  })

  it('hydrates identities from session.open and the transcript from session.history', () => {
    const opened = applySessionOpen(createInitialState(), {
      session: {
        ...SESSION,
        status: 'idle',
        providerId: 'opencode',
        updatedAt: '2026-09-10T00:00:00.000Z',
      },
      threads: [THREAD],
    })
    expect(opened.sessions[SESSION.sessionId]?.threadIds).toEqual([THREAD.threadId])
    expect(opened.threads[THREAD.threadId]?.hydration).toBe('loading')
    const state = applySessionHistory(opened, THREAD, {
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'waiting' }],
      messages: [],
      interactions: [{ threadId: THREAD.threadId, interaction: permission }],
      nextCursor: null,
    })
    expect(state.sessions[SESSION.sessionId]?.status).toBe('waiting')
    expect(selectPendingInteractions(state, THREAD.threadId)[0]?.turnId).toBe('turn-1')
    expect(state.threads[THREAD.threadId]?.hydration).toBe('ready')
  })
})
