import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import {
  acceptHeartbeatPong,
  advanceServerHeartbeat,
  ClientMessageSchema,
  createServerHeartbeatState,
  DurableEventSchema,
  HEARTBEAT_CAPABILITY,
  negotiateProtocolHandshake,
  ProofCommandSchemas,
  RequestIdSchema,
  sameScope,
  SubscriptionEventSchema,
  type BootstrapResponse,
  type CommandEnvelope,
  type ErrorCode,
  type ServerHeartbeatState,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { matchesClientToken } from './credential.ts'

export const SOCKET_CAPABILITIES = [
  HEARTBEAT_CAPABILITY,
  'subscription.subscribe',
  'subscription.unsubscribe',
]
export const SOCKET_LIMITS = Object.freeze({
  handshakeTimeoutMs: 10_000,
  closeTimeoutMs: 1_000,
  maxConnections: 128,
  maxSubscriptions: 128,
  maxCommands: 1024,
  maxPayloadBytes: 65_536,
  maxBufferedBytes: 1_048_576,
})

const errorResult = (requestId: string | null, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})
const now = () => Math.floor(performance.now())

/** Transport owns only live connection state. Durable event records come from the host. */
export function attachWebSocket(
  server: Server,
  options: { token: string; allowedOrigins: readonly string[]; bootstrap: () => BootstrapResponse },
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: SOCKET_LIMITS.maxPayloadBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('openmanager.v1') ? 'openmanager.v1' : false),
  })
  type Connection = {
    subscriptions: Map<string, SubscriptionScope>
    send: (message: unknown) => void
    close: (code: number, reason: string) => void
  }
  const connections = new Map<WebSocket, Connection>()
  let closing = false
  let closePromise: Promise<void> | undefined

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy())
    const reject = (status: number, code: ErrorCode, message: string) => {
      const body = JSON.stringify(errorResult(null, code, message))
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        () => socket.destroy(),
      )
    }
    if (closing) return reject(503, 'unavailable', 'Server is shutting down.')
    if (request.url !== '/ws') return reject(404, 'not_found', 'Unknown socket endpoint.')
    const origin = request.headers.origin
    if (origin !== undefined && !options.allowedOrigins.includes(origin)) {
      return reject(403, 'auth', 'Origin is not allowed.')
    }
    const protocols =
      request.headers['sec-websocket-protocol']?.split(',').map((p) => p.trim()) ?? []
    const authProtocols = protocols.filter((p) => p.startsWith('openmanager.auth.'))
    const authorization = request.headers.authorization
    let candidate: string | undefined
    if (authorization !== undefined && protocols.length === 0) {
      candidate = /^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1]
    } else if (
      authorization === undefined &&
      protocols.length === 2 &&
      protocols.includes('openmanager.v1') &&
      authProtocols.length === 1
    ) {
      candidate = authProtocols[0].slice('openmanager.auth.'.length)
    }
    if (!matchesClientToken(candidate, options.token)) {
      return reject(401, 'auth', 'A valid client credential is required.')
    }
    if (wss.clients.size >= SOCKET_LIMITS.maxConnections) {
      return reject(503, 'unavailable', 'Connection limit reached.')
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let active = true
      let ready = false
      let heartbeat: ServerHeartbeatState | undefined
      let timer: ReturnType<typeof setTimeout>
      let termination: ReturnType<typeof setTimeout> | undefined
      const subscriptions = new Map<string, SubscriptionScope>()
      const results = new Map<string, { command: CommandEnvelope; result: unknown }>()
      const cleanup = () => {
        active = false
        clearTimeout(timer)
        subscriptions.clear()
        results.clear()
        connections.delete(ws)
      }
      const close = (code: number, reason: string) => {
        if (!active) return
        cleanup()
        ws.close(code, reason)
        termination = setTimeout(() => ws.terminate(), SOCKET_LIMITS.closeTimeoutMs)
        termination.unref()
      }
      const send = (message: unknown) => {
        if (!active || ws.readyState !== WebSocket.OPEN) return
        const encoded = JSON.stringify(message)
        if (ws.bufferedAmount + Buffer.byteLength(encoded) > SOCKET_LIMITS.maxBufferedBytes) {
          close(1008, 'slow_consumer')
          return
        }
        ws.send(encoded, (error) => {
          if (error) {
            cleanup()
            ws.terminate()
          }
        })
      }
      const tick = () => {
        if (!active || !heartbeat) return
        const next = advanceServerHeartbeat(heartbeat, now(), randomUUID())
        heartbeat = next.state
        if (next.action.type === 'disconnect') {
          close(next.action.code, next.action.reason)
        } else {
          if (next.action.type === 'send_ping') send(next.action.message)
          if (active)
            timer = setTimeout(
              tick,
              next.action.type === 'wait' ? next.action.delayMs : next.action.pongTimeoutMs,
            )
        }
      }
      timer = setTimeout(() => close(1008, 'handshake_timeout'), SOCKET_LIMITS.handshakeTimeoutMs)
      connections.set(ws, { subscriptions, send, close })
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
        // Machine-sleep/timer recovery must enforce overdue heartbeat deadlines first.
        if (heartbeat?.awaitingPong && now() >= heartbeat.awaitingPong.deadlineMs) {
          tick()
          return
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
        if (message.type === 'pong') {
          if (!ready || !heartbeat) {
            close(1008, 'handshake_required')
            return
          }
          const pong = acceptHeartbeatPong(heartbeat, message, now())
          heartbeat = pong.state
          if (pong.accepted) {
            clearTimeout(timer)
            tick()
          }
          return
        }
        const previous = results.get(message.requestId)
        if (previous) {
          if (isDeepStrictEqual(previous.command, message)) send(previous.result)
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
        const reply = (result: unknown) => {
          results.set(message.requestId, { command: message, result })
          send(result)
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
          clearTimeout(timer)
          heartbeat = createServerHeartbeatState(now())
          tick()
          return
        }
        if (message.name === 'subscription.subscribe') {
          const command = ProofCommandSchemas['subscription.subscribe'].safeParse(raw)
          if (!command.success) {
            reply(errorResult(message.requestId, 'validation', 'Invalid subscription scope.'))
            return
          }
          const scope = command.data.payload.scope
          if (scope.environmentId !== options.bootstrap().environmentId) {
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
        if (message.name === 'subscription.unsubscribe') {
          const command = ProofCommandSchemas['subscription.unsubscribe'].safeParse(raw)
          if (!command.success) {
            reply(errorResult(message.requestId, 'validation', 'Invalid subscription ID.'))
            return
          }
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
        reply(errorResult(message.requestId, 'validation', 'Unsupported command.'))
      })
    })
  })
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
    publish(recordInput: unknown) {
      const record = DurableEventSchema.parse(recordInput)
      if (record.cursor.scope.environmentId !== options.bootstrap().environmentId) {
        throw new Error('Cannot publish an event from another environment.')
      }
      for (const connection of connections.values()) {
        for (const [subscriptionId, scope] of connection.subscriptions) {
          if (sameScope(scope, record.cursor.scope)) {
            connection.send(
              SubscriptionEventSchema.parse({
                type: 'event',
                name: 'subscription.event',
                payload: { subscriptionId, record },
              }),
            )
          }
        }
      }
    },
    close() {
      if (!closePromise) {
        closing = true
        for (const connection of connections.values()) connection.close(1001, 'server_shutdown')
        closePromise = new Promise<void>((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()))
        })
      }
      return closePromise
    },
  }
}
