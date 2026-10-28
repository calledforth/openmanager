import { z } from 'zod'

/** Advertised by environments that implement the liveness contract below. */
export const HEARTBEAT_CAPABILITY = 'connection.heartbeat' as const

/**
 * Liveness, separate from flow control (docs/sync-foundations.md §7.2, D13).
 *
 * - The client sends a `beat` upstream every 10 s. Upstream frames travel
 *   against the downstream data, so a slow or full download cannot delay
 *   them. Acks and commands count as beats too.
 * - The server declares a connection dead after 30 s with no inbound frame
 *   at all (two lost beats). It never looks at downstream bytes, so it has no
 *   throughput floor.
 * - When it has written nothing for 15 s, the server sends a `keepalive`,
 *   which needs no answer.
 * - The client declares the server dead after 45 s with no frame received:
 *   any text frame, binary fragment or keepalive resets it, before parsing.
 */
export const HEARTBEAT_POLICY = Object.freeze({
  clientBeatIntervalMs: 10_000,
  serverInboundTimeoutMs: 30_000,
  serverKeepaliveIntervalMs: 15_000,
  clientIdleTimeoutMs: 45_000,
})

export const HEARTBEAT_TIMEOUT_CLOSE_CODE = 4000 as const
export const HEARTBEAT_TIMEOUT_REASON = 'heartbeat_timeout' as const

const ByteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Client → server: "still here". Carries nothing. */
export const BeatSchema = z.strictObject({ type: z.literal('beat') })
/**
 * Client → server flow control: the total payload bytes received on this
 * socket so far (docs/sync-foundations.md §7.2 point 2). It proves liveness
 * too, like any inbound frame.
 */
export const AckSchema = z.strictObject({ type: z.literal('ack'), received: ByteCountSchema })
/** Server → client: sent when the server has written nothing for a while. */
export const KeepaliveSchema = z.strictObject({ type: z.literal('keepalive') })

export type Beat = z.infer<typeof BeatSchema>
export type Ack = z.infer<typeof AckSchema>
export type Keepalive = z.infer<typeof KeepaliveSchema>

const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const ServerLivenessStateSchema = z.object({
  /** The last frame of any kind that arrived from the client. */
  lastInboundAtMs: TimestampSchema,
  /** The last frame of any kind the server wrote to the socket. */
  lastOutboundAtMs: TimestampSchema,
})
export const ClientLivenessStateSchema = z.object({
  /** The last frame of any kind that arrived from the server. */
  lastFrameAtMs: TimestampSchema,
  /** The last frame of any kind this client sent. */
  lastSentAtMs: TimestampSchema,
})
export type ServerLivenessState = z.infer<typeof ServerLivenessStateSchema>
export type ClientLivenessState = z.infer<typeof ClientLivenessStateSchema>

export type ServerLivenessAction =
  | { type: 'wait'; delayMs: number }
  /** Write a keepalive now if no message is half-written, then ask again after `delayMs`. */
  | { type: 'keepalive'; delayMs: number }
  | {
      type: 'disconnect'
      code: typeof HEARTBEAT_TIMEOUT_CLOSE_CODE
      reason: typeof HEARTBEAT_TIMEOUT_REASON
    }

export type ClientLivenessAction =
  | { type: 'wait'; delayMs: number }
  /** Send a beat now, then ask again after `delayMs`. */
  | { type: 'beat'; delayMs: number }
  | {
      type: 'disconnect'
      code: typeof HEARTBEAT_TIMEOUT_CLOSE_CODE
      reason: typeof HEARTBEAT_TIMEOUT_REASON
    }

const disconnect = {
  type: 'disconnect',
  code: HEARTBEAT_TIMEOUT_CLOSE_CODE,
  reason: HEARTBEAT_TIMEOUT_REASON,
} as const

/** Start when the socket opens; both clocks begin there. */
export function createServerLivenessState(nowMs: number): ServerLivenessState {
  const at = TimestampSchema.parse(nowMs)
  return { lastInboundAtMs: at, lastOutboundAtMs: at }
}

/**
 * The server's next timer action. A frame that arrives after the inbound
 * deadline (a starved timer, a machine that slept) is judged by this same
 * rule before it is read.
 */
export function advanceServerLiveness(
  stateInput: ServerLivenessState,
  nowInput: number,
): ServerLivenessAction {
  const state = ServerLivenessStateSchema.parse(stateInput)
  const nowMs = TimestampSchema.parse(nowInput)
  const deadline = state.lastInboundAtMs + HEARTBEAT_POLICY.serverInboundTimeoutMs
  if (nowMs >= deadline) return disconnect
  const keepaliveAt = state.lastOutboundAtMs + HEARTBEAT_POLICY.serverKeepaliveIntervalMs
  if (nowMs >= keepaliveAt) {
    return {
      type: 'keepalive',
      delayMs: Math.min(deadline - nowMs, HEARTBEAT_POLICY.serverKeepaliveIntervalMs),
    }
  }
  return { type: 'wait', delayMs: Math.min(deadline, keepaliveAt) - nowMs }
}

/** Start when the socket opens. */
export function createClientLivenessState(nowMs: number): ClientLivenessState {
  const at = TimestampSchema.parse(nowMs)
  return { lastFrameAtMs: at, lastSentAtMs: at }
}

/** The client's next timer action: give up on a silent server, or beat. */
export function advanceClientLiveness(
  stateInput: ClientLivenessState,
  nowInput: number,
): ClientLivenessAction {
  const state = ClientLivenessStateSchema.parse(stateInput)
  const nowMs = TimestampSchema.parse(nowInput)
  const deadline = state.lastFrameAtMs + HEARTBEAT_POLICY.clientIdleTimeoutMs
  if (nowMs >= deadline) return disconnect
  const beatAt = state.lastSentAtMs + HEARTBEAT_POLICY.clientBeatIntervalMs
  if (nowMs >= beatAt) {
    return {
      type: 'beat',
      delayMs: Math.min(deadline - nowMs, HEARTBEAT_POLICY.clientBeatIntervalMs),
    }
  }
  return { type: 'wait', delayMs: Math.min(deadline, beatAt) - nowMs }
}
