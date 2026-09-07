import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ClientMessageSchema,
  EnvelopeSchema,
  HEARTBEAT_POLICY,
  HEARTBEAT_TIMEOUT_CLOSE_CODE,
  HEARTBEAT_TIMEOUT_REASON,
  HeartbeatPingSchema,
  HeartbeatPongSchema,
  ServerMessageSchema,
  acceptHeartbeatPong,
  advanceClientHeartbeat,
  advanceServerHeartbeat,
  createClientHeartbeatState,
  createServerHeartbeatState,
  observeServerActivity,
  respondToHeartbeat,
  type ClientHeartbeatAction,
  type HeartbeatPing,
  type HeartbeatPong,
  type ServerHeartbeatAction,
} from '@openmanager/protocol'

describe('heartbeat wire messages', () => {
  const ping = { type: 'ping', heartbeatId: 'hb-1' } as const
  const pong = { type: 'pong', heartbeatId: 'hb-1' } as const

  it('validates ping and pong in only their allowed direction', () => {
    expect(ServerMessageSchema.parse(ping)).toEqual(ping)
    expect(ClientMessageSchema.safeParse(ping).success).toBe(false)
    expect(ClientMessageSchema.parse(pong)).toEqual(pong)
    expect(ServerMessageSchema.safeParse(pong).success).toBe(false)
    expect(EnvelopeSchema.parse(ping)).toEqual(ping)
    expect(EnvelopeSchema.parse(pong)).toEqual(pong)
    expectTypeOf(HeartbeatPingSchema.parse(ping)).toEqualTypeOf<HeartbeatPing>()
    expectTypeOf(HeartbeatPongSchema.parse(pong)).toEqualTypeOf<HeartbeatPong>()
  })

  it.each(['', 'hb.1', ' hb-1', 'hb-1 ', 'a'.repeat(129), null, 1])(
    'rejects invalid heartbeat identity %j',
    (heartbeatId) => {
      expect(HeartbeatPingSchema.safeParse({ type: 'ping', heartbeatId }).success).toBe(false)
      expect(HeartbeatPongSchema.safeParse({ type: 'pong', heartbeatId }).success).toBe(false)
    },
  )

  it('echoes an opaque heartbeat identity', () => {
    expect(respondToHeartbeat({ type: 'ping', heartbeatId: 'HB_a-12' })).toEqual({
      type: 'pong',
      heartbeatId: 'HB_a-12',
    })
  })
})

describe('server heartbeat lifecycle', () => {
  it('sends on the fixed interval and accepts only a matching timely pong', () => {
    const initial = createServerHeartbeatState(1_000)
    expect(advanceServerHeartbeat(initial, 15_999).action).toEqual({
      type: 'wait',
      delayMs: 1,
    })

    const sent = advanceServerHeartbeat(initial, 16_000, 'hb-1')
    expect(sent.action).toEqual({
      type: 'send_ping',
      message: { type: 'ping', heartbeatId: 'hb-1' },
      pongTimeoutMs: HEARTBEAT_POLICY.pongTimeoutMs,
    })
    expect(advanceServerHeartbeat(sent.state, 16_001).action).toEqual({
      type: 'wait',
      delayMs: HEARTBEAT_POLICY.pongTimeoutMs - 1,
    })

    expect(
      acceptHeartbeatPong(sent.state, { type: 'pong', heartbeatId: 'stale' }, 17_000),
    ).toEqual({ state: sent.state, accepted: false })
    const accepted = acceptHeartbeatPong(
      sent.state,
      { type: 'pong', heartbeatId: 'hb-1' },
      17_000,
    )
    expect(accepted.accepted).toBe(true)
    expect(accepted.state.awaitingPong).toBeNull()
    expect(advanceServerHeartbeat(accepted.state, 30_999).action).toEqual({
      type: 'wait',
      delayMs: 1,
    })
  })

  it('closes and requires subscription cleanup at the pong deadline', () => {
    const sent = advanceServerHeartbeat(createServerHeartbeatState(0), 15_000, 'hb-1')
    const late = acceptHeartbeatPong(
      sent.state,
      { type: 'pong', heartbeatId: 'hb-1' },
      25_000,
    )
    expect(late.accepted).toBe(false)
    const result = advanceServerHeartbeat(late.state, 25_000)
    expect(result.action).toEqual({
      type: 'disconnect',
      code: HEARTBEAT_TIMEOUT_CLOSE_CODE,
      reason: HEARTBEAT_TIMEOUT_REASON,
      releaseSubscriptions: true,
    })
    expectTypeOf(result.action).toMatchTypeOf<ServerHeartbeatAction>()
  })

  it('does not generate overlapping pings and validates timer inputs', () => {
    const sent = advanceServerHeartbeat(createServerHeartbeatState(0), 15_000, 'hb-1')
    expect(advanceServerHeartbeat(sent.state, 20_000, 'hb-2').action.type).toBe('wait')
    expect(() => advanceServerHeartbeat(createServerHeartbeatState(0), 15_000)).toThrow()
    expect(() => createServerHeartbeatState(-1)).toThrow()
    expect(() => createServerHeartbeatState(Number.MAX_SAFE_INTEGER)).toThrow(RangeError)
  })
})

describe('client heartbeat lifecycle', () => {
  it('extends liveness on valid server activity', () => {
    const initial = createClientHeartbeatState(1_000)
    expect(advanceClientHeartbeat(initial, 45_999)).toEqual({ type: 'wait', delayMs: 1 })
    const observed = observeServerActivity(initial, 30_000)
    expect(observed.disconnectAtMs).toBe(30_000 + HEARTBEAT_POLICY.clientIdleTimeoutMs)
    expect(advanceClientHeartbeat(observed, 45_999).type).toBe('wait')
  })

  it('disconnects and enters reconnect at the idle deadline', () => {
    const state = createClientHeartbeatState(0)
    const action = advanceClientHeartbeat(state, HEARTBEAT_POLICY.clientIdleTimeoutMs)
    expect(action).toEqual({
      type: 'disconnect',
      code: HEARTBEAT_TIMEOUT_CLOSE_CODE,
      reason: HEARTBEAT_TIMEOUT_REASON,
      enterReconnectLoop: true,
    })
    expectTypeOf(action).toMatchTypeOf<ClientHeartbeatAction>()
  })
})
