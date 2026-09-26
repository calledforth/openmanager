import {
  PLAN_BUILD_CAPABILITY,
  ErrorEnvelopeSchema,
  PROTOCOL_VERSION,
  SESSION_CREATE_EXPLICIT_CAPABILITY,
  ProofEventSchema,
  ProviderHealthChangedEventSchema,
  ServerMessageSchema,
  SubscriptionEventSchema,
  advanceClientHeartbeat,
  artifactPath,
  createClientHeartbeatState,
  observeServerActivity,
  parseProtocolHandshakeResult,
  parseReplayResult,
  respondToHeartbeat,
  type ClientHeartbeatState,
  type Cursor,
  type DurableEvent,
  type ErrorCode,
  type ProofEvent,
  type ProtocolHandshakeCommand,
  type ReplayCommand,
  type SubscriptionScope,
  type Thread,
  UploadResultSchema,
  WorkspaceUnavailableDetailsSchema,
} from '@openmanager/protocol'
import { z } from 'zod'
import { EnvironmentClientError, isEnvironmentClientError } from './errors'
import {
  applyActiveSession,
  applyActiveThread,
  applyComposerPreference,
  applyComposerPreferencesReset,
  applyConnection,
  applyEnvironment,
  applyEvent,
  applyInteractionResolved,
  applyProviderBootstrap,
  applyProviderCatalog,
  applyProviderHealth,
  applyProviderProbe,
  applySessionCreated,
  applySessionHistory,
  applySessionList,
  applySessionOpen,
  applySessionRemoved,
  applySessionSettled,
  applySessionAcknowledged,
  applySessionTitle,
  applySnapshot,
  applyThreadHydration,
  applyTurnSendFailed,
  applyTurnSending,
  applyTurnStarted,
  applyWorkspaceList,
  applyWorkspaceRemoved,
  selectSessionList,
} from './state'
import { createEnvironmentStore } from './store'
import type {
  ComposerPreferenceTarget,
  ConnectionFailure,
  EnvironmentClient,
  EnvironmentCommandName,
  EnvironmentCommands,
  WorkspaceComposerPreference,
} from './types'
import {
  UPLOAD_TICKET_COMMAND,
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
  /** Used for artifact reads; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
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
const REPLAY_NAME = 'subscription.replay'

const SubscribeResponseSchema = z.object({
  payload: z.object({ subscriptionId: z.string(), scope: z.any() }),
})
/** The one thing any successful replay answer is known to carry. */
const GrantedSubscriptionSchema = z.object({
  type: z.literal('response'),
  payload: z.object({ subscriptionId: z.string() }),
})

type Pending = {
  name: string
  resolve: (raw: unknown) => void
  reject: (error: EnvironmentClientError) => void
}

type Subscription = {
  scope: SubscriptionScope
  subscriptionId: string | null
  /** A `subscription.subscribe` or `subscription.replay` is on the wire and unanswered. */
  inflight: boolean
  /** Last applied durable event of the scope; what a reconnect resumes from. */
  cursor: Cursor | null
  recovery?: Promise<void>
  buffered?: DurableEvent[]
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
 * The HTTP address of a route on the environment behind `socketUrl`. The
 * socket lives at `<endpoint>/ws`, so its directory is the endpoint, whatever
 * path prefix a tunnel put in front of it.
 */
export function environmentHttpUrl(socketUrl: string, path: string): string {
  const url = new URL(path.replace(/^\/+/, ''), new URL('.', socketUrl))
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return url.href
}

/** A refused artifact transfer, as the typed error the command channel would raise. */
async function artifactTransferError(
  response: Response,
  fallback: string,
): Promise<EnvironmentClientError> {
  const body: unknown = await response.json().catch(() => null)
  const parsed = z
    .object({ error: z.object({ code: z.string(), message: z.string() }) })
    .safeParse(body)
  const code: ErrorCode =
    response.status === 401
      ? 'auth'
      : response.status === 403
        ? 'capability_missing'
        : response.status === 404 || response.status === 410
          ? 'not_found'
          : response.status === 400 || response.status === 413 || response.status === 415
            ? 'validation'
            : 'unavailable'
  return new EnvironmentClientError(code, parsed.success ? parsed.data.error.message : fallback)
}

/**
 * Real transport. One socket, one handshake, scope subscriptions that are
 * re-established on every reconnect, and a store shared with the reducers the
 * mock uses. Commands issued while connecting wait for the handshake; commands
 * issued while closed reject immediately.
 */
/** The cause the environment attached to a `workspace_unavailable` refusal.
 * It is authoritative for this failure: the cached workspace may still say
 * `available` when the folder was found unusable on open. */
function unavailableCause(error: unknown): { availability?: 'missing' | 'inaccessible' } {
  if (!isEnvironmentClientError(error) || error.code !== 'workspace_unavailable') return {}
  const details = WorkspaceUnavailableDetailsSchema.safeParse(error.details)
  return details.success ? { availability: details.data.availability } : {}
}

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
  /** The id each unacknowledged interaction answer went out under. */
  const answerIds = new Map<string, { answer: string; commandId: string }>()
  /** Bumped on every handshake and close so a stale resync stops after its awaits. */
  let connectionGeneration = 0
  const pending = new Map<string, Pending>()
  const queued: Array<() => void> = []
  const subscriptions = new Map<string, Subscription>()
  const transientIds = new Set<string>()

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
    openGeneration += 1
    for (const subscription of subscriptions.values()) {
      subscription.subscriptionId = null
      subscription.inflight = false
      subscription.buffered = undefined
      subscription.recovery = undefined
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
    // Providers and their health ride the handshake too, so the composer can
    // tell a broken provider apart before the catalog read comes back.
    const providers = bootstrap.providers
    if (providers) store.update((state) => applyProviderBootstrap(state, providers))
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

  /**
   * Fold one durable record in, at most once. Cursors belong to scopes, not
   * sockets or subscription IDs, so the scope is the stable key even while an
   * acknowledgement is in flight, and a record at or below the last applied
   * sequence of the same epoch is a repeat: a replayed tail overlapping what
   * arrived live, or a live event the environment sent twice.
   */
  const applyRecord = (record: DurableEvent) => {
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
    foldEvent(record.event)
  }

  /**
   * A preference event is the environment's own ordering of writes, so it
   * takes a ticket like a landed write: the answer to a request issued before
   * it describes an older value and must not replace it.
   */
  const foldEvent = (event: ProofEvent) => {
    if (event.name === 'composer.preferences.updated') {
      appliedPreferenceWrites.set(preferenceKey(event.payload), ++preferenceTickets)
    }
    store.update((state) => applyEvent(state, event))
  }

  const handleEvent = (raw: unknown) => {
    const live = SubscriptionEventSchema.safeParse(raw)
    if (live.success) {
      const record = live.data.payload.record
      const subscription = subscriptions.get(scopeKey(record.cursor.scope))
      if (!subscription) return
      if (subscription.buffered) {
        subscription.buffered.push(record)
        return
      }
      applyRecord(record)
      return
    }
    // Health is broadcast to every socket outside any scope: it is a current
    // reading, not history, so it has no cursor and no event ID to dedupe on.
    const health = ProviderHealthChangedEventSchema.safeParse(raw)
    if (health.success) {
      const { providerId, health: next } = health.data.payload
      store.update((state) => applyProviderHealth(state, providerId, next))
      return
    }
    const transient = ProofEventSchema.safeParse(raw)
    if (transient.success && !transientIds.has(transient.data.eventId)) {
      transientIds.add(transient.data.eventId)
      if (transientIds.size > 4096) transientIds.delete(transientIds.values().next().value!)
      foldEvent(transient.data)
    }
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

  /** Snapshot and live registration share one server boundary; reconnect uses its cursor. */
  const recover = (subscription: Subscription): Promise<void> => {
    if (subscription.recovery) return subscription.recovery
    if (subscription.subscriptionId || subscription.inflight) return Promise.resolve()
    if (
      !capabilities.has(REPLAY_NAME) ||
      (!subscription.cursor && subscription.scope.type !== 'thread')
    ) {
      subscribe(subscription.scope)
      return Promise.resolve()
    }
    const key = scopeKey(subscription.scope)
    const generation = connectionGeneration
    const command: ReplayCommand = {
      type: 'command',
      requestId: nextRequestId(),
      name: REPLAY_NAME,
      payload: { scope: subscription.scope, cursor: subscription.cursor },
    }
    subscription.buffered = []
    const recovery = new Promise<void>((resolve, reject) => {
      const fail = (error: EnvironmentClientError) => {
        subscription.inflight = false
        subscription.buffered = undefined
        if (subscriptions.get(key) === subscription && generation === connectionGeneration) {
          if (subscription.scope.type === 'thread') {
            const threadId = subscription.scope.threadId
            store.update((state) => applyThreadHydration(state, threadId, 'failed'))
          } else if (error.code === 'not_found') subscriptions.delete(key)
          else if (ready) subscribe(subscription.scope)
        }
        reject(error)
      }
      pending.set(command.requestId, {
        name: REPLAY_NAME,
        resolve: (raw) => {
          let result: ReturnType<typeof parseReplayResult>
          try {
            result = parseReplayResult(command, raw)
          } catch (error) {
            const granted = GrantedSubscriptionSchema.safeParse(raw)
            if (granted.success) sendUnsubscribe(granted.data.payload.subscriptionId)
            fail(
              new EnvironmentClientError(
                'validation',
                error instanceof Error ? error.message : 'Invalid replay result.',
              ),
            )
            return
          }
          if (result.type === 'error') {
            fail(EnvironmentClientError.fromProtocol(result.error))
            return
          }
          subscription.inflight = false
          const payload = result.payload
          if (subscriptions.get(key) !== subscription || generation !== connectionGeneration) {
            sendUnsubscribe(payload.subscriptionId)
            resolve()
            return
          }
          subscription.subscriptionId = payload.subscriptionId
          if (payload.mode === 'replay') {
            for (const record of payload.events) applyRecord(record)
            subscription.cursor = payload.to
            if (subscription.scope.type === 'thread') {
              const threadId = subscription.scope.threadId
              store.update((state) => applyThreadHydration(state, threadId, 'ready'))
            }
          } else {
            store.update((state) => applySnapshot(state, payload.snapshot))
            subscription.cursor = payload.snapshot.cursor
            // Preference events were missed along with the rest of the gap and
            // the snapshot does not carry them, so held ones read as unloaded.
            if (subscription.scope.type === 'environment' && payload.reason !== 'initial') {
              store.update(applyComposerPreferencesReset)
            }
          }
          const buffered = subscription.buffered ?? []
          subscription.buffered = undefined
          for (const record of buffered) applyRecord(record)
          resolve()
        },
        reject: fail,
      })
      subscription.inflight = true
      if (!rawSend(command)) {
        pending.delete(command.requestId)
        fail(new EnvironmentClientError('unavailable', 'Connection is not open.'))
      }
    })
    const tracked = recovery.finally(() => {
      if (subscription.recovery === tracked) subscription.recovery = undefined
    })
    subscription.recovery = tracked
    return tracked
  }

  const hydrateThread = (scope: SubscriptionScope) => {
    const key = scopeKey(scope)
    let subscription = subscriptions.get(key)
    if (!subscription) {
      subscription = { scope, subscriptionId: null, inflight: false, cursor: null }
      subscriptions.set(key, subscription)
    }
    return recover(subscription)
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
    const environment = { type: 'environment', environmentId } as const
    if (!subscriptions.has(scopeKey(environment))) subscribe(environment)
    // Every scope the previous socket held is recovered now rather than after
    // the catalog reads: a server subscription is per-socket, so until it
    // lands the open session's events are not sent at all. Recovery is
    // idempotent, so the session.open below is free to ask for the same
    // scopes again.
    for (const subscription of [...subscriptions.values()])
      void recover(subscription).catch(() => undefined)
    const reads: Promise<unknown>[] = []
    if (supports('getEnvironment')) reads.push(commands.getEnvironment().catch(() => undefined))
    if (supports('listWorkspaces')) reads.push(commands.listWorkspaces().catch(() => undefined))
    if (supports('listSessions')) reads.push(commands.listSessions().catch(() => undefined))
    if (supports('getProviderCatalog'))
      reads.push(commands.getProviderCatalog().catch(() => undefined))
    await Promise.all(reads)
    if (generation !== connectionGeneration || !ready) return
    const activeSessionId = store.getState().activeSessionId
    if (
      activeSessionId &&
      supports('openSession') &&
      (!capabilities.has(REPLAY_NAME) ||
        store.getState().sessions[activeSessionId]?.threadIds.length === 0)
    ) {
      await commands.openSession(activeSessionId).catch(() => undefined)
    } else if (activeSessionId && !capabilities.has(REPLAY_NAME)) {
      for (const scope of sessionScopes(activeSessionId)) subscribe(scope)
    }
  }

  /**
   * Composer answers carry the whole preference, and the session setters run
   * asynchronously on the environment, so answers for one workspace and
   * provider can arrive out of order. Every request takes a ticket when it is
   * issued. A write is kept unless a later-issued write already landed. A read
   * never outranks a write: it is dropped while a write for the same pair is
   * unanswered (that answer is the newer truth) or once a later-issued write
   * has landed.
   *
   * The pair is resolved when the answer arrives, not when the request leaves:
   * a session may learn its provider in between, and a session or workspace
   * removed in between must not get its preference back.
   */
  let preferenceTickets = 0
  const appliedPreferenceWrites = new Map<string, number>()
  const pendingPreferenceWrites = new Set<() => ComposerPreferenceTarget | null>()
  const preferenceKey = (target: ComposerPreferenceTarget) =>
    JSON.stringify([target.workspaceId, target.providerId])

  const composerRequest = async <N extends Extract<WireCommandName, `composer.${string}`>>(
    name: N,
    payload: unknown,
    kind: 'read' | 'write',
    resolveTarget: () => ComposerPreferenceTarget | null,
  ): Promise<WorkspaceComposerPreference> => {
    const ticket = ++preferenceTickets
    if (kind === 'write') pendingPreferenceWrites.add(resolveTarget)
    let preference: WorkspaceComposerPreference
    try {
      preference = ((await request(name, payload)) as { preference: WorkspaceComposerPreference })
        .preference
    } finally {
      pendingPreferenceWrites.delete(resolveTarget)
    }
    const target = resolveTarget()
    if (!target) return preference
    const key = preferenceKey(target)
    if ((appliedPreferenceWrites.get(key) ?? 0) > ticket) return preference
    if (kind === 'read') {
      for (const pendingTarget of pendingPreferenceWrites) {
        const other = pendingTarget()
        if (other && preferenceKey(other) === key) return preference
      }
    } else {
      appliedPreferenceWrites.set(key, ticket)
    }
    store.update((state) => applyComposerPreference(state, target, preference))
    return preference
  }

  /** An explicit pair, unless its workspace was listed when asked and is gone now. */
  const workspacePreferenceTarget = (input: ComposerPreferenceTarget) => {
    const target = { workspaceId: input.workspaceId, providerId: input.providerId }
    const wasListed = store.getState().workspaces[target.workspaceId] !== undefined
    return () =>
      wasListed && store.getState().workspaces[target.workspaceId] === undefined ? null : target
  }

  /**
   * The pair a session setter's answer belongs to. Null while the session is
   * unknown or has not reported its provider: the answer names neither, so
   * there is nowhere honest to file it.
   */
  const sessionPreferenceTarget = (sessionId: string) => (): ComposerPreferenceTarget | null => {
    const session = store.getState().sessions[sessionId]
    return session?.providerId
      ? { workspaceId: session.workspaceId, providerId: session.providerId }
      : null
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
      if (!store.getState().connection.capabilities.includes(SESSION_CREATE_EXPLICIT_CAPABILITY)) {
        throw new EnvironmentClientError(
          'capability_missing',
          'Update this environment to create sessions with an explicit provider and first message.',
        )
      }
      const payload = await request('session.create', input)
      store.update((state) => {
        const created = applySessionCreated(state, payload)
        const withProvider = {
          ...created,
          sessions: {
            ...created.sessions,
            [payload.session.sessionId]: {
              ...created.sessions[payload.session.sessionId]!,
              providerId: input.providerId,
            },
          },
        }
        return payload.firstTurn
          ? applyTurnStarted(withProvider, payload.thread, payload.firstTurn)
          : withProvider
      })
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
              // A transport or programming failure is nobody's known code.
              code: isEnvironmentClientError(error) ? error.code : 'internal',
              ...unavailableCause(error),
            },
          }
        })
        throw error
      }
      if (generation !== openGeneration) return
      store.update((state) => applyActiveSession(applySessionOpen(state, payload), sessionId))
      if (previous && previous !== sessionId) {
        for (const scope of sessionScopes(previous)) unsubscribe(scope)
      }
      if (capabilities.has(REPLAY_NAME) && environmentId) {
        subscribe({ type: 'session', environmentId, sessionId })
        await Promise.all(
          payload.threads.map((thread) =>
            hydrateThread({ type: 'thread', environmentId: environmentId!, ...thread })
              .then(() => {
                if (generation === openGeneration)
                  store.update((state) => applyThreadHydration(state, thread.threadId, 'ready'))
              })
              .catch(() => {
                if (generation === openGeneration)
                  store.update((state) => applyThreadHydration(state, thread.threadId, 'failed'))
              }),
          ),
        )
        return
      }
      if (supports('loadSessionHistory')) {
        await Promise.all(
          payload.threads.map((thread) =>
            commands.loadSessionHistory({ sessionId, threadId: thread.threadId }).catch(() => {
              if (generation !== openGeneration) return
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
      if (generation !== openGeneration) return
      for (const scope of sessionScopes(sessionId)) subscribe(scope)
    },
    async loadSessionHistory(input) {
      const generation = connectionGeneration
      const selection = openGeneration
      const payload = await request('session.history', input)
      if (generation !== connectionGeneration || selection !== openGeneration) return payload
      store.update((state) =>
        applySessionHistory(
          state,
          { threadId: input.threadId, sessionId: input.sessionId },
          payload,
          input.cursor !== undefined,
        ),
      )
      return payload
    },
    async renameSession(sessionId, title) {
      const payload = await request('session.rename', { sessionId, title })
      store.update((state) => applySessionTitle(state, sessionId, payload.session.title))
    },
    async settleSession(sessionId, settled) {
      const payload = await request('session.settle', { sessionId, settled })
      store.update((state) => applySessionSettled(state, sessionId, payload.settledAt))
    },
    async acknowledgeSession(sessionId) {
      await request('session.acknowledge', { sessionId })
      store.update((state) => applySessionAcknowledged(state, sessionId))
    },
    async deleteSession(sessionId) {
      await request('session.delete', { sessionId })
      for (const scope of sessionScopes(sessionId)) unsubscribe(scope)
      store.update((state) => applySessionRemoved(state, sessionId))
    },
    async sendTurn(input) {
      const commandId = input.commandId ?? randomId()
      const thread: Thread = { threadId: input.threadId, sessionId: input.sessionId }
      // Echoed first, so the message is on screen before the round trip. The
      // id makes every later signal about this send resolve the same row.
      const artifactIds = input.artifactIds?.length ? input.artifactIds : undefined
      store.update((state) =>
        applyTurnSending(state, thread, { commandId, text: input.text, artifactIds }),
      )
      try {
        const payload = await request('turn.send', { ...input, artifactIds, commandId })
        // An environment that predates the echoed id still confirms this row:
        // we know which send the response answers.
        store.update((state) => applyTurnStarted(state, thread, { ...payload, commandId }))
        return payload
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        store.update((state) => applyTurnSendFailed(state, thread, commandId, message))
        throw error
      }
    },
    async interruptTurn(input) {
      await request('turn.interrupt', input)
    },
    async respondToInteraction(input) {
      if (input.build && !capabilities.has(PLAN_BUILD_CAPABILITY)) {
        throw new EnvironmentClientError(
          'capability_missing',
          'This environment cannot build plans.',
        )
      }
      const thread: Thread = { threadId: input.threadId, sessionId: input.sessionId }
      const { interactionId } = input.response
      const settle = () => {
        answerIds.delete(interactionId)
        store.update((state) => applyInteractionResolved(state, thread, interactionId))
      }
      // An answer whose acknowledgement was lost may already have won. Sending
      // it again under the same id is a retry; a fresh id would be a rival.
      const answer = JSON.stringify({ response: input.response, build: input.build })
      const previous = answerIds.get(interactionId)
      const commandId =
        input.commandId ?? (previous?.answer === answer ? previous.commandId : randomId())
      answerIds.set(interactionId, { answer, commandId })
      try {
        await request('interaction.respond', { ...input, commandId })
      } catch (error) {
        // Someone else answered first. The prompt is just as gone here, even
        // if the event saying so was missed; the caller still hears it lost.
        if (error instanceof EnvironmentClientError && error.code === 'conflict') settle()
        throw error
      }
      settle()
    },
    async getProviderCatalog() {
      const payload = await request('provider.catalog.get', null)
      store.update((state) => applyProviderCatalog(state, payload.providers))
      return payload.providers
    },
    async probeProvider(input) {
      const payload = await request('provider.probe', input)
      store.update((state) => applyProviderProbe(state, payload.provider))
      return payload.provider
    },
    getComposerPreference: (input) =>
      composerRequest(
        'composer.preferences.get',
        { workspaceId: input.workspaceId, providerId: input.providerId },
        'read',
        workspacePreferenceTarget(input),
      ),
    setComposerPreference: (input) =>
      composerRequest(
        'composer.preferences.set',
        {
          workspaceId: input.workspaceId,
          providerId: input.providerId,
          preference: input.preference,
        },
        'write',
        workspacePreferenceTarget(input),
      ),
    setSessionModel: (input) =>
      composerRequest(
        'composer.model.set',
        { sessionId: input.sessionId, modelId: input.modelId },
        'write',
        sessionPreferenceTarget(input.sessionId),
      ),
    setSessionMode: (input) =>
      composerRequest(
        'composer.mode.set',
        { sessionId: input.sessionId, modeId: input.modeId },
        'write',
        sessionPreferenceTarget(input.sessionId),
      ),
    setSessionConfigOption: (input) =>
      composerRequest(
        'composer.config_option.set',
        { sessionId: input.sessionId, configId: input.configId, value: input.value },
        'write',
        sessionPreferenceTarget(input.sessionId),
      ),
  }

  return {
    commands,
    getState: store.getState,
    subscribe: store.subscribe,
    supports,
    async fetchArtifact(input, init) {
      const fetchBytes = options.fetch ?? globalThis.fetch
      let response: Response
      try {
        response = await fetchBytes(
          environmentHttpUrl(options.url, artifactPath(input.sessionId, input.artifactId)),
          {
            headers: options.credential ? { authorization: `Bearer ${options.credential}` } : {},
            signal: init?.signal,
          },
        )
      } catch (error) {
        if (init?.signal?.aborted) throw error
        throw new EnvironmentClientError('unavailable', 'The environment could not be reached.')
      }
      if (!response.ok) {
        throw await artifactTransferError(response, 'The artifact could not be read.')
      }
      return response.blob()
    },
    async uploadArtifact(input, init) {
      // The ticket is single use and bound to this credential and session;
      // the environment spends it before it reads a byte.
      const ticket = await request(UPLOAD_TICKET_COMMAND, {
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : { workspaceId: input.workspaceId }),
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.size,
      })
      const fetchBytes = options.fetch ?? globalThis.fetch
      let response: Response
      try {
        response = await fetchBytes(environmentHttpUrl(options.url, ticket.uploadPath), {
          method: 'PUT',
          headers: {
            ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
            'content-type': input.mimeType,
          },
          body: input.bytes,
          signal: init?.signal,
        })
      } catch (error) {
        if (init?.signal?.aborted) throw error
        throw new EnvironmentClientError('unavailable', 'The environment could not be reached.')
      }
      if (!response.ok) throw await artifactTransferError(response, 'The upload was refused.')
      const parsed = UploadResultSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) {
        throw new EnvironmentClientError('validation', 'Invalid upload response.', {
          issues: parsed.error.issues,
        })
      }
      return parsed.data
    },
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
