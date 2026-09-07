import { z } from 'zod'
import { RequestIdSchema } from './primitives.js'

/** Advertised by environments that implement the application heartbeat contract. */
export const HEARTBEAT_CAPABILITY = 'connection.heartbeat' as const

/**
 * One server ping every 15 seconds keeps quiet connections below common proxy
 * idle limits. The asymmetric timeouts let the server reclaim dead connection
 * state quickly while giving clients enough time to miss multiple heartbeats.
 */
export const HEARTBEAT_POLICY = Object.freeze({
  serverPingIntervalMs: 15_000,
  pongTimeoutMs: 10_000,
  clientIdleTimeoutMs: 45_000,
})

export const HEARTBEAT_TIMEOUT_CLOSE_CODE = 4000 as const
export const HEARTBEAT_TIMEOUT_REASON = 'heartbeat_timeout' as const

export const HeartbeatIdSchema = RequestIdSchema
export const HeartbeatPingSchema = z.object({
  type: z.literal('ping'),
  heartbeatId: HeartbeatIdSchema,
})
export const HeartbeatPongSchema = z.object({
  type: z.literal('pong'),
  heartbeatId: HeartbeatIdSchema,
})

export type HeartbeatId = z.infer<typeof HeartbeatIdSchema>
export type HeartbeatPing = z.infer<typeof HeartbeatPingSchema>
export type HeartbeatPong = z.infer<typeof HeartbeatPongSchema>

const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const OutstandingHeartbeatSchema = z.object({
  heartbeatId: HeartbeatIdSchema,
  deadlineMs: TimestampSchema,
})

export const ServerHeartbeatStateSchema = z.object({
  nextPingAtMs: TimestampSchema,
  awaitingPong: OutstandingHeartbeatSchema.nullable(),
})
export const ClientHeartbeatStateSchema = z.object({
  disconnectAtMs: TimestampSchema,
})

export type ServerHeartbeatState = z.infer<typeof ServerHeartbeatStateSchema>
export type ClientHeartbeatState = z.infer<typeof ClientHeartbeatStateSchema>

export type ServerHeartbeatAction =
  | { type: 'wait'; delayMs: number }
  | { type: 'send_ping'; message: HeartbeatPing; pongTimeoutMs: number }
  | {
      type: 'disconnect'
      code: typeof HEARTBEAT_TIMEOUT_CLOSE_CODE
      reason: typeof HEARTBEAT_TIMEOUT_REASON
      releaseSubscriptions: true
    }

export type ClientHeartbeatAction =
  | { type: 'wait'; delayMs: number }
  | {
      type: 'disconnect'
      code: typeof HEARTBEAT_TIMEOUT_CLOSE_CODE
      reason: typeof HEARTBEAT_TIMEOUT_REASON
      enterReconnectLoop: true
    }

function timestamp(input: number): number {
  return TimestampSchema.parse(input)
}

function deadline(nowMs: number, durationMs: number): number {
  const value = timestamp(nowMs) + durationMs
  if (!Number.isSafeInteger(value)) throw new RangeError('Heartbeat deadline exceeds safe range')
  return value
}

/** Start this state only after the WebSocket application handshake succeeds. */
export function createServerHeartbeatState(nowMs: number): ServerHeartbeatState {
  return {
    nextPingAtMs: deadline(nowMs, HEARTBEAT_POLICY.serverPingIntervalMs),
    awaitingPong: null,
  }
}

/**
 * Decide the server's next timer action. `heartbeatId` is required only when a
 * ping is due, and must be fresh for this connection.
 */
export function advanceServerHeartbeat(
  stateInput: ServerHeartbeatState,
  nowInput: number,
  heartbeatId?: string,
): { state: ServerHeartbeatState; action: ServerHeartbeatAction } {
  const state = ServerHeartbeatStateSchema.parse(stateInput)
  const nowMs = timestamp(nowInput)
  if (state.awaitingPong) {
    if (nowMs >= state.awaitingPong.deadlineMs) {
      return {
        state,
        action: {
          type: 'disconnect',
          code: HEARTBEAT_TIMEOUT_CLOSE_CODE,
          reason: HEARTBEAT_TIMEOUT_REASON,
          releaseSubscriptions: true,
        },
      }
    }
    return {
      state,
      action: { type: 'wait', delayMs: state.awaitingPong.deadlineMs - nowMs },
    }
  }
  if (nowMs < state.nextPingAtMs) {
    return { state, action: { type: 'wait', delayMs: state.nextPingAtMs - nowMs } }
  }

  const message = HeartbeatPingSchema.parse({ type: 'ping', heartbeatId })
  const nextState = {
    nextPingAtMs: deadline(nowMs, HEARTBEAT_POLICY.serverPingIntervalMs),
    awaitingPong: {
      heartbeatId: message.heartbeatId,
      deadlineMs: deadline(nowMs, HEARTBEAT_POLICY.pongTimeoutMs),
    },
  } satisfies ServerHeartbeatState
  return {
    state: nextState,
    action: { type: 'send_ping', message, pongTimeoutMs: HEARTBEAT_POLICY.pongTimeoutMs },
  }
}

/** Only the current pong, received before its deadline, proves client liveness. */
export function acceptHeartbeatPong(
  stateInput: ServerHeartbeatState,
  pongInput: unknown,
  nowInput: number,
): { state: ServerHeartbeatState; accepted: boolean } {
  const state = ServerHeartbeatStateSchema.parse(stateInput)
  const pong = HeartbeatPongSchema.parse(pongInput)
  const nowMs = timestamp(nowInput)
  if (
    !state.awaitingPong ||
    pong.heartbeatId !== state.awaitingPong.heartbeatId ||
    nowMs >= state.awaitingPong.deadlineMs
  ) {
    return { state, accepted: false }
  }
  return { state: { ...state, awaitingPong: null }, accepted: true }
}

/** Start this state when a client establishes a usable, handshaken connection. */
export function createClientHeartbeatState(nowMs: number): ClientHeartbeatState {
  return { disconnectAtMs: deadline(nowMs, HEARTBEAT_POLICY.clientIdleTimeoutMs) }
}

/** Call after any valid server message; all authenticated traffic proves liveness. */
export function observeServerActivity(
  stateInput: ClientHeartbeatState,
  nowInput: number,
): ClientHeartbeatState {
  ClientHeartbeatStateSchema.parse(stateInput)
  return { disconnectAtMs: deadline(nowInput, HEARTBEAT_POLICY.clientIdleTimeoutMs) }
}

/** A ping is answered by echoing its opaque identity without normalization. */
export function respondToHeartbeat(pingInput: unknown): HeartbeatPong {
  const ping = HeartbeatPingSchema.parse(pingInput)
  return HeartbeatPongSchema.parse({ type: 'pong', heartbeatId: ping.heartbeatId })
}

/** Decide whether the client should keep waiting or enter its reconnect loop. */
export function advanceClientHeartbeat(
  stateInput: ClientHeartbeatState,
  nowInput: number,
): ClientHeartbeatAction {
  const state = ClientHeartbeatStateSchema.parse(stateInput)
  const nowMs = timestamp(nowInput)
  if (nowMs >= state.disconnectAtMs) {
    return {
      type: 'disconnect',
      code: HEARTBEAT_TIMEOUT_CLOSE_CODE,
      reason: HEARTBEAT_TIMEOUT_REASON,
      enterReconnectLoop: true,
    }
  }
  return { type: 'wait', delayMs: state.disconnectAtMs - nowMs }
}
