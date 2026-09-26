import { describe, expect, it } from 'vitest'
import { ProofEventSchema, type ScopeSnapshot } from '@openmanager/protocol'
import {
  applyEnvironment,
  applyEvent,
  applyInteractionResolved,
  applySessionAcknowledged,
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
  it('uses server status even without a thread and preserves it through stale history', () => {
    let state = applyEvent(
      createInitialState(),
      event({
        name: 'session.created',
        scope: environmentScope,
        payload: { session: SESSION },
      }),
    )
    for (const status of ['running', 'waiting', 'error', 'idle'] as const) {
      state = applyEvent(
        state,
        event({
          name: 'session.updated',
          scope: environmentScope,
          payload: { sessionId: SESSION.sessionId, status },
        }),
      )
      expect(state.sessions[SESSION.sessionId]?.status).toBe(status)
      expect(Object.keys(state.threads)).toHaveLength(0)
    }
    state = applyEvent(
      state,
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId, status: 'waiting' },
      }),
    )
    state = applySessionHistory(state, THREAD, {
      turns: [{ turnId: 'old', threadId: THREAD.threadId, state: 'completed' }],
      messages: [],
      interactions: [],
      nextCursor: null,
    })
    expect(state.sessions[SESSION.sessionId]?.status).toBe('waiting')
    state = applyTurnStarted(state, THREAD, turnStarted().payload)
    expect(state.sessions[SESSION.sessionId]?.status).toBe('waiting')
  })

  it('tracks an unseen completion without moving the session, and clears it on acknowledge', () => {
    const doneAt = '2026-09-26T10:00:00.000Z'
    let state = applyEvent(
      createInitialState(),
      event({ name: 'session.created', scope: environmentScope, payload: { session: SESSION } }),
    )
    state = applyEvent(
      state,
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId, status: 'idle', doneAt },
      }),
    )
    const finished = state.sessions[SESSION.sessionId]
    expect(finished).toMatchObject({ status: 'idle', doneAt })

    // A later update that says nothing about it keeps what is known.
    state = applyEvent(
      state,
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId, title: 'Renamed' },
      }),
    )
    expect(state.sessions[SESSION.sessionId]?.doneAt).toBe(doneAt)

    const acknowledged = applySessionAcknowledged(state, SESSION.sessionId)
    expect(acknowledged.sessions[SESSION.sessionId]).toMatchObject({
      doneAt: null,
      updatedAt: state.sessions[SESSION.sessionId]?.updatedAt,
    })
    expect(applySessionAcknowledged(acknowledged, SESSION.sessionId)).toBe(acknowledged)

    // The broadcast from another client lands the same way.
    const fromElsewhere = applyEvent(
      state,
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId, doneAt: null },
      }),
    )
    expect(fromElsewhere.sessions[SESSION.sessionId]).toMatchObject({
      doneAt: null,
      updatedAt: state.sessions[SESSION.sessionId]?.updatedAt,
    })
    expect(finished?.status).toBe('idle')
  })

  it('fixtures are protocol-valid events', () => {
    for (const fixture of [turnStarted(), delta('turn-1', 'm', 'x'), completed()]) {
      expect(ProofEventSchema.safeParse(fixture).success).toBe(true)
    }
  })

  it('builds the session list from environment-scoped events', () => {
    const state = seeded()
    expect(selectSessionList(state, WORKSPACE.workspaceId)).toEqual([
      {
        ...SESSION,
        status: 'idle',
        threadIds: [THREAD.threadId],
        updatedAt: '2026-09-10T00:00:00.000Z',
      },
    ])
  })

  it('lists sessions newest first regardless of arrival order', () => {
    const created = (sessionId: string, timestamp: string) => ({
      ...event({
        name: 'session.created' as const,
        scope: environmentScope,
        payload: { session: { ...SESSION, sessionId } },
      }),
      timestamp,
    })
    let state = seeded()
    // The first listing was newest-first; later arrivals land at the end of
    // `sessionOrder` and would otherwise render at the bottom of the sidebar.
    state = applyEvent(state, created('session-old', '2026-09-01T00:00:00.000Z'))
    state = applyEvent(state, created('session-new', '2026-09-12T00:00:00.000Z'))
    expect(selectSessionList(state).map((session) => session.sessionId)).toEqual([
      'session-new',
      SESSION.sessionId,
      'session-old',
    ])

    // Activity moves a session back to the top.
    state = applyEvent(state, {
      ...event({
        name: 'session.updated' as const,
        scope: sessionScope,
        payload: { sessionId: 'session-old', status: 'running' },
      }),
      timestamp: '2026-09-13T00:00:00.000Z',
    })
    expect(selectSessionList(state).map((session) => session.sessionId)).toEqual([
      'session-old',
      'session-new',
      SESSION.sessionId,
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
    expect(selectSessionList(state)[0]?.status).toBe('idle')
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

  it('closes an open thought on the next assistant text or tool update, and a later thought reopens it', () => {
    const thought = (text: string) =>
      event({
        name: 'message.reasoning',
        scope: threadScope,
        payload: {
          turnId: 'turn-1',
          messageId: 'reasoning-1',
          phase: 'delta',
          content: { type: 'text', text },
        },
      })
    const tool = (status: 'in_progress' | 'completed') =>
      event({
        name: 'tool.updated',
        scope: threadScope,
        payload: { turnId: 'turn-1', toolCallId: 'tool-1', title: 'Read file', status },
      })
    const phase = (state: EnvironmentState) => selectActiveThread(state)!.reasoning[0]?.phase

    // ACP providers only ever send deltas; text after the thought ends it.
    let state = applyEvent(applyEvent(seeded(), turnStarted()), thought('plan'))
    expect(phase(state)).toBe('delta')
    state = applyEvent(state, delta('turn-1', 'assistant-1', 'Hello'))
    expect(phase(state)).toBe('stop')
    // Closing is idempotent: nothing to close means the thread is untouched.
    const closedThread = selectActiveThread(state)
    expect(
      selectActiveThread(applyEvent(state, delta('turn-1', 'assistant-1', '!')))!.reasoning,
    ).toBe(closedThread!.reasoning)

    // A tool call ends a thought too, and thinking again after it reopens the block.
    state = applyEvent(state, thought(' more'))
    expect(phase(state)).toBe('delta')
    state = applyEvent(state, tool('in_progress'))
    expect(phase(state)).toBe('stop')
    expect(selectActiveThread(state)!.reasoning[0]?.content).toEqual([
      { type: 'text', text: 'plan more' },
    ])
    expect(selectActiveThread(state)!.tools).toHaveLength(1)
  })

  it('places each message, thought and tool in arrival order exactly once', () => {
    const thought = (messageId: string, text: string) =>
      event({
        name: 'message.reasoning',
        scope: threadScope,
        payload: { turnId: 'turn-1', messageId, phase: 'delta', content: { type: 'text', text } },
      })
    const tool = (toolCallId: string, status: 'in_progress' | 'completed') =>
      event({
        name: 'tool.updated',
        scope: threadScope,
        payload: { turnId: 'turn-1', toolCallId, title: 'Read file', status },
      })
    let state = applyEvent(seeded(), turnStarted())
    // Two thoughts, two tools and two text runs interleaved; every update of an
    // entry already placed leaves the order alone.
    for (const next of [
      thought('thought-1', 'plan'),
      thought('thought-1', ' more'),
      tool('tool-1', 'in_progress'),
      tool('tool-1', 'completed'),
      delta('turn-1', 'assistant-1', 'Looking'),
      delta('turn-1', 'assistant-1', ' closer'),
      thought('thought-2', 'check'),
      tool('tool-2', 'completed'),
      delta('turn-1', 'assistant-2', 'Found it'),
    ]) {
      state = applyEvent(state, next)
    }
    const thread = selectActiveThread(state)!
    expect(thread.order.map((ref) => `${ref.kind}:${ref.id}`)).toEqual([
      'message:turn-1-user',
      'reasoning:thought-1',
      'tool:tool-1',
      'message:assistant-1',
      'reasoning:thought-2',
      'tool:tool-2',
      'message:assistant-2',
    ])
    // The second thought is its own block; the first stays closed.
    expect(thread.reasoning.map((entry) => entry.phase)).toEqual(['stop', 'stop'])
    expect(thread.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Found it' }])
  })

  it('keeps the place of live activity that arrived while a history page loaded', () => {
    // Without replay the client subscribes before it loads history, so a
    // running turn can place a thought or tool before the page answers.
    let state = applyEvent(seeded(), turnStarted())
    state = {
      ...state,
      threads: {
        ...state.threads,
        [THREAD.threadId]: { ...state.threads[THREAD.threadId]!, hydration: 'loading' },
      },
    }
    state = applyEvent(
      state,
      event({
        name: 'message.reasoning',
        scope: threadScope,
        payload: {
          turnId: 'turn-1',
          messageId: 'thought-live',
          phase: 'delta',
          content: { type: 'text', text: 'plan' },
        },
      }),
    )
    const userMessage = state.threads[THREAD.threadId]!.messages[0]!
    state = applySessionHistory(state, THREAD, {
      messages: [userMessage],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'running' }],
      interactions: [],
      nextCursor: null,
    })
    const thread = state.threads[THREAD.threadId]!
    expect(thread.hydration).toBe('ready')
    expect(thread.reasoning).toHaveLength(1)
    expect(thread.order.map((ref) => `${ref.kind}:${ref.id}`)).toEqual([
      'message:turn-1-user',
      'reasoning:thought-live',
    ])
  })

  it('restores reasoning, tools and their order from a history page and a snapshot', () => {
    const turn = { turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' as const }
    const message = (messageId: string, role: 'user' | 'assistant', text: string) => ({
      messageId,
      threadId: THREAD.threadId,
      turnId: 'turn-1',
      role,
      content: [{ type: 'text' as const, text }],
    })
    const activity = {
      reasoning: [
        {
          messageId: 'thought-1',
          turnId: 'turn-1',
          phase: 'stop' as const,
          content: [{ type: 'text' as const, text: 'plan' }],
        },
      ],
      tools: [
        { toolCallId: 'tool-1', turnId: 'turn-1', title: 'Read', status: 'completed' as const },
      ],
      order: [
        { kind: 'message' as const, id: 'user-1', turnId: 'turn-1' },
        { kind: 'reasoning' as const, id: 'thought-1', turnId: 'turn-1' },
        { kind: 'tool' as const, id: 'tool-1', turnId: 'turn-1' },
        { kind: 'message' as const, id: 'assistant-1', turnId: 'turn-1' },
      ],
    }
    const messages = [message('user-1', 'user', 'hi'), message('assistant-1', 'assistant', 'done')]

    const fromHistory = applySessionHistory(seeded(), THREAD, {
      messages,
      turns: [turn],
      interactions: [],
      nextCursor: null,
      ...activity,
    }).threads[THREAD.threadId]!
    expect(fromHistory.reasoning).toEqual(activity.reasoning)
    expect(fromHistory.tools).toEqual(activity.tools)
    expect(fromHistory.order).toEqual(activity.order)

    const fromSnapshot = applySnapshot(seeded(), {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 9 },
      state: { thread: THREAD, turns: [turn], messages, interactions: [], ...activity },
    }).threads[THREAD.threadId]!
    expect(fromSnapshot.reasoning).toEqual(activity.reasoning)
    expect(fromSnapshot.tools).toEqual(activity.tools)
    expect(fromSnapshot.order).toEqual(activity.order)

    // An older page prepends its entries; the newer ones keep what the client holds.
    const olderPage = applySessionHistory(
      { ...seeded(), threads: { [THREAD.threadId]: fromHistory } },
      THREAD,
      {
        messages: [message('user-0', 'user', 'earlier')],
        turns: [{ ...turn, turnId: 'turn-0' }, turn],
        interactions: [],
        nextCursor: null,
        reasoning: [],
        tools: [{ toolCallId: 'tool-0', turnId: 'turn-0', status: 'completed' }],
        order: [
          { kind: 'message', id: 'user-0', turnId: 'turn-0' },
          { kind: 'tool', id: 'tool-0', turnId: 'turn-0' },
        ],
      },
      true,
    ).threads[THREAD.threadId]!
    expect(olderPage.order.map((ref) => ref.id)).toEqual([
      'user-0',
      'tool-0',
      'user-1',
      'thought-1',
      'tool-1',
      'assistant-1',
    ])
    expect(olderPage.tools.map((tool) => tool.toolCallId)).toEqual(['tool-1', 'tool-0'])
  })

  it('stamps a turn with when it started and finished', () => {
    const start = turnStarted()
    let state = applyEvent(seeded(), { ...start, timestamp: '2026-09-24T10:00:00.000Z' })
    expect(selectActiveTurn(state)?.startedAt).toBe('2026-09-24T10:00:00.000Z')
    // The send response arriving second may not rewind the start.
    state = applyTurnStarted(state, THREAD, start.payload)
    expect(selectActiveThread(state)!.turns[0]?.startedAt).toBe('2026-09-24T10:00:00.000Z')
    state = applyEvent(state, { ...completed(), timestamp: '2026-09-24T10:00:45.000Z' })
    expect(selectActiveThread(state)!.turns[0]).toMatchObject({
      state: 'completed',
      startedAt: '2026-09-24T10:00:00.000Z',
      finishedAt: '2026-09-24T10:00:45.000Z',
    })
  })

  it('is idempotent for duplicated turn.started deliveries', () => {
    const once = applyEvent(seeded(), turnStarted())
    const twice = applyEvent(once, turnStarted())
    expect(selectActiveThread(twice)?.turns).toHaveLength(1)
    expect(selectActiveThread(twice)?.messages).toHaveLength(1)
  })

  it.each([
    { outcome: 'selected', optionId: 'allow' },
    { outcome: 'cancelled', reason: 'timeout' },
    { outcome: 'cancelled', reason: 'tool_cancelled' },
    { outcome: 'cancelled', reason: 'session_closed' },
  ] as const)('removes pending UI on a broadcast outcome %j', (outcome) => {
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
    expect(selectSessionList(state)[0]?.status).toBe('idle')

    state = applyEvent(
      state,
      event({
        name:
          'reason' in outcome && outcome.reason === 'timeout'
            ? 'interaction.expired'
            : 'interaction.resolved',
        scope: threadScope,
        payload: {
          turnId: 'turn-1',
          response: {
            kind: 'permission',
            interactionId: permission.interactionId,
            outcome,
          },
        },
      }),
    )
    expect(selectPendingInteractions(state)).toHaveLength(0)
    expect(selectActiveTurn(state)?.state).toBe('running')
    expect(selectSessionList(state)[0]?.status).toBe('idle')
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
    expect(selectSessionList(state)[0]?.status).toBe('idle')

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

  it('records turn failures without guessing the session status', () => {
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
    expect(selectSessionList(state)[0]?.status).toBe('idle')
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
      updatedAt: '2026-09-10T00:00:00.000Z',
    })
  })

  it('records the provenance a server-owned title arrives with', () => {
    let state = applyEvent(
      seeded(),
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: {
          sessionId: SESSION.sessionId,
          title: 'First prompt',
          titleSource: 'fallback',
        },
      }),
    )
    expect(state.sessions[SESSION.sessionId]).toMatchObject({
      title: 'First prompt',
      titleSource: 'fallback',
    })
    state = applyEvent(
      state,
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId, title: 'Provider title', titleSource: 'provider' },
      }),
    )
    expect(state.sessions[SESSION.sessionId]).toMatchObject({
      title: 'Provider title',
      titleSource: 'provider',
    })
    // A status-only update leaves the title and its provenance alone.
    state = applyEvent(
      state,
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: { sessionId: SESSION.sessionId, status: 'running' },
      }),
    )
    expect(state.sessions[SESSION.sessionId]).toMatchObject({
      title: 'Provider title',
      titleSource: 'provider',
      status: 'running',
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
      sessionOpenFailure: { sessionId: 'session-child', message: 'boom', code: 'internal' },
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
    // Without overlap there is no proof the old cache is contiguous with this page.
    expect(thread.messages.map((message) => message.messageId)).toEqual(['m-1'])
    expect(thread.tools[0]?.status).toBe('completed')
    expect(state.sessions[SESSION.sessionId]?.status).toBe('idle')
  })

  it('keeps loaded older pages in front of the newest page a snapshot carries', () => {
    const message = (messageId: string, text: string) => ({
      messageId,
      threadId: THREAD.threadId,
      turnId: 'turn-1',
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    })
    let state = applyEvent(seeded(), turnStarted())
    state = applySessionHistory(state, THREAD, {
      messages: [message('m-old', 'from an earlier page'), message('m-1', 'streamed so far')],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'running' }],
      interactions: [],
      nextCursor: { ordinal: 1 },
    })
    const replaced = applySnapshot(state, {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 9 },
      state: {
        thread: THREAD,
        turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
        messages: [message('m-1', 'the whole answer'), message('m-2', 'and a follow-up')],
        reasoning: [],
        tools: [],
        interactions: [],
      },
    })
    expect(replaced.threads[THREAD.threadId]?.messages.map((item) => item.messageId)).toEqual([
      'm-old',
      'm-1',
      'm-2',
    ])
    expect(replaced.threads[THREAD.threadId]?.messages[1]?.content).toEqual([
      { type: 'text', text: 'the whole answer' },
    ])

    expect(replaced.threads[THREAD.threadId]?.historyCursor).toEqual({ ordinal: 1 })

    // Only what precedes the page counts as older; a message the client holds
    // after that point and the page does not name is not moved in front of it.
    const withStray = applyEvent(state, delta('turn-1', 'm-stray', 'never persisted'))
    const settled = applySnapshot(withStray, {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 10 },
      state: {
        thread: THREAD,
        turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
        messages: [message('m-1', 'the whole answer'), message('m-2', 'and a follow-up')],
        reasoning: [],
        tools: [],
        interactions: [],
      },
    })
    expect(settled.threads[THREAD.threadId]?.messages.map((item) => item.messageId)).toEqual([
      'm-old',
      'm-1',
      'm-2',
    ])
  })

  it('keeps an exhausted cursor when reopening a contiguous cached transcript', () => {
    const start = turnStarted()
    let state = applyEvent(seeded(), start)
    state = applyEvent(state, delta('turn-1', 'assistant-1', 'answer'))
    state = applySessionHistory(state, THREAD, {
      messages: state.threads[THREAD.threadId]!.messages,
      turns: [start.payload.turn],
      interactions: [],
      nextCursor: null,
    })
    state = {
      ...state,
      threads: {
        ...state.threads,
        [THREAD.threadId]: { ...state.threads[THREAD.threadId]!, hydration: 'loading' },
      },
    }
    const snapshot: ScopeSnapshot = {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 4 },
      state: {
        thread: THREAD,
        turns: [start.payload.turn],
        messages: [state.threads[THREAD.threadId]!.messages[1]!],
        reasoning: [],
        tools: [],
        interactions: [],
        nextCursor: { ordinal: 1 },
      },
    }
    const restored = applySnapshot(state, snapshot).threads[THREAD.threadId]!
    expect(restored.messages).toHaveLength(2)
    expect(restored.historyCursor).toBeNull()
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
    expect(state.sessions[SESSION.sessionId]?.status).toBe('idle')
    expect(selectPendingInteractions(state, THREAD.threadId)[0]?.turnId).toBe('turn-1')
    expect(state.threads[THREAD.threadId]?.hydration).toBe('ready')
  })
})

describe('protocol turn finalization', () => {
  it.each(['turn.completed', 'turn.interrupted', 'turn.failed'] as const)(
    'settles %s, preserves partial text, closes reasoning and rejects late parts',
    (name) => {
      let state = applyEvent(seeded(), turnStarted())
      state = applyEvent(state, delta('turn-1', 'assistant-1', 'partial'))
      state = applyEvent(
        state,
        event({
          name: 'message.reasoning',
          scope: threadScope,
          payload: {
            turnId: 'turn-1',
            messageId: 'reasoning-1',
            phase: 'delta',
            content: { type: 'text', text: 'thinking' },
          },
        }),
      )
      state = applyEvent(
        state,
        event({
          name: 'interaction.requested',
          scope: threadScope,
          payload: { turnId: 'turn-1', interaction: permission },
        }),
      )
      const terminal =
        name === 'turn.failed'
          ? event({
              name,
              scope: threadScope,
              payload: { turnId: 'turn-1', reason: 'provider_error', message: 'Failed' },
            })
          : event({ name, scope: threadScope, payload: { turnId: 'turn-1' } })
      state = applyEvent(state, terminal)
      const settled = state.threads[THREAD.threadId]!
      expect(settled.turns[0]?.state).toBe(name.slice(5))
      expect(settled.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'partial' }])
      expect(settled.reasoning[0]?.phase).toBe('stop')
      expect(settled.interactions).toEqual([])
      expect(selectActiveTurn(state)).toBeNull()
      expect(applyEvent(state, terminal).threads[THREAD.threadId]).toBe(settled)
      expect(
        applyEvent(state, delta('turn-1', 'assistant-1', 'late')).threads[THREAD.threadId],
      ).toBe(settled)
      expect(applyEvent(state, completed()).threads[THREAD.threadId]).toBe(settled)
      expect(applyEvent(state, turnStarted()).threads[THREAD.threadId]?.turns[0]?.state).toBe(
        name.slice(5),
      )
    },
  )
})
