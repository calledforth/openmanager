import { describe, expect, it } from 'vitest'
import { ProofEventSchema, type ScopeSnapshot } from '@openmanager/protocol'
import {
  applyEnvironment,
  applyEvent,
  applyInteractionResolved,
  applySessionHistory,
  applySessionOpen,
  applySnapshot,
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
      event({ name: 'workspace.updated', scope: environmentScope, payload: { workspace: WORKSPACE } }),
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
