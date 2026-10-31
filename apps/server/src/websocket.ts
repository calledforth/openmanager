import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import {
  advanceServerLiveness,
  ClientMessageSchema,
  createServerLivenessState,
  CursorSchema,
  DurableEventSchema,
  HEARTBEAT_CAPABILITY,
  negotiateProtocolHandshake,
  ProofCommandSchemas,
  ReplayCommandSchema,
  ReplayCursorError,
  RequestIdSchema,
  accessDenied,
  CLIENT_LIST_CAPABILITY,
  CLIENT_REVOKED_CLOSE_CODE,
  CLIENT_REVOKED_CLOSE_REASON,
  CLIENT_UNAUTHORIZED_CLOSE_REASON,
  requiredAccess,
  sameScope,
  SERVER_SHUTDOWN_CLOSE_CODE,
  SERVER_SHUTDOWN_CLOSE_REASON,
  SubscriptionScopeSchema,
  TransientEventSchema,
  type BootstrapResponse,
  type CommandEnvelope,
  type Cursor,
  type ErrorCode,
  type ServerLivenessState,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { auditValue, type AuditLog } from './audit.ts'
import type { AuthenticatedClient } from './authorized-clients.ts'
import type { CommandContext } from './command-context.ts'
import {
  createConnectionWriter,
  type ConnectionWriter,
  type LaggingScope,
  type WriterStats,
} from './connection-writer.ts'
import { answerPayloadJson, type ReplayResult } from './db/replay.ts'
import type { Delivery } from './event-delivery.ts'
import type { Logger } from './logger.ts'
import { remoteAddressKey, type BudgetKey } from './budget-key.ts'
import type { RateLimiter, RateLimitPolicy } from './rate-limit.ts'
import type { RequestGuard } from './request-guard.ts'

export const SOCKET_CAPABILITIES = [
  HEARTBEAT_CAPABILITY,
  'subscription.subscribe',
  'subscription.unsubscribe',
  'subscription.replay',
]
export const SOCKET_LIMITS = Object.freeze({
  handshakeTimeoutMs: 10_000,
  closeTimeoutMs: 1_000,
  maxConnections: 128,
  maxSubscriptions: 128,
  maxCommands: 1024,
  maxPayloadBytes: 65_536,
})

/** Where one queued frame goes in a connection's writer (connection-writer.ts). */
type DeliveryTarget =
  { kind: 'scoped'; subscriptionId: string; cursor?: Cursor } | { kind: 'reading'; key: string }

const errorResult = (requestId: string | null, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})
const now = () => Math.floor(performance.now())
/** `unavailable` carries the `after_backoff` retry policy, which is what a budget overrun wants. */
const rateLimited = (requestId: string, policy: RateLimitPolicy, retryAfterMs: number) => ({
  type: 'error' as const,
  requestId,
  error: {
    code: 'unavailable' as const,
    message: `Rate limit exceeded; retry after ${retryAfterMs} ms.`,
    details: { policy, retryAfterMs },
  },
})

/**
 * Reads that need more than `read` (the device list needs `admin`) but change
 * nothing, so they are not counted against the mutation budget.
 */
const UNBUDGETED_READS: ReadonlySet<string> = new Set([CLIENT_LIST_CAPABILITY])

/**
 * A frame the server could not send: the connection closes so the client
 * reconnects and recovers from its bookmark (docs/sync-foundations.md §5.2).
 */
export const DELIVERY_FAILED_CLOSE_CODE = 1011
export const DELIVERY_FAILED_CLOSE_REASON = 'delivery_failed'

/** An answer already serialized (a replay answer built from stored JSON). */
class PreserializedAnswer {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

/**
 * A reading's key: a newer reading of the same key replaces a queued older
 * one (provider health per provider).
 */
function readingKey(event: { name: string; payload?: unknown }): string {
  const payload = event.payload as { providerId?: unknown } | undefined
  return `${event.name}:${typeof payload?.providerId === 'string' ? payload.providerId : ''}`
}

export const REVOKED_CLOSE_CODE = CLIENT_REVOKED_CLOSE_CODE
export const REVOKED_CLOSE_REASON = CLIENT_REVOKED_CLOSE_REASON

/** Transport owns only live connection state. Durable event records come from the host. */
export function attachWebSocket(
  server: Server,
  options: {
    /** Resolve a presented credential to its live client, or `undefined` to reject the upgrade. */
    authenticate: (credential: string | undefined) => AuthenticatedClient | undefined
    /** Host and Origin policy, shared with the HTTP listener. */
    guard: RequestGuard
    rateLimiter: RateLimiter
    /** Who a failed credential is counted against; see `budget-key.ts`. */
    budgetKey?: BudgetKey
    audit: AuditLog
    bootstrap: () => BootstrapResponse
    /** The environment every scope and event must belong to; known before the server listens. */
    environmentId: string
    /**
     * Answer a reconnecting client's cursor: the missed tail of the scope or a
     * snapshot of it. Synchronous on purpose, so the live subscription can be
     * registered in the same tick as the read and no event can fall between.
     */
    replay?: (scope: SubscriptionScope, cursor: Cursor | null) => ReplayResult
    dispatchCommand?: (
      command: CommandEnvelope,
      context: CommandContext,
    ) => unknown | Promise<unknown> | undefined
    /** Called after a socket completes its handshake or closes, so the device list can say who is connected. */
    onConnectionsChanged?: () => void
    /**
     * Send what the delivery queue holds (event-delivery.ts). Every answer
     * calls it first, so no answer overtakes an event committed before it:
     * a registration's `workspace.updated` reaches the socket before the
     * answer to `workspace.add`, and a replay's answer follows the records
     * its read already covers.
     */
    drainDeliveries?: () => void
    log?: Logger
  },
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: SOCKET_LIMITS.maxPayloadBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('openmanager.v1') ? 'openmanager.v1' : false),
  })
  type Connection = {
    client: AuthenticatedClient
    subscriptions: Map<string, SubscriptionScope>
    /** Live readings this connection asked to follow, such as the device list. */
    follows: Set<string>
    ready: boolean
    /** The client's grant changed: answer nothing more, close after the replies already sent. */
    retired: boolean
    send: (message: unknown) => void
    /**
     * Queue one frame of the delivery queue. A frame that cannot be built
     * closes this connection: the client reconnects and replays from its
     * bookmark, so nothing is skipped silently. A scoped frame the writer's
     * backlog bound refuses is not lost: its scope goes lagging and catches
     * up from the log (docs/sync-foundations.md §7.2).
     */
    deliver: (frame: () => unknown, target: DeliveryTarget) => void
    close: (code: number, reason: string) => void
    writer: ConnectionWriter
  }
  const connections = new Map<WebSocket, Connection>()
  // Clients being retired: a socket that authenticated under the old grant
  // and registers before the close pass is retired as well.
  const retiring = new Set<string>()
  let closing = false
  let closePromise: Promise<void> | undefined

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy())
    const reject = (status: number, code: ErrorCode, message: string, headers = '') => {
      const body = JSON.stringify(errorResult(null, code, message))
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        () => socket.destroy(),
      )
    }
    if (closing) return reject(503, 'unavailable', 'Server is shutting down.')
    const rejection = options.guard.check(request)
    if (rejection) return reject(rejection.status, rejection.code, rejection.message)
    if (request.url !== '/ws') return reject(404, 'not_found', 'Unknown socket endpoint.')
    const remoteAddress = request.socket.remoteAddress ?? 'unknown'
    const budget = (options.budgetKey ?? remoteAddressKey)(request)
    // An address over its failed-credential budget gets no further guesses
    // checked at all; the lockout answers before the store is consulted.
    const lockout = options.rateLimiter.blocked('auth_failure', budget)
    if (!lockout.allowed) {
      options.audit.record({
        type: 'rate_limited',
        remoteAddress,
        command: 'ws.upgrade',
        details: { policy: 'auth_failure', retryAfterMs: lockout.retryAfterMs },
      })
      return reject(
        429,
        'unavailable',
        'Too many failed credential attempts.',
        `Retry-After: ${Math.ceil(lockout.retryAfterMs / 1000)}\r\n`,
      )
    }
    const protocols =
      request.headers['sec-websocket-protocol']?.split(',').map((p) => p.trim()) ?? []
    const authProtocols = protocols.filter((p) => p.startsWith('openmanager.auth.'))
    const authorization = request.headers.authorization
    let candidate: string | undefined
    // The browser's way: the protocol, and the credential as a second
    // subprotocol when it has one. A browser without a token sends only the
    // first.
    const browserOffered =
      authorization === undefined &&
      protocols.includes('openmanager.v1') &&
      authProtocols.length <= 1 &&
      protocols.length === 1 + authProtocols.length
    if (authorization !== undefined && protocols.length === 0) {
      candidate = /^Bearer (\S+)$/.exec(authorization)?.[1]
    } else if (browserOffered && authProtocols.length === 1) {
      candidate = authProtocols[0].slice('openmanager.auth.'.length)
    }
    // Every socket carries a per-client credential, loopback included: network
    // position grants nothing. The store answers with the client's grant.
    const client = options.authenticate(candidate)
    if (!client) {
      options.rateLimiter.consume('auth_failure', budget)
      options.audit.record({
        type: 'auth.failed',
        remoteAddress,
        command: 'ws.upgrade',
        details: { presented: candidate !== undefined, origin: auditValue(request.headers.origin) },
      })
      // A browser cannot read why an upgrade was refused: every refusal
      // reaches it as a bare 1006, the same as a dropped tunnel. It would
      // redial a credential that will never work, spending the failed-
      // credential budget every device behind a tunnel shares. A credential
      // offered the browser's way is refused after the upgrade instead, with
      // the terminal close a revocation uses. Nothing is read from the socket.
      // It still counts against the socket cap; when that is full, the plain
      // refusal is all there is room for.
      if (browserOffered && wss.clients.size < SOCKET_LIMITS.maxConnections) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on('error', () => ws.terminate())
          ws.close(REVOKED_CLOSE_CODE, CLIENT_UNAUTHORIZED_CLOSE_REASON)
          setTimeout(() => ws.terminate(), SOCKET_LIMITS.closeTimeoutMs).unref()
        })
        return
      }
      return reject(401, 'auth', 'A valid client credential is required.')
    }
    if (wss.clients.size >= SOCKET_LIMITS.maxConnections) {
      return reject(503, 'unavailable', 'Connection limit reached.')
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let active = true
      let ready = false
      let liveness: ServerLivenessState | undefined
      let timer: ReturnType<typeof setTimeout>
      let termination: ReturnType<typeof setTimeout> | undefined
      const subscriptions = new Map<string, SubscriptionScope>()
      const follows = new Set<string>()
      const results = new Map<string, { command: CommandEnvelope; result: Promise<unknown> }>()
      const cleanup = () => {
        active = false
        clearTimeout(timer)
        subscriptions.clear()
        follows.clear()
        results.clear()
        if (connections.delete(ws)) options.onConnectionsChanged?.()
      }
      const close = (code: number, reason: string) => {
        if (!active) return
        cleanup()
        ws.close(code, reason)
        termination = setTimeout(() => ws.terminate(), SOCKET_LIMITS.closeTimeoutMs)
        termination.unref()
      }
      const sent = (error?: Error) => {
        if (error) {
          cleanup()
          ws.terminate()
        }
      }
      // Everything this connection sends goes through its writer: in order,
      // inside the send window, large messages in rate-sized fragments. There
      // is no size-based close (docs/sync-foundations.md §7.2).
      const writer = createConnectionWriter({
        now,
        socket: {
          sendText: (text) => {
            if (active && ws.readyState === WebSocket.OPEN) ws.send(text, sent)
          },
          sendBinary: (frame) => {
            if (active && ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true }, sent)
          },
        },
        onCatchupReady: (lagging) => catchUp(lagging),
      })
      const send = (message: unknown) => {
        if (!active || ws.readyState !== WebSocket.OPEN) return
        writer.enqueueResponse(JSON.stringify(message))
      }
      /**
       * Liveness: the connection is dead after 30 s with no inbound frame;
       * after 15 s of writing nothing the server sends a keepalive. Neither
       * looks at how fast the download goes.
       */
      const tick = () => {
        if (!active || !liveness) return
        liveness = { ...liveness, lastOutboundAtMs: writer.lastWriteAt }
        const action = advanceServerLiveness(liveness, now())
        if (action.type === 'disconnect') {
          close(action.code, action.reason)
          return
        }
        if (action.type === 'keepalive') writer.keepalive()
        timer = setTimeout(tick, action.delayMs)
      }
      /**
       * Catch up lagging scopes from the cursor each was sure to reach: one
       * answer per scope, by the replay rule, built and registered in one
       * tick so no live record falls between it and the frames that follow.
       */
      const catchUp = (lagging: LaggingScope[]) => {
        for (const { subscriptionId, cursor } of lagging) {
          if (!active) return
          const scope = subscriptions.get(subscriptionId)
          if (!scope || !options.replay) {
            writer.release(subscriptionId)
            continue
          }
          // Records committed before the read go out first; the client drops
          // the ones the catch-up covers by its cursor.
          options.drainDeliveries?.()
          let result: ReplayResult
          let text: string
          try {
            result = options.replay(scope, cursor)
            if (result.mode === 'missing') {
              subscriptions.delete(subscriptionId)
              writer.release(subscriptionId)
              continue
            }
            text = `{"type":"event","name":"subscription.catchup","payload":${answerPayloadJson(result, subscriptionId)}}`
          } catch (error) {
            options.log?.('error', 'a catch-up could not be built; closing its connection', {
              clientId: client.clientId,
              reason: String(error),
            })
            close(DELIVERY_FAILED_CLOSE_CODE, DELIVERY_FAILED_CLOSE_REASON)
            return
          }
          writer.resume(subscriptionId)
          writer.enqueueResponse(text, {
            subscriptionId,
            cursor: result.mode === 'replay' ? result.to : result.snapshot.cursor,
          })
        }
      }
      timer = setTimeout(() => close(1008, 'handshake_timeout'), SOCKET_LIMITS.handshakeTimeoutMs)
      const deliver = (frame: () => unknown, target: DeliveryTarget) => {
        if (!active || ws.readyState !== WebSocket.OPEN) return
        try {
          const text = JSON.stringify(frame())
          if (target.kind === 'scoped') {
            writer.enqueueScoped(target.subscriptionId, text, target.cursor)
          } else {
            writer.enqueueReading(target.key, text)
          }
        } catch (error) {
          options.log?.('error', 'a frame could not be sent; closing its connection', {
            clientId: client.clientId,
            reason: String(error),
          })
          close(DELIVERY_FAILED_CLOSE_CODE, DELIVERY_FAILED_CLOSE_REASON)
        }
      }
      const connection: Connection = {
        client,
        subscriptions,
        follows,
        ready: false,
        retired: retiring.has(client.clientId),
        send,
        deliver,
        close,
        writer,
      }
      connections.set(ws, connection)
      ws.on('close', () => {
        cleanup()
        clearTimeout(termination)
      })
      ws.on('error', () => {
        cleanup()
        ws.terminate()
      })
      ws.on('message', (data, isBinary) => {
        if (!active) return
        // A frame that arrives after the inbound deadline (a starved timer, a
        // machine that slept) is judged by the deadline first.
        if (liveness) {
          const action = advanceServerLiveness(liveness, now())
          if (action.type === 'disconnect') {
            close(action.code, action.reason)
            return
          }
          liveness = { ...liveness, lastInboundAtMs: now() }
        }
        let raw: unknown
        try {
          if (isBinary) throw new Error('Binary message')
          raw = JSON.parse(data.toString())
        } catch {
          send(errorResult(null, 'validation', 'Expected a JSON text message.'))
          close(1008, 'invalid_message')
          return
        }
        const parsed = ClientMessageSchema.safeParse(raw)
        if (!parsed.success) {
          const id = RequestIdSchema.safeParse(
            raw && typeof raw === 'object' && 'requestId' in raw ? raw.requestId : null,
          )
          send(
            id.success && results.has(id.data)
              ? errorResult(null, 'conflict', 'Request identity was reused for an invalid message.')
              : errorResult(id.success ? id.data : null, 'validation', 'Invalid client message.'),
          )
          close(1008, 'invalid_message')
          return
        }
        const message = parsed.data
        // Connection control: a beat only proves liveness (above); an ack
        // opens the send window. Both are handled even on a retired socket,
        // whose last replies still have to drain.
        if (message.type === 'beat') return
        if (message.type === 'ack') {
          if (!writer.ack(message.received)) close(1008, 'invalid_ack')
          return
        }
        if (connection.retired) {
          // Authorized under a grant that no longer holds; the socket closes
          // once the current replies are out and reconnects under the new one.
          if (message.type === 'command') {
            send(errorResult(message.requestId, 'auth', 'Access changed; reconnect.'))
          }
          return
        }
        // An answer goes out after everything already queued (`drainDeliveries`).
        // A replay answer also names the cursor it brings its subscription to.
        let advances: { subscriptionId: string; cursor: Cursor } | undefined
        const answer = (result: unknown) => {
          options.drainDeliveries?.()
          if (!active || ws.readyState !== WebSocket.OPEN) return
          writer.enqueueResponse(
            result instanceof PreserializedAnswer ? result.text : JSON.stringify(result),
            advances,
          )
          advances = undefined
        }
        const previous = results.get(message.requestId)
        if (previous) {
          if (isDeepStrictEqual(previous.command, message)) void previous.result.then(answer)
          else {
            send(errorResult(null, 'conflict', 'Request identity was reused for another command.'))
            close(1008, 'request_conflict')
          }
          return
        }
        if (results.size >= SOCKET_LIMITS.maxCommands) {
          send(errorResult(message.requestId, 'unavailable', 'Connection command limit reached.'))
          close(1008, 'command_limit')
          return
        }
        // Work a command asks to run once its answer is on the wire, such as
        // closing the caller's own socket after handing it a new credential.
        const afterReply: Array<() => void> = []
        const runAfterReply = () => {
          for (const task of afterReply.splice(0)) task()
        }
        const reply = (result: unknown | Promise<unknown>) => {
          const asynchronous =
            typeof result === 'object' &&
            result !== null &&
            'then' in result &&
            typeof result.then === 'function'
          const settled = Promise.resolve(result).catch(() =>
            errorResult(message.requestId, 'internal', 'Command failed.'),
          )
          results.set(message.requestId, { command: message, result: settled })
          if (asynchronous) {
            void settled.then(answer).then(runAfterReply)
          } else {
            answer(result)
            runAfterReply()
          }
        }
        if (!ready) {
          if (message.name !== 'protocol.handshake') {
            reply(errorResult(message.requestId, 'validation', 'Protocol handshake is required.'))
            close(1008, 'handshake_required')
            return
          }
          try {
            const result = negotiateProtocolHandshake(raw, options.bootstrap())
            reply(result)
            if (result.type === 'error') {
              close(1008, 'handshake_rejected')
              return
            }
          } catch {
            reply(errorResult(message.requestId, 'validation', 'Invalid protocol handshake.'))
            close(1008, 'handshake_rejected')
            return
          }
          ready = true
          connection.ready = true
          options.onConnectionsChanged?.()
          clearTimeout(timer)
          liveness = createServerLivenessState(now())
          tick()
          return
        }
        // Authorization is per operation: authenticated is not enough. Unknown
        // names are rejected before any service sees them.
        const required = requiredAccess(message.name)
        if (required === undefined) {
          reply(errorResult(message.requestId, 'validation', 'Unsupported command.'))
          return
        }
        const createsFirstTurn =
          message.name === 'session.create' &&
          message.payload !== null &&
          typeof message.payload === 'object' &&
          'firstMessage' in message.payload
        const denied = [required, ...(createsFirstTurn ? ['agent' as const] : [])].find(
          (capability) => capability !== null && !client.capabilities.includes(capability),
        )
        if (denied) {
          options.audit.record({
            type: 'capability.denied',
            clientId: client.clientId,
            command: message.name,
            details: { requiredCapability: denied },
          })
          reply(accessDenied(message.requestId, denied))
          return
        }
        // Mutating commands are budgeted per client (T14). Replays of an
        // already-answered request ID were served above and never count.
        const policy: RateLimitPolicy | undefined =
          message.name === 'turn.send' || createsFirstTurn
            ? 'prompt'
            : required !== null && required !== 'read' && !UNBUDGETED_READS.has(message.name)
              ? 'mutation'
              : undefined
        if (policy) {
          const decision = options.rateLimiter.consume(policy, client.clientId)
          if (!decision.allowed) {
            options.audit.record({
              type: 'rate_limited',
              clientId: client.clientId,
              details: { policy, command: message.name, retryAfterMs: decision.retryAfterMs },
            })
            reply(rateLimited(message.requestId, policy, decision.retryAfterMs))
            return
          }
        }
        if (message.name === 'subscription.subscribe') {
          const command = ProofCommandSchemas['subscription.subscribe'].safeParse(raw)
          if (!command.success) {
            reply(errorResult(message.requestId, 'validation', 'Invalid subscription scope.'))
            return
          }
          const scope = command.data.payload.scope
          if (scope.environmentId !== options.environmentId) {
            reply(errorResult(message.requestId, 'auth', 'Scope belongs to another environment.'))
            return
          }
          if (subscriptions.size >= SOCKET_LIMITS.maxSubscriptions) {
            reply(errorResult(message.requestId, 'unavailable', 'Subscription limit reached.'))
            return
          }
          const subscriptionId = randomUUID()
          subscriptions.set(subscriptionId, scope)
          reply({
            type: 'response',
            requestId: message.requestId,
            payload: { subscriptionId, scope },
          })
          return
        }
        if (message.name === 'subscription.replay') {
          const command = ReplayCommandSchema.safeParse(raw)
          if (!command.success) {
            reply(errorResult(message.requestId, 'validation', 'Invalid replay request.'))
            return
          }
          const { scope, cursor } = command.data.payload
          if (scope.environmentId !== options.environmentId) {
            reply(errorResult(message.requestId, 'auth', 'Scope belongs to another environment.'))
            return
          }
          if (!options.replay) {
            reply(errorResult(message.requestId, 'unavailable', 'Replay is not available.'))
            return
          }
          if (subscriptions.size >= SOCKET_LIMITS.maxSubscriptions) {
            reply(errorResult(message.requestId, 'unavailable', 'Subscription limit reached.'))
            return
          }
          let result: ReplayResult
          try {
            result = options.replay(scope, cursor)
          } catch (error) {
            reply(
              error instanceof ReplayCursorError
                ? errorResult(message.requestId, 'validation', error.message)
                : errorResult(message.requestId, 'internal', 'Replay failed.'),
            )
            return
          }
          if (result.mode === 'missing') {
            reply(errorResult(message.requestId, 'not_found', 'The scope no longer exists.'))
            return
          }
          // Registered after the read, in the same tick. Every record
          // committed from here on reaches the client live; one the read
          // already covers but the queue still held goes out before the
          // answer, and the client drops it by its cursor. A transient the
          // queue held is placed by its `after`. Nothing is lost.
          const subscriptionId = randomUUID()
          subscriptions.set(subscriptionId, scope)
          advances = {
            subscriptionId,
            cursor: result.mode === 'replay' ? result.to : result.snapshot.cursor,
          }
          // Built from the stored event JSON and the serialized snapshot: the
          // answer is exactly the size the replay rule compared (§6.1).
          reply(
            new PreserializedAnswer(
              `{"type":"response","requestId":${JSON.stringify(message.requestId)},"payload":${answerPayloadJson(result, subscriptionId)}}`,
            ),
          )
          return
        }
        if (message.name === 'subscription.unsubscribe') {
          const command = ProofCommandSchemas['subscription.unsubscribe'].safeParse(raw)
          if (!command.success) {
            reply(errorResult(message.requestId, 'validation', 'Invalid subscription ID.'))
            return
          }
          writer.release(command.data.payload.subscriptionId)
          if (!subscriptions.delete(command.data.payload.subscriptionId)) {
            reply(
              errorResult(
                message.requestId,
                'not_found',
                'Subscription does not exist on this connection.',
              ),
            )
            return
          }
          reply({ type: 'response', requestId: message.requestId, payload: null })
          return
        }
        let dispatched: unknown
        try {
          dispatched = options.dispatchCommand?.(message, {
            clientId: client.clientId,
            command: message.name,
            afterReply: (task) => afterReply.push(task),
            follow: (topic) => {
              if (active) follows.add(topic)
            },
          })
        } catch {
          // A service that throws before answering fails its command, not the
          // process every other client and agent depends on. Work it queued
          // for after the answer still runs: it may be closing sockets whose
          // credential the service already revoked.
          dispatched = errorResult(message.requestId, 'internal', 'Command failed.')
        }
        reply(dispatched ?? errorResult(message.requestId, 'validation', 'Unsupported command.'))
      })
    })
  })
  /**
   * Send a scoped item to the one subscription of its scope each connection
   * holds (the newest, if a recovery left two). `prepare` validates the item
   * once for every connection.
   */
  const deliverScoped = (
    rawScope: unknown,
    prepare: () => {
      scope: SubscriptionScope
      /** A record's own cursor: the position its subscription reaches once it is written. */
      cursor?: Cursor
      frame: (subscriptionId: string) => unknown
    },
  ) => {
    let prepared: ReturnType<typeof prepare>
    try {
      prepared = prepare()
      if (prepared.scope.environmentId !== options.environmentId) {
        throw new Error('Cannot publish an event from another environment.')
      }
    } catch (error) {
      const scope = SubscriptionScopeSchema.safeParse(rawScope)
      let closed = 0
      for (const connection of [...connections.values()]) {
        const subscribed = [...connection.subscriptions.values()].some((held) =>
          scope.success ? sameScope(held, scope.data) : true,
        )
        if (!subscribed) continue
        connection.close(DELIVERY_FAILED_CLOSE_CODE, DELIVERY_FAILED_CLOSE_REASON)
        closed += 1
      }
      options.log?.('error', 'an event could not be sent; closed the connections of its scope', {
        scope: scope.success ? JSON.stringify(scope.data) : 'unreadable',
        connectionsClosed: closed,
        reason: String(error),
      })
      return
    }
    for (const connection of connections.values()) {
      // A retired socket was authorized under a grant that no longer holds.
      if (connection.retired) continue
      let subscriptionId: string | undefined
      for (const [id, scope] of connection.subscriptions) {
        if (sameScope(scope, prepared.scope)) subscriptionId = id
      }
      if (subscriptionId !== undefined) {
        const id = subscriptionId
        connection.deliver(() => prepared.frame(id), {
          kind: 'scoped',
          subscriptionId: id,
          ...(prepared.cursor ? { cursor: prepared.cursor } : {}),
        })
      }
    }
  }

  return {
    get connectionCount() {
      return connections.size
    },
    get subscriptionCount() {
      return [...connections.values()].reduce(
        (total, connection) => total + connection.subscriptions.size,
        0,
      )
    },
    /**
     * Send one item of the delivery queue (event-delivery.ts) to every
     * connection it is for. A thread's record or transient goes only to the
     * subscriptions of its scope, once per connection even when several of
     * its subscriptions match. A reading goes to every ready connection, or
     * to those following its topic.
     *
     * Never throws: a frame one connection cannot take closes that
     * connection; an item that cannot be sent at all is a server bug, and
     * closes every connection subscribed to its scope, so each of them
     * recovers from its bookmark instead of missing it unknowingly.
     */
    deliver(item: Delivery) {
      switch (item.kind) {
        case 'record':
          deliverScoped(item.record?.cursor?.scope, () => {
            const record = DurableEventSchema.parse(item.record)
            return {
              scope: record.cursor.scope,
              cursor: record.cursor,
              frame: (subscriptionId: string) => ({
                type: 'event',
                name: 'subscription.event',
                payload: { subscriptionId, record },
              }),
            }
          })
          return
        case 'transient':
          deliverScoped(item.after?.scope, () => {
            const after = CursorSchema.parse(item.after)
            const event = TransientEventSchema.parse(item.event)
            if (!sameScope(after.scope, event.scope)) {
              throw new Error('A transient must be placed in its own scope.')
            }
            return {
              scope: after.scope,
              frame: (subscriptionId: string) => ({
                type: 'event',
                name: 'subscription.transient',
                payload: { subscriptionId, after, event },
              }),
            }
          })
          return
        case 'broadcast':
          for (const connection of connections.values()) {
            if (connection.ready && !connection.retired) {
              connection.deliver(() => item.event, { kind: 'reading', key: readingKey(item.event) })
            }
          }
          return
        case 'followers':
          for (const connection of connections.values()) {
            if (connection.ready && !connection.retired && connection.follows.has(item.topic)) {
              connection.deliver(() => item.build(connection.client), {
                kind: 'reading',
                key: `follow:${item.topic}`,
              })
            }
          }
          return
      }
    },
    /**
     * Each open connection's writer: queued, in-flight and window bytes, and
     * its lagging subscriptions (a test seam, §7.2 (e)).
     */
    flowStats(): Array<{ ws: WebSocket } & WriterStats> {
      return [...connections].map(([ws, connection]) => ({ ws, ...connection.writer.stats() }))
    },
    /** Whether any open connection follows `topic`. */
    hasFollowers(topic: string): boolean {
      for (const connection of connections.values()) {
        if (connection.ready && !connection.retired && connection.follows.has(topic)) return true
      }
      return false
    },
    /** The clients with at least one handshaken socket open. */
    connectedClientIds(): ReadonlySet<string> {
      const ids = new Set<string>()
      for (const connection of connections.values()) {
        if (connection.ready) ids.add(connection.client.clientId)
      }
      return ids
    },
    /** Cut every socket authenticated by one client, e.g. after its credential is revoked. */
    disconnectClient(
      clientId: string,
      code: number = REVOKED_CLOSE_CODE,
      reason: string = REVOKED_CLOSE_REASON,
    ): number {
      let count = 0
      for (const connection of [...connections.values()]) {
        if (connection.client.clientId !== clientId) continue
        connection.close(code, reason)
        count += 1
      }
      return count
    },
    /**
     * Stop serving a client's sockets at once, because its grant changed, and
     * close them with `code` after the replies already queued have gone out.
     */
    retireClient(clientId: string, code: number, reason: string) {
      retiring.add(clientId)
      for (const connection of connections.values()) {
        if (connection.client.clientId === clientId) connection.retired = true
      }
      setImmediate(() => {
        retiring.delete(clientId)
        for (const connection of [...connections.values()]) {
          if (connection.client.clientId === clientId && connection.retired) {
            connection.close(code, reason)
          }
        }
      })
    },
    close() {
      if (!closePromise) {
        closing = true
        for (const connection of connections.values())
          connection.close(SERVER_SHUTDOWN_CLOSE_CODE, SERVER_SHUTDOWN_CLOSE_REASON)
        closePromise = new Promise<void>((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()))
        })
      }
      return closePromise
    },
  }
}
