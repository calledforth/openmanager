import { describe, expect, it } from 'vitest'
import {
  AckSchema,
  BeatSchema,
  ClientMessageSchema,
  EnvelopeSchema,
  HEARTBEAT_POLICY,
  HEARTBEAT_TIMEOUT_CLOSE_CODE,
  HEARTBEAT_TIMEOUT_REASON,
  KeepaliveSchema,
  ServerMessageSchema,
  advanceClientLiveness,
  advanceServerLiveness,
  createClientLivenessState,
  createServerLivenessState,
} from '@openmanager/protocol'

describe('liveness wire messages', () => {
  it('validates beat and ack upstream only, keepalive downstream only', () => {
    const beat = { type: 'beat' } as const
    const ack = { type: 'ack', received: 1024 } as const
    const keepalive = { type: 'keepalive' } as const
    expect(ClientMessageSchema.parse(beat)).toEqual(beat)
    expect(ClientMessageSchema.parse(ack)).toEqual(ack)
    expect(ServerMessageSchema.safeParse(beat).success).toBe(false)
    expect(ServerMessageSchema.safeParse(ack).success).toBe(false)
    expect(ServerMessageSchema.parse(keepalive)).toEqual(keepalive)
    expect(ClientMessageSchema.safeParse(keepalive).success).toBe(false)
    for (const message of [beat, ack, keepalive]) {
      expect(EnvelopeSchema.parse(message)).toEqual(message)
    }
  })

  it('has no ping or pong any more', () => {
    expect(ServerMessageSchema.safeParse({ type: 'ping', heartbeatId: 'hb-1' }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: 'pong', heartbeatId: 'hb-1' }).success).toBe(false)
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects ack count %j', (received) => {
    expect(AckSchema.safeParse({ type: 'ack', received }).success).toBe(false)
  })

  it('rejects extra fields on control messages', () => {
    expect(BeatSchema.safeParse({ type: 'beat', extra: 1 }).success).toBe(false)
    expect(KeepaliveSchema.safeParse({ type: 'keepalive', extra: 1 }).success).toBe(false)
  })
})

describe('server liveness', () => {
  const start = 1_000

  it('closes only after 30 s without any inbound frame', () => {
    const state = createServerLivenessState(start)
    expect(advanceServerLiveness(state, start + 29_999).type).not.toBe('disconnect')
    expect(advanceServerLiveness(state, start + 30_000)).toEqual({
      type: 'disconnect',
      code: HEARTBEAT_TIMEOUT_CLOSE_CODE,
      reason: HEARTBEAT_TIMEOUT_REASON,
    })
  })

  it('never looks at downstream bytes: a long write keeps nothing alive and kills nothing', () => {
    // Writing continuously (lastOutbound = now) with beats arriving keeps the socket.
    let state = createServerLivenessState(start)
    for (let t = start; t < start + 300_000; t += 10_000) {
      state = { lastInboundAtMs: t, lastOutboundAtMs: t }
      expect(advanceServerLiveness(state, t + 9_999).type).toBe('wait')
    }
    // Writing continuously with no beats closes at 30 s.
    state = { lastInboundAtMs: start, lastOutboundAtMs: start + 29_000 }
    expect(advanceServerLiveness(state, start + 30_000).type).toBe('disconnect')
  })

  it('asks for a keepalive after 15 s without writing', () => {
    const state = createServerLivenessState(start)
    expect(advanceServerLiveness(state, start + 14_999)).toEqual({ type: 'wait', delayMs: 1 })
    expect(advanceServerLiveness(state, start + 15_000)).toEqual({
      type: 'keepalive',
      delayMs: HEARTBEAT_POLICY.serverKeepaliveIntervalMs,
    })
  })

  it('waits for the nearer of the inbound deadline and the next keepalive', () => {
    const state = { lastInboundAtMs: start, lastOutboundAtMs: start + 20_000 }
    expect(advanceServerLiveness(state, start + 25_000)).toEqual({ type: 'wait', delayMs: 5_000 })
  })
})

describe('client liveness', () => {
  const start = 5_000

  it('beats every 10 s of not sending', () => {
    const state = createClientLivenessState(start)
    expect(advanceClientLiveness(state, start + 9_999)).toEqual({ type: 'wait', delayMs: 1 })
    expect(advanceClientLiveness(state, start + 10_000)).toEqual({
      type: 'beat',
      delayMs: HEARTBEAT_POLICY.clientBeatIntervalMs,
    })
  })

  it('gives up after 45 s without any frame from the server', () => {
    const state = { lastFrameAtMs: start, lastSentAtMs: start + 44_000 }
    expect(advanceClientLiveness(state, start + 44_999).type).toBe('wait')
    expect(advanceClientLiveness(state, start + 45_000)).toEqual({
      type: 'disconnect',
      code: HEARTBEAT_TIMEOUT_CLOSE_CODE,
      reason: HEARTBEAT_TIMEOUT_REASON,
    })
  })
})
