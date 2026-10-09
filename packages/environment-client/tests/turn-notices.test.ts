import { describe, expect, it } from 'vitest'
import type { ScopeSnapshot } from '@openmanager/protocol'
import { applyEvent, applySessionHistory, applySnapshot, createInitialState } from '../src/state'
import type { EnvironmentState } from '../src/types'
import {
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
  for (const next of [
    event({
      name: 'workspace.updated',
      scope: environmentScope,
      payload: { workspace: WORKSPACE },
    }),
    event({ name: 'session.created', scope: environmentScope, payload: { session: SESSION } }),
    event({ name: 'thread.created', scope: sessionScope, payload: { thread: THREAD } }),
  ])
    state = applyEvent(state, next)
  return applyEvent(
    { ...state, activeSessionId: SESSION.sessionId, activeThreadId: THREAD.threadId },
    turnStarted(),
  )
}

const retrying = (attempt: number, turnId = 'turn-1') =>
  event({
    name: 'turn.notice',
    scope: threadScope,
    payload: {
      noticeId: `retry-${attempt}`,
      turnId,
      kind: 'retrying',
      message: `Retrying (attempt ${attempt} of 10)`,
      retry: { attempt, maxAttempts: 10, cause: 'overloaded' },
    },
  })
const recorded = (noticeId: string, kind: 'compacted' | 'warning' = 'compacted') =>
  event({
    name: 'turn.notice.recorded',
    scope: threadScope,
    payload: { noticeId, turnId: 'turn-1', kind, message: 'Conversation compacted' },
  })
const thread = (state: EnvironmentState) => state.threads[THREAD.threadId]!

describe('live notices', () => {
  it('keeps only the newest notice of a turn', () => {
    let state = applyEvent(seeded(), retrying(1))
    state = applyEvent(state, retrying(2))
    expect(thread(state).liveNotices.map((notice) => notice.noticeId)).toEqual(['retry-2'])
  })

  it.each([
    ['assistant text', delta('turn-1', 'assistant-1', 'Back')],
    [
      'a thought',
      event({
        name: 'message.reasoning',
        scope: threadScope,
        payload: { turnId: 'turn-1', messageId: 'thought-1', phase: 'start' },
      }),
    ],
    [
      'a tool call',
      event({
        name: 'tool.updated',
        scope: threadScope,
        payload: { turnId: 'turn-1', toolCallId: 'tool-1', status: 'pending' },
      }),
    ],
    ['a recorded notice', recorded('notice-1')],
    [
      'a question',
      event({
        name: 'interaction.requested',
        scope: threadScope,
        payload: { turnId: 'turn-1', interaction: permission },
      }),
    ],
    ['the end of the turn', completed()],
  ])('goes away once the turn moves on with %s', (_, next) => {
    const state = applyEvent(applyEvent(seeded(), retrying(1)), next)
    expect(thread(state).liveNotices).toEqual([])
  })

  it('is ignored for a turn that already ended', () => {
    const ended = applyEvent(seeded(), completed())
    expect(applyEvent(ended, retrying(1))).toBe(ended)
  })

  it('leaves other turns alone', () => {
    const state = applyEvent(applyEvent(seeded(), retrying(1)), delta('turn-2', 'a-2', 'x'))
    expect(thread(state).liveNotices).toHaveLength(1)
  })
})

describe('durable notices', () => {
  it('places a notice in the order of its turn, once', () => {
    let state = applyEvent(seeded(), delta('turn-1', 'assistant-1', 'Before'))
    state = applyEvent(state, recorded('notice-1'))
    state = applyEvent(state, recorded('notice-1'))
    state = applyEvent(state, delta('turn-1', 'assistant-2', 'After'))
    expect(thread(state).order.map((ref) => `${ref.kind}:${ref.id}`)).toEqual([
      'message:turn-1-user',
      'message:assistant-1',
      'notice:notice-1',
      'message:assistant-2',
    ])
    expect(thread(state).notices).toHaveLength(1)
  })

  it('comes back with a snapshot, and live notices of ended turns do not', () => {
    const live = applyEvent(seeded(), retrying(1))
    const snapshot: ScopeSnapshot = {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 4 },
      state: {
        thread: THREAD,
        turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
        messages: [],
        reasoning: [],
        tools: [],
        order: [{ kind: 'notice', id: 'notice-1', turnId: 'turn-1' }],
        notices: [
          { noticeId: 'notice-1', turnId: 'turn-1', kind: 'compacted', message: 'Compacted' },
        ],
        interactions: [],
      },
    }
    const state = applySnapshot(live, snapshot)
    expect(thread(state).notices.map((notice) => notice.noticeId)).toEqual(['notice-1'])
    expect(thread(state).order).toEqual([{ kind: 'notice', id: 'notice-1', turnId: 'turn-1' }])
    expect(thread(state).liveNotices).toEqual([])
  })

  it('keeps the notices and order of older history a reconnect snapshot does not carry', () => {
    let state = applyEvent(seeded(), delta('turn-1', 'a1', 'First answer'))
    state = applyEvent(state, recorded('n-old'))
    state = applyEvent(state, completed())
    state = applyEvent(state, turnStarted('turn-2', 'again'))
    state = applyEvent(state, delta('turn-2', 'a2', 'Second answer'))
    const message = (messageId: string, turnId: string, role: 'user' | 'assistant') => ({
      messageId,
      threadId: THREAD.threadId,
      turnId,
      role,
      content: [{ type: 'text' as const, text: messageId }],
    })
    // The newest page only: everything of turn 1 is older history.
    const snapshot: ScopeSnapshot = {
      cursor: { scope: threadScope, epoch: 'epoch', sequence: 9 },
      state: {
        thread: THREAD,
        turns: [
          { turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' },
          { turnId: 'turn-2', threadId: THREAD.threadId, state: 'completed' },
        ],
        messages: [message('turn-2-user', 'turn-2', 'user'), message('a2', 'turn-2', 'assistant')],
        nextCursor: { ordinal: 3 },
        reasoning: [],
        tools: [],
        order: [
          { kind: 'message', id: 'turn-2-user', turnId: 'turn-2' },
          { kind: 'message', id: 'a2', turnId: 'turn-2' },
        ],
        notices: [],
        interactions: [],
      },
    }
    const after = thread(applySnapshot(state, snapshot))
    expect(after.notices.map((notice) => notice.noticeId)).toEqual(['n-old'])
    expect(after.order.map((ref) => `${ref.kind}:${ref.id}`)).toEqual([
      'message:turn-1-user',
      'message:a1',
      'notice:n-old',
      'message:turn-2-user',
      'message:a2',
    ])
  })

  it('merges a history page without losing live ones', () => {
    let state = applyEvent(seeded(), recorded('notice-live', 'warning'))
    state = applySessionHistory(state, THREAD, {
      messages: [],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'running' }],
      interactions: [],
      order: [{ kind: 'notice', id: 'notice-old', turnId: 'turn-1' }],
      notices: [
        { noticeId: 'notice-old', turnId: 'turn-1', kind: 'compacted', message: 'Compacted' },
      ],
      nextCursor: null,
    })
    expect(
      thread(state)
        .notices.map((notice) => notice.noticeId)
        .sort(),
    ).toEqual(['notice-live', 'notice-old'])
  })
})

describe('typed failures', () => {
  it('keeps the reason, action and reset time on the turn and in failures', () => {
    const state = applyEvent(
      seeded(),
      event({
        name: 'turn.failed',
        scope: threadScope,
        payload: {
          turnId: 'turn-1',
          reason: 'usage_limit',
          message: "You've reached your usage limit.",
          resetsAt: '2026-10-09T15:00:00.000Z',
        },
      }),
    )
    const failure = {
      reason: 'usage_limit',
      message: "You've reached your usage limit.",
      resetsAt: '2026-10-09T15:00:00.000Z',
    }
    expect(thread(state).turns[0]).toMatchObject({ state: 'failed', failure })
    expect(thread(state).failures).toEqual([{ turnId: 'turn-1', ...failure }])
  })
})
