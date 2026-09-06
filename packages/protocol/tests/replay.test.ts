import { describe, expect, it } from 'vitest'
import {
  CursorSchema,
  DurableEventSchema,
  ReplayCommandSchema,
  ReplayResponseSchema,
  ScopeSnapshotSchema,
  SubscriptionEventSchema,
  decideReplay,
  parseReplayResult,
  ReplayCursorError,
  type Cursor,
} from '@openmanager/protocol'
import { environmentScope, sessionScope, threadScope, proofEvents } from './proof-fixtures.js'
import {
  replayCursor,
  replayCommand,
  replayRecords,
  replayResponse,
  scopeSnapshots,
  snapshotResponse,
  subscriptionEvent,
} from './replay-fixtures.js'

describe('cursor decisions', () => {
  const head: Cursor = { ...replayCursor, sequence: 10 }
  it.each([
    { cursor: null, oldest: 5, expected: { mode: 'snapshot', reason: 'initial' } },
    { cursor: { ...head, sequence: 4 }, oldest: 5, expected: { mode: 'replay' } },
    {
      cursor: { ...head, sequence: 3 },
      oldest: 5,
      expected: { mode: 'snapshot', reason: 'gap_expired' },
    },
    {
      cursor: { ...head, sequence: 11 },
      oldest: 5,
      expected: { mode: 'snapshot', reason: 'cursor_ahead' },
    },
    {
      cursor: { ...head, epoch: 'previous-epoch', sequence: 99 },
      oldest: 5,
      expected: { mode: 'snapshot', reason: 'stream_reset' },
    },
    { cursor: head, oldest: null, expected: { mode: 'replay' } },
    {
      cursor: { ...head, sequence: 9 },
      oldest: null,
      expected: { mode: 'snapshot', reason: 'gap_expired' },
    },
  ])('decides recovery for %j', ({ cursor, oldest, expected }) => {
    expect(decideReplay(threadScope, cursor, head, oldest)).toEqual(expected)
  })
  it('supports empty streams and safe integer exhaustion without an unsafe sentinel', () => {
    const empty = { ...head, sequence: 0 }
    expect(decideReplay(threadScope, empty, empty, null)).toEqual({ mode: 'replay' })
    const last = { ...head, sequence: Number.MAX_SAFE_INTEGER }
    expect(decideReplay(threadScope, last, last, null)).toEqual({ mode: 'replay' })
    expect(decideReplay(threadScope, { ...last, sequence: last.sequence - 1 }, last, null)).toEqual(
      { mode: 'snapshot', reason: 'gap_expired' },
    )
  })
  it.each([
    environmentScope,
    sessionScope,
    { ...threadScope, environmentId: 'other-env' },
    { ...threadScope, threadId: 'other-thread' },
    { ...threadScope, sessionId: 'other-session' },
  ])('rejects foreign scope %j without offering a snapshot', (scope) => {
    const foreign = { ...head, scope }
    expect(() => decideReplay(threadScope, foreign, head, 1)).toThrow(ReplayCursorError)
    expect(
      ReplayCommandSchema.safeParse({
        ...replayCommand,
        payload: { scope: threadScope, cursor: foreign },
      }).success,
    ).toBe(false)
    expect(() => decideReplay(threadScope, null, foreign, 1)).toThrow(ReplayCursorError)
  })
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    'rejects invalid sequence %s',
    (sequence) => {
      expect(CursorSchema.safeParse({ ...head, sequence }).success).toBe(false)
    },
  )
  it.each([0, -1, 1.5, 11, Infinity])('rejects invalid retention boundary %s', (oldest) => {
    expect(() => decideReplay(threadScope, replayCursor, head, oldest)).toThrow(ReplayCursorError)
  })
})

describe('replay and snapshot wire validation', () => {
  it('round-trips a request, replay result, snapshot result and live delivery', () => {
    expect(ReplayCommandSchema.parse(JSON.parse(JSON.stringify(replayCommand)))).toEqual(
      replayCommand,
    )
    for (const response of [replayResponse, snapshotResponse]) {
      expect(parseReplayResult(replayCommand, JSON.parse(JSON.stringify(response)))).toEqual(
        response,
      )
    }
    expect(SubscriptionEventSchema.parse(JSON.parse(JSON.stringify(subscriptionEvent)))).toEqual(
      subscriptionEvent,
    )
  })
  it.each(scopeSnapshots)('round-trips a complete scope snapshot', (snapshot) => {
    expect(ScopeSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })
  it('accepts an empty replay only at the requested cursor', () => {
    const response = {
      type: 'response',
      requestId: replayCommand.requestId,
      payload: {
        mode: 'replay',
        subscriptionId: 'sub',
        from: replayCursor,
        to: replayCursor,
        events: [],
      },
    }
    expect(parseReplayResult(replayCommand, response)).toEqual(response)
  })
  it.each([
    { events: [] },
    { events: [replayRecords[1]] },
    { events: [replayRecords[1], replayRecords[0]] },
    { events: [replayRecords[0], replayRecords[0]] },
    {
      events: [
        replayRecords[0],
        {
          ...replayRecords[1],
          event: { ...replayRecords[1].event, eventId: replayRecords[0].event.eventId },
        },
      ],
    },
    {
      events: [
        replayRecords[0],
        { ...replayRecords[1], cursor: { ...replayRecords[1].cursor, epoch: 'other-epoch' } },
      ],
    },
  ])('rejects a batch with holes, reordering, duplicates or another epoch: %j', ({ events }) => {
    expect(
      ReplayResponseSchema.safeParse({
        ...replayResponse,
        payload: { ...replayResponse.payload, events },
      }).success,
    ).toBe(false)
  })
  it('rejects mismatched cursor/event scopes, zero-sequence events and transient notices', () => {
    for (const invalid of [
      { ...replayRecords[0], cursor: { ...replayCursor, scope: environmentScope } },
      { ...replayRecords[0], cursor: { ...replayCursor, sequence: 0 } },
      { ...replayRecords[0], event: proofEvents.find((e) => e.name === 'turn.notice') },
    ])
      expect(DurableEventSchema.safeParse(invalid).success).toBe(false)
  })
  it('rejects a response for another request, scope, or starting position', () => {
    expect(() =>
      parseReplayResult(replayCommand, { ...replayResponse, requestId: 'other' }),
    ).toThrow()
    expect(() =>
      parseReplayResult(
        { ...replayCommand, payload: { scope: environmentScope, cursor: null } },
        snapshotResponse,
      ),
    ).toThrow()
    expect(() =>
      parseReplayResult(
        {
          ...replayCommand,
          payload: { scope: threadScope, cursor: { ...replayCursor, sequence: 2 } },
        },
        replayResponse,
      ),
    ).toThrow()
  })
  it('does not settle a pending replay from an uncorrelated error', () => {
    const error = {
      type: 'error',
      requestId: replayCommand.requestId,
      error: { code: 'not_found', message: 'Scope deleted' },
    }
    expect(parseReplayResult(replayCommand, error)).toEqual(error)
    expect(() => parseReplayResult(replayCommand, { ...error, requestId: null })).toThrow()
  })
  it('rejects contradictory snapshot reasons', () => {
    for (const reason of ['initial', 'cursor_ahead', 'stream_reset']) {
      expect(() =>
        parseReplayResult(replayCommand, {
          ...snapshotResponse,
          payload: { ...snapshotResponse.payload, reason },
        }),
      ).toThrow()
    }
  })
  it('accepts initial, reset and ahead snapshot recovery when justified by the request', () => {
    for (const [cursor, reason] of [
      [null, 'initial'],
      [{ ...replayCursor, epoch: 'old-epoch' }, 'stream_reset'],
      [{ ...replayCursor, sequence: 6 }, 'cursor_ahead'],
    ] as const) {
      const command = { ...replayCommand, payload: { scope: threadScope, cursor } }
      expect(() =>
        parseReplayResult(command, {
          ...snapshotResponse,
          payload: { ...snapshotResponse.payload, reason },
        }),
      ).not.toThrow()
    }
  })
  it('rejects snapshot resources belonging to another scope or missing turns', () => {
    const env = scopeSnapshots[0]
    expect(
      ScopeSnapshotSchema.safeParse({
        ...env,
        cursor: { ...env.cursor, scope: { ...environmentScope, environmentId: 'other' } },
      }).success,
    ).toBe(false)
    const session = scopeSnapshots[1]
    expect(
      ScopeSnapshotSchema.safeParse({
        ...session,
        cursor: { ...session.cursor, scope: { ...sessionScope, sessionId: 'other' } },
      }).success,
    ).toBe(false)
    const thread = scopeSnapshots[2]
    expect(
      ScopeSnapshotSchema.safeParse({
        ...thread,
        cursor: { ...thread.cursor, scope: { ...threadScope, threadId: 'other' } },
      }).success,
    ).toBe(false)
    expect(
      ScopeSnapshotSchema.safeParse({ ...thread, state: { ...thread.state, turns: [] } }).success,
    ).toBe(false)
  })
})
