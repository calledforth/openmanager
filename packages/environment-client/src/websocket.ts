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
  applySessionHistory,
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
import {
  WIRE_COMMANDS,
  WIRE_RESPONSES,
  type WireCommandName,
  type WireResponsePayload,
} from './wire'

/** The subset of the WHATWG WebSocket surface the client relies on. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: () => void): void
}

export type WebSocketConstructor = new (url: string, protocols?: string[]) => WebSocketLike

export interface ReconnectPolicy {
  initialDelayMs: number
  maxDelayMs: number
  multiplier: number
  /** Undefined retries forever while the failure is retryable. */
  maxAttempts?: number
  /**
   * Fraction of each backoff window that is randomized, 0 to 1. `1` is full
   * jitter (`random() * window`), `0` disables jitter. Optional: an omitted
   * value keeps the default, so older policies stay valid.
   */
  jitter?: number
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
  /** Jitter source in `[0, 1)`. Injectable so reconnect tests are deterministic. */
  random?: () => number
  timers?: {
    setTimeout: (fn: () => void, delayMs: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

/**
 * Full jitter over an exponential window: attempt N waits a random delay in
 * `[0, min(500ms * 2^N, 15s))`, forever, until the failure is terminal. The
 * randomization is what keeps every client of a restarted environment from
 * re-dialing in the same millisecond. See `docs/connection-retry.md`.
 */
export const DEFAULT_RECONNECT: ReconnectPolicy = {
  initialDelayMs: 500,
  maxDelayMs: 15_000,
  multiplier: 2,
  jitter: 1,
}

/**
 * `window = min(initialDelayMs * multiplier ** attempt, maxDelayMs)`, then
 * `delay = window * (1 - jitter) + random() * window * jitter`. The delay never
 * exceeds the window, so `maxDelayMs` stays a real ceiling.
 */
export function reconnectDelayMs(
  policy: ReconnectPolicy,
  attempt: number,
  random: () => number,
): number {
  const window = Math.min(policy.initialDelayMs * policy.multiplier ** attempt, policy.maxDelayMs)
  const jitter = Math.min(Math.max(policy.jitter ?? 0, 0), 1)
  if (jitter === 0) return window
  const roll = Math.min(Math.max(random(), 0), 1)
  return Math.round(window * (1 - jitter) + roll * window * jitter)
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
  /** A `subscription.subscribe` is on the wire and unacknowledged. */
  inflight: boolean
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
  const reconnectPolicy: ReconnectPolicy = {
    ...DEFAULT_RECONNECT,
    ...options.reconnect,
    jitter: options.reconnect?.jitter ?? DEFAULT_RECONNECT.jitter,
  }
  const random = options.random ?? Math.random
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
  /** Bumped on every handshake and close so a stale resync stops after its awaits. */
  let connectionGeneration = 0
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
    if (reconnectPolicy.maxAttempts !== undefined && attempts >= reconnectPolicy.maxAttempts) {
      // Out of attempts: the shell reads `retriesExhausted` as "offline, needs
      // a manual retry" and only connect() starts the schedule again.
      patchConnection({ phase: 'closed', failure, attempt: attempts, retriesExhausted: true })
      return
    }
    const delay = reconnectDelayMs(reconnectPolicy, attempts, random)
    attempts += 1
    const hasConnected = store.getState().connection.hasConnected
    patchConnection({
      phase: hasConnected ? 'reconnecting' : 'connecting',
      failure,
      attempt: attempts,
      retriesExhausted: false,
    })
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
    connectionGeneration += 1
    for (const subscription of subscriptions.values()) {
      subscription.subscriptionId = null
      subscription.inflight = false
    }
    rejectAllPending(
      new EnvironmentClientError('unavailable', reason || 'Connection closed.', { code }),
    )
    if (!closedSocket) return
    if (disposed || manualClose) {
      // A deliberate close is not a failed retry, so it must not read as offline.
      patchConnection({ phase: 'closed', failure: null, attempt: 0, retriesExhausted: false })
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
    patchConnection({ phase: 'closed', failure, retriesExhausted: true })
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
    // The handshake already names the environment, so views can label it
    // without an `environment.get` round trip (or a server that lacks one).
    const label = typeof bootstrap.label === 'string' ? bootstrap.label.trim() : ''
    if (label) {
      const environment = { environmentId: bootstrap.environmentId, name: label }
      store.update((state) => applyEnvironment(state, environment))
    }
    ready = true
    attempts = 0
    connectionGeneration += 1
    heartbeat = createClientHeartbeatState(now())
    scheduleHeartbeat()
    patchConnection({
      phase: 'connected',
      hasConnected: true,
      failure: null,
      capabilities: [...capabilities],
      attempt: 0,
      retriesExhausted: false,
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
            const parsed = z.union([WIRE_RESPONSES[name], ErrorEnvelopeSchema]).safeParse(raw)
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

  const sendUnsubscribe = (subscriptionId: string) => {
    if (!capabilities.has(UNSUBSCRIBE_NAME)) return
    const requestId = nextRequestId()
    pending.set(requestId, {
      name: UNSUBSCRIBE_NAME,
      resolve: () => undefined,
      reject: () => undefined,
    })
    rawSend({
      type: 'command',
      requestId,
      name: UNSUBSCRIBE_NAME,
      payload: { subscriptionId },
    })
  }

  /**
   * Fire-and-forget: the acknowledgement only supplies the subscription ID used
   * to unsubscribe later. Cursor de-duplication is keyed by scope, so events
   * that arrive before the acknowledgement are still de-duplicated and applied.
   * If the scope was dropped before the acknowledgement arrived, the server
   * subscription is released as soon as its ID is known.
   */
  const subscribe = (scope: SubscriptionScope) => {
    const key = scopeKey(scope)
    const existing = subscriptions.get(key)
    if (existing?.subscriptionId || existing?.inflight) return
    const subscription: Subscription = existing ?? {
      scope,
      subscriptionId: null,
      inflight: false,
      cursor: null,
    }
    subscriptions.set(key, subscription)
    if (!capabilities.has(SUBSCRIBE_NAME)) return
    const requestId = nextRequestId()
    pending.set(requestId, {
      name: SUBSCRIBE_NAME,
      resolve: (raw) => {
        subscription.inflight = false
        const parsed = SubscribeResponseSchema.safeParse(raw)
        if (!parsed.success) return
        const subscriptionId = parsed.data.payload.subscriptionId
        if (subscriptions.get(key) === subscription && !subscription.subscriptionId) {
          subscription.subscriptionId = subscriptionId
        } else {
          sendUnsubscribe(subscriptionId)
        }
      },
      reject: () => {
        subscription.inflight = false
      },
    })
    if (rawSend({ type: 'command', requestId, name: SUBSCRIBE_NAME, payload: { scope } })) {
      subscription.inflight = true
    } else {
      pending.delete(requestId)
    }
  }

  const unsubscribe = (scope: SubscriptionScope) => {
    const key = scopeKey(scope)
    const subscription = subscriptions.get(key)
    if (!subscription) return
    subscriptions.delete(key)
    if (subscription.subscriptionId) sendUnsubscribe(subscription.subscriptionId)
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

  /**
   * After every handshake: environment scope, catalog reads, and the active
   * session. If the connection drops or re-handshakes while the catalog reads
   * are in flight, this run stops so it cannot queue a second `session.open`
   * behind the resync the new handshake starts.
   */
  const resync = async () => {
    if (!environmentId) return
    const generation = connectionGeneration
    subscribe({ type: 'environment', environmentId })
    // Every scope the previous socket held is re-sent now rather than after the
    // catalog reads: a server subscription is per-socket, so until it lands the
    // open session's events are not sent at all. `subscribe` is idempotent, so
    // the session.open below is free to ask for the same scopes again.
    for (const subscription of [...subscriptions.values()]) subscribe(subscription.scope)
    const reads: Promise<unknown>[] = []
    if (supports('getEnvironment')) reads.push(commands.getEnvironment().catch(() => undefined))
    if (supports('listWorkspaces')) reads.push(commands.listWorkspaces().catch(() => undefined))
    if (supports('listSessions')) reads.push(commands.listSessions().catch(() => undefined))
    await Promise.all(reads)
    if (generation !== connectionGeneration || !ready) return
    const activeSessionId = store.getState().activeSessionId
    if (activeSessionId && supports('openSession')) {
      await commands.openSession(activeSessionId).catch(() => undefined)
    } else if (activeSessionId) {
      for (const scope of sessionScopes(activeSessionId)) subscribe(scope)
    }
  }

  let openGeneration = 0
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
      for (const session of selectSessionList(store.getState(), workspaceId)) {
        for (const scope of sessionScopes(session.sessionId)) unsubscribe(scope)
      }
      store.update((state) => applyWorkspaceRemoved(state, workspaceId))
    },
    async resolveWorkspaceIcon(workspaceId) {
      const payload = await request('workspace.icon', { workspaceId })
      return payload.iconDataUrl
    },
    async listSessions(input = {}) {
      const query = typeof input === 'string' ? { workspaceId: input } : input
      const payload = await request('session.list', query)
      store.update((state) => applySessionList(state, payload.sessions))
      const listed = store.getState().sessions
      return {
        sessions: payload.sessions
          .map((session) => listed[session.sessionId])
          .filter(
            (session): session is NonNullable<(typeof listed)[string]> => session !== undefined,
          ),
        nextCursor: payload.nextCursor,
      }
    },
    async createSession(input) {
      const payload = await request('session.create', input)
      store.update((state) => applySessionCreated(state, payload))
      return payload
    },
    async openSession(sessionId) {
      const generation = ++openGeneration
      const previous = store.getState().activeSessionId
      store.update((state) => {
        let next = state
        for (const threadId of state.sessions[sessionId]?.threadIds ?? []) {
          next = applyThreadHydration(next, threadId, 'loading')
        }
        return {
          ...next,
          sessionOpenFailure:
            state.sessionOpenFailure?.sessionId === sessionId ? state.sessionOpenFailure : null,
        }
      })
      let payload: WireResponsePayload<'session.open'>
      try {
        payload = await request('session.open', { sessionId })
      } catch (error) {
        if (generation !== openGeneration) throw error
        store.update((state) => {
          let next = state
          for (const threadId of state.sessions[sessionId]?.threadIds ?? []) {
            next = applyThreadHydration(next, threadId, 'failed')
          }
          return {
            ...applyActiveSession(next, sessionId),
            sessionOpenFailure: {
              sessionId,
              message: error instanceof Error ? error.message : 'Could not open this session.',
            },
          }
        })
        throw error
      }
      if (generation !== openGeneration) return
      store.update((state) => applyActiveSession(applySessionOpen(state, payload), sessionId))
      if (supports('loadSessionHistory')) {
        await Promise.all(
          payload.threads.map((thread) =>
            commands.loadSessionHistory({ sessionId, threadId: thread.threadId }).catch(() => {
              store.update((state) => applyThreadHydration(state, thread.threadId, 'failed'))
            }),
          ),
        )
      } else {
        store.update((state) => {
          let next = state
          for (const thread of payload.threads) {
            next = applyThreadHydration(next, thread.threadId, 'ready')
          }
          return next
        })
      }
      if (previous && previous !== sessionId) {
        for (const scope of sessionScopes(previous)) unsubscribe(scope)
      }
      for (const scope of sessionScopes(sessionId)) subscribe(scope)
    },
    async loadSessionHistory(input) {
      const payload = await request('session.history', input)
      store.update((state) =>
        applySessionHistory(
          state,
          { threadId: input.threadId, sessionId: input.sessionId },
          payload,
        ),
      )
      return payload
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
      store.update((state) => applyInteractionResolved(state, thread, input.response.interactionId))
    },
  }

  return {
    commands,
    getState: store.getState,
    subscribe: store.subscribe,
    supports,
    setActiveSession: (sessionId) => {
      openGeneration += 1
      const previous = store.getState().activeSessionId
      // Subscriptions outlive the store's active session, so a session left
      // behind here would be re-subscribed by the next reconnect resync and
      // keep mutating the store. `openSession` releases the previous session
      // itself, and a repeated ID is left alone so its scopes stay live.
      if (previous && previous !== sessionId) {
        for (const scope of sessionScopes(previous)) unsubscribe(scope)
      }
      store.update((state) => applyActiveSession(state, sessionId))
    },
    setActiveThread: (threadId) => store.update((state) => applyActiveThread(state, threadId)),
    connect() {
      if (disposed) return
      clearReconnect()
      attempts = 0
      const current = store.getState().connection
      if (current.failure && TERMINAL_CODES.has(current.failure.code)) {
        patchConnection({ failure: null })
      }
      // Any explicit connect() is a fresh start, including one the shell makes
      // on behalf of the user after retries were exhausted.
      patchConnection({ attempt: 0, retriesExhausted: false })
      // A socket that disconnect() is still closing keeps open() from creating
      // a new one; clearing the flag lets its close event schedule a reconnect.
      manualClose = false
      open()
    },
    disconnect() {
      clearReconnect()
      manualClose = true
      const current = socket
      if (!current) {
        patchConnection({ phase: 'closed', failure: null, retriesExhausted: false })
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
