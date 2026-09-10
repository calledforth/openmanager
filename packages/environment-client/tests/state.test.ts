import { describe, expect, it } from 'vitest'
import { ProofEventSchema, type ScopeSnapshot } from '@openmanager/protocol'
import {
  applyEvent,
  applySessionOpen,
  applySnapshot,
  createInitialState,
  selectActiveThread,
  selectActiveTurn,
  selectPendingInteractions,
  selectSessionList,
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
    event({ name: 'workspace.updated', scope: environmentScope, payload: { workspace: WORKSPACE } }),
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
        sessions: [SESSION],
      },
    })
    expect(state.environment?.name).toBe('Local')
    expect(selectSessionList(state)).toHaveLength(1)
  })

  it('hydrates from a session.open response', () => {
    const state = applySessionOpen(createInitialState(), {
      session: SESSION,
      threads: [THREAD],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'waiting' }],
      messages: [],
      interactions: [{ threadId: THREAD.threadId, interaction: permission }],
    })
    expect(state.sessions[SESSION.sessionId]?.threadIds).toEqual([THREAD.threadId])
    expect(state.sessions[SESSION.sessionId]?.status).toBe('waiting')
    expect(selectPendingInteractions(state, THREAD.threadId)[0]?.turnId).toBe('turn-1')
  })
})
