import { describe, expect, it } from 'vitest'
import {
  DurableEventSchema,
  ProofEventSchemas,
  ScopeSnapshotSchema,
  TURN_NOTICE_TEXT_MAX,
  TurnSchema,
  ProofResponseSchemas,
} from '@openmanager/protocol'
import { threadScope } from './proof-fixtures.js'
import { replayCursor, scopeSnapshots } from './replay-fixtures.js'

const base = { type: 'event', eventId: 'event-1', timestamp: '2026-10-09T10:00:00.000Z' } as const
const notice = (name: 'turn.notice' | 'turn.notice.recorded', payload: object) => ({
  ...base,
  name,
  scope: threadScope,
  payload: { noticeId: 'notice-1', turnId: 'turn-1', message: 'Something happened', ...payload },
})

describe('turn notices', () => {
  it('carries retry progress on a transient notice', () => {
    const parsed = ProofEventSchemas['turn.notice'].parse(
      notice('turn.notice', {
        kind: 'retrying',
        retry: {
          attempt: 2,
          maxAttempts: 10,
          cause: 'overloaded',
          retryAt: '2026-10-09T10:00:05.000Z',
        },
      }),
    )
    expect(parsed.payload.retry).toEqual({
      attempt: 2,
      maxAttempts: 10,
      cause: 'overloaded',
      retryAt: '2026-10-09T10:00:05.000Z',
    })
  })

  it('keeps transient and durable kinds on their own events', () => {
    expect(
      ProofEventSchemas['turn.notice'].safeParse(notice('turn.notice', { kind: 'compacted' }))
        .success,
    ).toBe(false)
    expect(
      ProofEventSchemas['turn.notice.recorded'].safeParse(
        notice('turn.notice.recorded', { kind: 'retrying' }),
      ).success,
    ).toBe(false)
    for (const kind of [
      'compacted',
      'model_fallback',
      'refusal',
      'usage_warning',
      'info',
      'warning',
    ])
      expect(
        ProofEventSchemas['turn.notice.recorded'].safeParse(
          notice('turn.notice.recorded', { kind }),
        ).success,
      ).toBe(true)
  })

  it('bounds notice text', () => {
    const long = 'x'.repeat(TURN_NOTICE_TEXT_MAX + 1)
    expect(
      ProofEventSchemas['turn.notice.recorded'].safeParse(
        notice('turn.notice.recorded', { kind: 'info', message: long }),
      ).success,
    ).toBe(false)
    expect(
      ProofEventSchemas['turn.notice.recorded'].safeParse(
        notice('turn.notice.recorded', { kind: 'refusal', detail: long }),
      ).success,
    ).toBe(false)
  })

  it('gives durable notices a cursor and refuses one to transient notices', () => {
    const record = (event: unknown) => ({ cursor: replayCursor, event })
    expect(
      DurableEventSchema.safeParse(
        record(
          notice('turn.notice.recorded', {
            kind: 'model_fallback',
            model: { from: 'claude-opus', to: 'claude-sonnet' },
          }),
        ),
      ).success,
    ).toBe(true)
    expect(
      DurableEventSchema.safeParse(record(notice('turn.notice', { kind: 'retrying' }))).success,
    ).toBe(false)
  })
})

describe('typed turn failures', () => {
  const failed = (payload: object) => ({
    ...base,
    name: 'turn.failed',
    scope: threadScope,
    payload: { turnId: 'turn-1', message: 'Failed', ...payload },
  })

  it.each([
    ['context_window_exceeded', 'compact'],
    ['usage_limit', undefined],
    ['rate_limited', 'retry'],
    ['overloaded', 'retry'],
    ['authentication_required', 'sign_in'],
    ['refused', undefined],
  ])('accepts %s with action %s', (reason, action) => {
    expect(
      ProofEventSchemas['turn.failed'].safeParse(failed({ reason, ...(action ? { action } : {}) }))
        .success,
    ).toBe(true)
  })

  it('rejects an unknown reason or action', () => {
    expect(ProofEventSchemas['turn.failed'].safeParse(failed({ reason: 'tired' })).success).toBe(
      false,
    )
    expect(
      ProofEventSchemas['turn.failed'].safeParse(failed({ reason: 'overloaded', action: 'reboot' }))
        .success,
    ).toBe(false)
  })

  it('keeps the failure on the turn, reset time included', () => {
    const turn = TurnSchema.parse({
      turnId: 'turn-1',
      threadId: 'thread-1',
      state: 'failed',
      failure: {
        reason: 'usage_limit',
        message: 'You have reached your usage limit.',
        resetsAt: '2026-10-09T15:00:00.000Z',
      },
    })
    expect(turn.failure?.resetsAt).toBe('2026-10-09T15:00:00.000Z')
  })
})

describe('notices in history', () => {
  const threadSnapshot = scopeSnapshots[2]!
  const withNotice = (turnId: string) => ({
    ...threadSnapshot,
    state: {
      ...threadSnapshot.state,
      order: [
        { kind: 'message', id: 'message-2', turnId: 'turn-1' },
        { kind: 'notice', id: 'notice-1', turnId: 'turn-1' },
      ],
      notices: [{ noticeId: 'notice-1', turnId, kind: 'compacted', message: 'Compacted' }],
    },
  })

  it('places durable notices in a thread snapshot', () => {
    expect(ScopeSnapshotSchema.safeParse(withNotice('turn-1')).success).toBe(true)
  })

  it('rejects a snapshot notice for a turn it does not carry', () => {
    expect(ScopeSnapshotSchema.safeParse(withNotice('turn-9')).success).toBe(false)
  })

  it('returns notices with a history page', () => {
    const page = ProofResponseSchemas['session.history'].parse({
      type: 'response',
      requestId: 'history-1',
      payload: {
        messages: [],
        turns: [{ turnId: 'turn-1', threadId: 'thread-1', state: 'completed' }],
        interactions: [],
        order: [{ kind: 'notice', id: 'notice-1', turnId: 'turn-1' }],
        notices: [{ noticeId: 'notice-1', turnId: 'turn-1', kind: 'warning', message: 'Careful' }],
        nextCursor: null,
      },
    })
    expect(page.payload.notices).toHaveLength(1)
  })
})
