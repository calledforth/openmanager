import {
  ErrorEnvelopeSchema,
  PROTOCOL_VERSION,
  ProofEventSchema,
  ServerMessageSchema,
  SubscriptionEventSchema,
  advanceClientHeartbeat,
  createClientHeartbeatState,
  observeServerActivity,
  parseProtocolHandshakeResult,
  respondToHeartbeat,
  type ClientHeartbeatState,
  type Cursor,
  type ErrorCode,
  type ProtocolHandshakeCommand,
  type SubscriptionScope,
  type Thread,
} from '@openmanager/protocol'
import { z } from 'zod'
import { EnvironmentClientError } from './errors'
import {
  applyActiveSession,
  applyActiveThread,
  applyConnection,
  applyEnvironment,
  applyEvent,
  applyInteractionResolved,
  applySessionCreated,
  applySessionList,
  applySessionOpen,
  applySessionRemoved,
  applySessionTitle,
  applyThreadHydration,
  applyTurnStarted,
  applyWorkspaceList,
  applyWorkspaceRemoved,
  selectSessionList,
} from './state'
import { createEnvironmentStore } from './store'
import type {
  ConnectionFailure,
  EnvironmentClient,
  EnvironmentCommandName,
  EnvironmentCommands,
} from './types'
import { WIRE_COMMANDS, WIRE_RESPONSES, type WireCommandName, type WireResponsePayload } from './wire'

/** The subset of the WHATWG WebSocket surface the client relies on. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void
  addEventListener(type: 'error', listener: () => void): void
}

export type WebSocketConstructor = new (url: string, protocols?: string[]) => WebSocketLike

export interface ReconnectPolicy {
  initialDelayMs: number
  maxDelayMs: number
  multiplier: number
  /** Undefined retries forever while the failure is retryable. */
  maxAttempts?: number
}

export interface WebSocketEnvironmentClientOptions {
  /** `ws://` or `wss://` URL of the environment's `/ws` endpoint. */
  url: string
  /** Client token; sent as a subprotocol because browsers cannot set headers. */
  credential?: string
  /** When set, a handshake that reports a different environment is refused. */
  environmentId?: string
  WebSocket?: WebSocketConstructor
  reconnect?: Partial<ReconnectPolicy>
  now?: () => number
  requestId?: () => string
  timers?: {
    setTimeout: (fn: () => void, delayMs: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

export const DEFAULT_RECONNECT: ReconnectPolicy = {
  initialDelayMs: 500,
  maxDelayMs: 15_000,
  multiplier: 2,
}

const OPEN = 1
const HANDSHAKE_NAME = 'protocol.handshake'
const SUBSCRIBE_NAME = 'subscription.subscribe'
const UNSUBSCRIBE_NAME = 'subscription.unsubscribe'

const SubscribeResponseSchema = z.object({
  payload: z.object({ subscriptionId: z.string(), scope: z.any() }),
})

type Pending = {
  name: string
  resolve: (raw: unknown) => void
  reject: (error: EnvironmentClientError) => void
}

type Subscription = {
  scope: SubscriptionScope
  subscriptionId: string | null
  cursor: Cursor | null
}

const scopeKey = (scope: SubscriptionScope) =>
  scope.type === 'environment'
    ? `environment:${scope.environmentId}`
    : scope.type === 'session'
      ? `session:${scope.environmentId}:${scope.sessionId}`
      : `thread:${scope.environmentId}:${scope.sessionId}:${scope.threadId}`

const TERMINAL_CODES: ReadonlySet<ErrorCode> = new Set([
  'auth',
  'protocol_incompatible',
  'capability_missing',
])

const randomId = () => globalThis.crypto.randomUUID()

/**
 * Real transport. One socket, one handshake, scope subscriptions that are
 * re-established on every reconnect, and a store shared with the reducers the
 * mock uses. Commands issued while connecting wait for the handshake; commands
 * issued while closed reject immediately.
 */
export function createWebSocketEnvironmentClient(
  options: WebSocketEnvironmentClientOptions,
): EnvironmentClient {
  const Socket = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor)
  if (!Socket) throw new Error('No WebSocket implementation is available.')
  const timers = options.timers ?? {
    setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const now = options.now ?? (() => Date.now())
  const nextRequestId = options.requestId ?? randomId
  const reconnectPolicy: ReconnectPolicy = { ...DEFAULT_RECONNECT, ...options.reconnect }
  const store = createEnvironmentStore()

  let socket: WebSocketLike | null = null
  let ready = false
  let disposed = false
  let manualClose = false
  let attempts = 0
  let reconnectTimer: unknown = null
  let heartbeatTimer: unknown = null
  let heartbeat: ClientHeartbeatState | null = null
  let environmentId = options.environmentId ?? null
  let capabilities = new Set<string>()
  const pending = new Map<string, Pending>()
  const queued: Array<() => void> = []
  const subscriptions = new Map<string, Subscription>()

  const patchConnection = (patch: Parameters<typeof applyConnection>[1]) =>
    store.update((state) => applyConnection(state, patch))

  const supports = (command: EnvironmentCommandName) => capabilities.has(WIRE_COMMANDS[command])

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  const rawSend = (message: unknown) => {
    if (!socket || socket.readyState !== OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  const rejectAllPending = (error: EnvironmentClientError) => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    for (const flush of queued.splice(0)) flush()
  }

  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) timers.clearTimeout(heartbeatTimer)
    heartbeatTimer = null
    heartbeat = null
  }

  const scheduleHeartbeat = () => {
    if (!heartbeat) return
    if (heartbeatTimer !== null) timers.clearTimeout(heartbeatTimer)
    const action = advanceClientHeartbeat(heartbeat, now())
    if (action.type === 'disconnect') {
      socket?.close(action.code, action.reason)
      return
    }
    heartbeatTimer = timers.setTimeout(scheduleHeartbeat, action.delayMs)
  }

  const observeActivity = () => {
    if (!heartbeat) return
    heartbeat = observeServerActivity(heartbeat, now())
    scheduleHeartbeat()
  }

  const clearReconnect = () => {
    if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const scheduleReconnect = (failure: ConnectionFailure) => {
    clearReconnect()
    if (
      reconnectPolicy.maxAttempts !== undefined &&
      attempts >= reconnectPolicy.maxAttempts
    ) {
      patchConnection({ phase: 'closed', failure })
      return
    }
    const delay = Math.min(
      reconnectPolicy.initialDelayMs * reconnectPolicy.multiplier ** attempts,
      reconnectPolicy.maxDelayMs,
    )
    attempts += 1
    const hasConnected = store.getState().connection.hasConnected
    patchConnection({ phase: hasConnected ? 'reconnecting' : 'connecting', failure })
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null
      open()
    }, delay)
  }

  const handleClose = (code: number, reason: string) => {
    const closedSocket = socket
    socket = null
    ready = false
    stopHeartbeat()
    for (const subscription of subscriptions.values()) subscription.subscriptionId = null
    rejectAllPending(
      new EnvironmentClientError('unavailable', reason || 'Connection closed.', { code }),
    )
    if (!closedSocket) return
    if (disposed || manualClose) {
      patchConnection({ phase: 'closed', failure: null })
      return
    }
    const current = store.getState().connection
    if (current.phase === 'closed' && current.failure && TERMINAL_CODES.has(current.failure.code)) {
      return
    }
    scheduleReconnect(
      current.failure && TERMINAL_CODES.has(current.failure.code)
        ? current.failure
        : {
            code: 'unavailable',
            message: reason ? `Connection closed (${reason}).` : 'Connection closed.',
          },
    )
  }

  const failTerminally = (failure: ConnectionFailure) => {
    patchConnection({ phase: 'closed', failure })
    manualClose = false
    const current = socket
    socket = null
    ready = false
    stopHeartbeat()
    rejectAllPending(new EnvironmentClientError(failure.code, failure.message))
    current?.close(1000, 'client_rejected')
  }

  const handleHandshake = (command: ProtocolHandshakeCommand, raw: unknown) => {
    let result: ReturnType<typeof parseProtocolHandshakeResult>
    try {
      result = parseProtocolHandshakeResult(command, raw)
    } catch (error) {
      failTerminally({
        code: 'validation',
        message: error instanceof Error ? error.message : 'Invalid handshake result.',
      })
      return
    }
    if (result.type === 'error') {
      const code = result.error.code
      const failure = { code, message: result.error.message }
      if (TERMINAL_CODES.has(code)) failTerminally(failure)
      else {
        patchConnection({ failure })
        socket?.close(1000, 'handshake_failed')
      }
      return
    }
    const bootstrap = result.payload
    if (environmentId && bootstrap.environmentId !== environmentId) {
      failTerminally({
        code: 'auth',
        message: `Expected environment ${environmentId} but reached ${bootstrap.environmentId}.`,
      })
      return
    }
    environmentId = bootstrap.environmentId
    capabilities = new Set(bootstrap.capabilities)
    ready = true
    attempts = 0
    heartbeat = createClientHeartbeatState(now())
    scheduleHeartbeat()
    patchConnection({
      phase: 'connected',
      hasConnected: true,
      failure: null,
      capabilities: [...capabilities],
    })
    for (const flush of queued.splice(0)) flush()
    void resync()
  }

  const handleMessage = (data: unknown) => {
    let raw: unknown
    try {
      raw = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return
    }
    const parsed = ServerMessageSchema.safeParse(raw)
    if (!parsed.success) return
    observeActivity()
    const message = parsed.data
    if (message.type === 'ping') {
      rawSend(respondToHeartbeat(message))
      return
    }
    if (message.type === 'event') {
      handleEvent(raw)
      return
    }
    const requestId = message.requestId
    if (requestId === null) return
    const entry = pending.get(requestId)
    if (!entry) return
    pending.delete(requestId)
    if (message.type === 'error') {
      entry.reject(EnvironmentClientError.fromProtocol(message.error))
    } else {
      entry.resolve(raw)
    }
  }

  const handleEvent = (raw: unknown) => {
    const live = SubscriptionEventSchema.safeParse(raw)
    if (live.success) {
      const { record } = live.data.payload
      // Cursors belong to scopes, not sockets or subscription IDs, so the
      // scope is the stable key even when an acknowledgement is still in flight.
      const subscription = subscriptions.get(scopeKey(record.cursor.scope))
      if (subscription) {
        const cursor = subscription.cursor
        if (
          cursor &&
          cursor.epoch === record.cursor.epoch &&
          record.cursor.sequence <= cursor.sequence
        ) {
          return
        }
        subscription.cursor = record.cursor
      }
      store.update((state) => applyEvent(state, record.event))
      return
    }
    const transient = ProofEventSchema.safeParse(raw)
    if (transient.success) store.update((state) => applyEvent(state, transient.data))
  }

  const open = () => {
    if (disposed || socket) return
    manualClose = false
    const protocols = options.credential
      ? ['openmanager.v1', `openmanager.auth.${options.credential}`]
      : ['openmanager.v1']
    let next: WebSocketLike
    try {
      next = new Socket(options.url, protocols)
    } catch (error) {
      scheduleReconnect({
        code: 'unavailable',
        message: error instanceof Error ? error.message : 'Could not open the connection.',
      })
      return
    }
    socket = next
    const hasConnected = store.getState().connection.hasConnected
    patchConnection({ phase: hasConnected ? 'reconnecting' : 'connecting' })
    next.addEventListener('open', () => {
      if (socket !== next) return
      const command: ProtocolHandshakeCommand = {
        type: 'command',
        requestId: nextRequestId(),
        name: HANDSHAKE_NAME,
        payload: { protocolVersion: PROTOCOL_VERSION, requiredCapabilities: [] },
      }
      // Both outcomes go through the negotiated-result parser so a rejected
      // handshake is classified by protocol error code, not by transport.
      pending.set(command.requestId, {
        name: HANDSHAKE_NAME,
        resolve: (raw) => handleHandshake(command, raw),
        reject: (error) => {
          if (socket !== next) return
          handleHandshake(command, {
            type: 'error',
            requestId: command.requestId,
            error: { code: error.code, message: error.message, details: error.details },
          })
        },
      })
      next.send(JSON.stringify(command))
    })
    next.addEventListener('message', (event) => {
      if (socket === next) handleMessage(event.data)
    })
    next.addEventListener('close', (event) => {
      if (socket === next) handleClose(event.code, event.reason)
    })
    next.addEventListener('error', () => undefined)
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  const request = <N extends WireCommandName>(
    name: N,
    payload: unknown,
  ): Promise<WireResponsePayload<N>> =>
    new Promise((resolve, reject) => {
      const attempt = () => {
        if (disposed) {
          reject(new EnvironmentClientError('unavailable', 'Client is disposed.'))
          return
        }
        if (!ready) {
          reject(new EnvironmentClientError('unavailable', 'Not connected to the environment.'))
          return
        }
        if (!capabilities.has(name)) {
          reject(EnvironmentClientError.unsupported(name))
          return
        }
        const requestId = nextRequestId()
        pending.set(requestId, {
          name,
          resolve: (raw) => {
            const parsed = z
              .union([WIRE_RESPONSES[name], ErrorEnvelopeSchema])
              .safeParse(raw)
            if (!parsed.success) {
              reject(
                new EnvironmentClientError('validation', `Invalid ${name} response.`, {
                  issues: parsed.error.issues,
                }),
              )
              return
            }
            if ('error' in parsed.data) {
              reject(EnvironmentClientError.fromProtocol(parsed.data.error))
              return
            }
            resolve(parsed.data.payload as WireResponsePayload<N>)
          },
          reject,
        })
        if (!rawSend({ type: 'command', requestId, name, payload })) {
          pending.delete(requestId)
          reject(new EnvironmentClientError('unavailable', 'Connection is not open.'))
        }
      }
      const phase = store.getState().connection.phase
      if (!ready && (phase === 'connecting' || phase === 'reconnecting')) queued.push(attempt)
      else attempt()
    })

  /**
   * Fire-and-forget: the acknowledgement only supplies the subscription ID used
   * for cursor de-duplication. Events for an unacknowledged subscription are
   * still applied because every reducer is idempotent by resource ID.
   */
  const subscribe = (scope: SubscriptionScope) => {
    const key = scopeKey(scope)
    const existing = subscriptions.get(key)
    if (existing?.subscriptionId) return
    const subscription: Subscription = existing ?? { scope, subscriptionId: null, cursor: null }
    subscriptions.set(key, subscription)
    if (!capabilities.has(SUBSCRIBE_NAME)) return
    const requestId = nextRequestId()
    pending.set(requestId, {
      name: SUBSCRIBE_NAME,
      resolve: (raw) => {
        const parsed = SubscribeResponseSchema.safeParse(raw)
        if (parsed.success && subscriptions.get(key) === subscription) {
          subscription.subscriptionId = parsed.data.payload.subscriptionId
        }
      },
      reject: () => undefined,
    })
    if (!rawSend({ type: 'command', requestId, name: SUBSCRIBE_NAME, payload: { scope } })) {
      pending.delete(requestId)
    }
  }

  const unsubscribe = (scope: SubscriptionScope) => {
    const key = scopeKey(scope)
    const subscription = subscriptions.get(key)
    if (!subscription) return
    subscriptions.delete(key)
    if (!subscription.subscriptionId || !capabilities.has(UNSUBSCRIBE_NAME)) return
    const requestId = nextRequestId()
    pending.set(requestId, { name: UNSUBSCRIBE_NAME, resolve: () => undefined, reject: () => undefined })
    rawSend({
      type: 'command',
      requestId,
      name: UNSUBSCRIBE_NAME,
      payload: { subscriptionId: subscription.subscriptionId },
    })
  }

  const sessionScopes = (sessionId: string): SubscriptionScope[] => {
    if (!environmentId) return []
    const session = store.getState().sessions[sessionId]
    const scopes: SubscriptionScope[] = [{ type: 'session', environmentId, sessionId }]
    for (const threadId of session?.threadIds ?? []) {
      scopes.push({ type: 'thread', environmentId, sessionId, threadId })
    }
    return scopes
  }

  /** After every handshake: environment scope, catalog reads, and the active session. */
  const resync = async () => {
    if (!environmentId) return
    subscribe({ type: 'environment', environmentId })
    const reads: Promise<unknown>[] = []
    if (supports('getEnvironment')) reads.push(commands.getEnvironment().catch(() => undefined))
    if (supports('listWorkspaces')) reads.push(commands.listWorkspaces().catch(() => undefined))
    await Promise.all(reads)
    const activeSessionId = store.getState().activeSessionId
    if (activeSessionId && supports('openSession')) {
      await commands.openSession(activeSessionId).catch(() => undefined)
    } else if (activeSessionId) {
      for (const scope of sessionScopes(activeSessionId)) subscribe(scope)
    }
  }

  const commands: EnvironmentCommands = {
    async getEnvironment() {
      const payload = await request('environment.get', null)
      store.update((state) => applyEnvironment(state, payload.environment))
      return payload.environment
    },
    async listWorkspaces() {
      const payload = await request('workspace.list', null)
      store.update((state) => applyWorkspaceList(state, payload.workspaces))
      return payload.workspaces
    },
    async addWorkspace(input) {
      const payload = await request('workspace.add', input)
      store.update((state) => applyWorkspaceList(state, [payload.workspace]))
      return payload.workspace
    },
    async removeWorkspace(workspaceId) {
      await request('workspace.remove', { workspaceId })
      store.update((state) => applyWorkspaceRemoved(state, workspaceId))
    },
    async listSessions(workspaceId) {
      const payload = await request('session.list', { workspaceId })
      store.update((state) => applySessionList(state, payload.sessions))
      return selectSessionList(store.getState(), workspaceId)
    },
    async createSession(input) {
      const payload = await request('session.create', input)
      store.update((state) => applySessionCreated(state, payload))
      return payload
    },
    async openSession(sessionId) {
      const previous = store.getState().activeSessionId
      store.update((state) => {
        let next = state
        for (const threadId of state.sessions[sessionId]?.threadIds ?? []) {
          next = applyThreadHydration(next, threadId, 'loading')
        }
        return next
      })
      let payload: WireResponsePayload<'session.open'>
      try {
        payload = await request('session.open', { sessionId })
      } catch (error) {
        store.update((state) => {
          let next = state
          for (const threadId of state.sessions[sessionId]?.threadIds ?? []) {
            next = applyThreadHydration(next, threadId, 'failed')
          }
          return next
        })
        throw error
      }
      store.update((state) => applyActiveSession(applySessionOpen(state, payload), sessionId))
      if (previous && previous !== sessionId) {
        for (const scope of sessionScopes(previous)) unsubscribe(scope)
      }
      for (const scope of sessionScopes(sessionId)) subscribe(scope)
    },
    async renameSession(sessionId, title) {
      const payload = await request('session.rename', { sessionId, title })
      store.update((state) => applySessionTitle(state, sessionId, payload.session.title))
    },
    async deleteSession(sessionId) {
      await request('session.delete', { sessionId })
      for (const scope of sessionScopes(sessionId)) unsubscribe(scope)
      store.update((state) => applySessionRemoved(state, sessionId))
    },
    async sendTurn(input) {
      const payload = await request('turn.send', input)
      const thread: Thread = { threadId: input.threadId, sessionId: input.sessionId }
      store.update((state) => applyTurnStarted(state, thread, payload))
      return payload
    },
    async interruptTurn(input) {
      await request('turn.interrupt', input)
    },
    async respondToInteraction(input) {
      await request('interaction.respond', input)
      const thread: Thread = { threadId: input.threadId, sessionId: input.sessionId }
      store.update((state) =>
        applyInteractionResolved(state, thread, input.response.interactionId),
      )
    },
  }

  return {
    commands,
    getState: store.getState,
    subscribe: store.subscribe,
    supports,
    setActiveSession: (sessionId) => store.update((state) => applyActiveSession(state, sessionId)),
    setActiveThread: (threadId) => store.update((state) => applyActiveThread(state, threadId)),
    connect() {
      if (disposed) return
      clearReconnect()
      attempts = 0
      const current = store.getState().connection
      if (current.failure && TERMINAL_CODES.has(current.failure.code)) {
        patchConnection({ failure: null })
      }
      open()
    },
    disconnect() {
      clearReconnect()
      manualClose = true
      const current = socket
      if (!current) {
        patchConnection({ phase: 'closed', failure: null })
        return
      }
      current.close(1000, 'client_disconnect')
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearReconnect()
      stopHeartbeat()
      const current = socket
      socket = null
      ready = false
      rejectAllPending(new EnvironmentClientError('unavailable', 'Client is disposed.'))
      current?.close(1000, 'client_disposed')
      patchConnection({ phase: 'closed' })
    },
  }
}
