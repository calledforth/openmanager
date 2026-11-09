import { describe, expect, it } from 'vitest'
import type { DurableTurnNotice, ProofEvent, ScopeSnapshot } from '@openmanager/protocol'
import { cacheState } from '../src/cache-state'
import { createMockEnvironmentClient } from '../src/mock'
import {
  applyEvent,
  applyLiveNoticesCleared,
  applySnapshot,
  createInitialState,
} from '../src/state'
import type { EnvironmentState } from '../src/types'
import { SESSION, THREAD, WORKSPACE, delta, event, threadScope, turnStarted } from './fixtures'

const seed = { workspaces: [WORKSPACE], sessions: [{ session: SESSION, threads: [THREAD] }] }

const seeded = (): EnvironmentState => {
  return applyEvent(createInitialState(), turnStarted())
}
const thread = (state: EnvironmentState) => state.threads[THREAD.threadId]!

const recorded = (noticeId: string, extra: object = {}) =>
  event({
    name: 'turn.notice.recorded',
    scope: threadScope,
    payload: { noticeId, turnId: 'turn-1', kind: 'compacted', message: 'Compacted', ...extra },
  }) as ProofEvent
const live = (message: string, turnId = 'turn-1') =>
  event({
    name: 'turn.notice',
    scope: threadScope,
    payload: { noticeId: 'notice-1', turnId, kind: 'retrying', message },
  }) as ProofEvent
const cleared = (turnId = 'turn-1') =>
  event({ name: 'turn.notice.cleared', scope: threadScope, payload: { turnId } }) as ProofEvent

describe('durable notices', () => {
  it('places a notice in the order of its turn, once', () => {
    let state = seeded()
    state = applyEvent(state, recorded('notice-1'))
    state = applyEvent(state, recorded('notice-1'))
    expect(thread(state).notices.map((notice) => notice.noticeId)).toEqual(['notice-1'])
    expect(thread(state).order.filter((ref) => ref.kind === 'notice')).toEqual([
      { kind: 'notice', id: 'notice-1', turnId: 'turn-1' },
    ])
  })

  it('takes notices from a snapshot whole, and keeps the objects it already holds', () => {
    let state = applyEvent(seeded(), recorded('notice-1'))
    const held = thread(state).notices[0]!
    const notices: DurableTurnNotice[] = [
      { ...held },
      { noticeId: 'notice-2', turnId: 'turn-1', kind: 'warning', message: 'Careful' },
    ]
    state = applySnapshot(state, {
      cursor: { scope: threadScope, epoch: 'e', sequence: 9 },
      state: {
        thread: THREAD,
        turns: thread(state).turns,
        messages: [],
        reasoning: [],
        tools: [],
        notices,
        order: notices.map((notice) => ({
          kind: 'notice' as const,
          id: notice.noticeId,
          turnId: notice.turnId,
        })),
        interactions: [],
        listing: {},
        queue: { items: [], pausedBy: null },
      },
    } as ScopeSnapshot)
    expect(thread(state).notices.map((notice) => notice.noticeId)).toEqual(['notice-1', 'notice-2'])
    expect(thread(state).notices[0]).toBe(held)
  })

  it('survives a reload, unlike a live notice', () => {
    let state = applyEvent(seeded(), recorded('notice-1'))
    state = applyEvent(state, live('Retrying'))
    const cached = thread(cacheState(state))
    expect(cached.notices).toHaveLength(1)
    expect(cached.liveNotices).toEqual([])
  })
})

describe('live notices', () => {
  it('keeps the newest per turn, until the server says it is over', () => {
    let state = applyEvent(seeded(), live('attempt 1'))
    state = applyEvent(state, live('attempt 2'))
    expect(thread(state).liveNotices.map((notice) => notice.message)).toEqual(['attempt 2'])
    // Text alone changes nothing: only the server ends a notice.
    state = applyEvent(state, delta('turn-1', 'assistant-1', 'Back') as ProofEvent)
    expect(thread(state).liveNotices).toHaveLength(1)
    state = applyEvent(state, cleared())
    expect(thread(state).liveNotices).toEqual([])
  })

  it('ignores the end of a notice it never held, and keeps the state it had', () => {
    const state = seeded()
    expect(thread(applyEvent(state, cleared()))).toBe(thread(state))
  })

  it('starts over at a catch-up, since a fresh load has none', () => {
    const state = applyEvent(seeded(), live('Retrying'))
    expect(thread(applyLiveNoticesCleared(state, THREAD.threadId)).liveNotices).toEqual([])
    const quiet = seeded()
    expect(applyLiveNoticesCleared(quiet, THREAD.threadId)).toBe(quiet)
  })
})

describe('typed failures', () => {
  it('keeps everything the failure said on the turn', () => {
    const state = applyEvent(
      seeded(),
      event({
        name: 'turn.failed',
        scope: threadScope,
        payload: {
          turnId: 'turn-1',
          reason: 'usage_limit',
          message: "You've reached your usage limit.",
          action: 'retry',
          resetsAt: '2026-10-09T15:00:00.000Z',
          detail: 'Claude says so.',
        },
      }) as ProofEvent,
    )
    expect(thread(state).turns[0]?.failure).toEqual({
      reason: 'usage_limit',
      message: "You've reached your usage limit.",
      action: 'retry',
      resetsAt: '2026-10-09T15:00:00.000Z',
      detail: 'Claude says so.',
    })
  })
})

describe('the mock server', () => {
  it('ends a live notice at the next event of its turn, and keeps a typed failure', async () => {
    const client = createMockEnvironmentClient({ seed })
    const { turn } = await client.commands.sendTurn({ ...THREAD, text: 'hi' })
    const target = { ...THREAD, turnId: turn.turnId }
    const held = () => client.getState().threads[THREAD.threadId]!
    client.notice(target, { kind: 'retrying', message: 'Retrying' })
    expect(held().liveNotices).toHaveLength(1)
    client.recordNotice(target, { kind: 'info', message: 'Noted' })
    expect(held().liveNotices).toEqual([])
    expect(held().notices.map((notice) => notice.message)).toEqual(['Noted'])
    client.failTurn(target, 'overloaded', 'Overloaded', { action: 'retry' })
    expect(held().turns.at(-1)?.failure).toEqual({
      reason: 'overloaded',
      message: 'Overloaded',
      action: 'retry',
    })
    client.dispose()
  })
})
