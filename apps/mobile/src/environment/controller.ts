import { PROTOCOL_VERSION } from '@openmanager/protocol'
import {
  createEnvironmentStore,
  createWebSocketEnvironmentClient,
  type ConnectionState,
  type EnvironmentClient,
  type EnvironmentStore,
  type WebSocketConstructor,
  type WebSocketEnvironmentClientOptions,
} from '@openmanager/environment-client'
import {
  EMPTY_REGISTRY,
  environmentSocketUrl,
  isLoopbackEnvironmentEndpoint,
  fetchBootstrap,
  findStoredEnvironment,
  noLoopbackGate,
  parseAppOrigin,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  routeHealthFromBootstrap,
  routeHealthFromConnection,
  searchRoutes,
  selectStoredEnvironment,
  selectedStoredEnvironment,
  setStoredRouteHealth,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
  type BootstrapOutcome,
  type EnvironmentRegistry,
  type EnvironmentRoute,
  type RouteFailure,
  type RouteHealthReport,
  type RouteSearchResult,
  type StoredEnvironment,
} from '@openmanager/environment-client/connection'
import type { CredentialRefusal } from '@openmanager/environment-client'
import {
  confirmCredentialRejected,
  credentialRefusalOf,
  forgetRejectedCredential,
} from '../storage/credential-rejection'
import type { PhoneStorage } from '../storage/phone-storage'
import { routeOrigin, withSocketOrigin, type NativeWebSocketConstructor } from './app-origin'
import { phoneSearchOrder } from './route-order'

/**
 * Whether the app is on screen. React Native's `inactive` (iOS's app
 * switcher, a call banner, Control Center) is still `active` here: the app
 * keeps running and comes straight back, so its socket is kept.
 */
export type AppActivity = 'active' | 'background'

export interface AppActivitySource {
  current(): AppActivity
  subscribe(listener: (activity: AppActivity) => void): () => void
}

/**
 * Whether the device has a network at all. Not whether the internet is
 * reachable: a LAN with no internet still reaches an environment on it.
 * Unknown (before the first reading) counts as online.
 */
export type PhoneNetwork = { online: boolean }

export interface NetworkSource {
  current(): PhoneNetwork
  subscribe(listener: (network: PhoneNetwork) => void): () => void
}

/**
 * Where the connection stands. The phone's own, not the web's
 * `ConnectionUiState`: there is no browser here to block a loopback address
 * or hide a gateway's answer, and the words a person reads are the
 * connection screens' to choose, from this state.
 *
 * - `starting`: reading what the phone saved.
 * - `no_environment`: nothing saved, or nothing selected.
 * - `searching`: asking the environment's saved routes, local network first.
 * - `connecting`: a route answered as this environment, in this protocol; the
 *   socket is opening and shaking hands.
 * - `connected`: the handshake succeeded.
 * - `waiting`: no route answered, or the socket failed; the next search
 *   starts on its own at `retryAt`.
 * - `held`: the app is in the background. No socket, no timers, no probes.
 * - `offline`: the device has no network. Nothing is asked until it returns.
 * - `unauthorized`: the environment refused this device's token. Every route
 *   carries the same token, so nothing is retried until a person acts.
 * - `incompatible_protocol`: the environment speaks another protocol version.
 *   Also waits for a person.
 */
export type PhoneConnectionStatus =
  | 'starting'
  | 'no_environment'
  | 'searching'
  | 'connecting'
  | 'connected'
  | 'waiting'
  | 'held'
  | 'offline'
  | 'unauthorized'
  | 'incompatible_protocol'

/** A saved environment as views see it: everything but the token. */
export type PhoneEnvironment = {
  environmentId: string
  label: string
  routes: readonly EnvironmentRoute[]
  /**
   * The phone holds a token for it. `false` once the environment refused it
   * for certain (`credential-rejection.ts`), or when SecureStore could not
   * read it: the environment needs pairing again.
   */
  paired: boolean
  /**
   * The origin of the web app it was paired from: what its socket sends as
   * `Origin`. `null` for an environment saved without one.
   */
  appOrigin: string | null
}

/** What the controller needs of the phone's storage (`src/storage`). */
export type ConnectionStorage = Pick<PhoneStorage, 'registry' | 'hydrate' | 'flush'>

/**
 * The `Origin` the socket sends, and where it came from.
 *
 * - `app`: the environment's app origin, from its pairing link. What the
 *   environment's `--allowed-origin` lists, so the upgrade is accepted.
 * - `route`: no app origin is saved, so React Native's own default goes out:
 *   the route's origin. The environment refuses it unless it was told to
 *   allow that origin too; pairing again records the app origin.
 */
export type SocketOrigin = { origin: string | null; from: 'app' | 'route' }

export type PhoneConnectionState = {
  status: PhoneConnectionStatus
  environments: readonly PhoneEnvironment[]
  selectedId: string | null
  /** The route the socket uses, or last used, for the selected environment. */
  endpoint: string | null
  /** What that route answered at `GET /bootstrap`. */
  bootstrap: BootstrapOutcome
  /** Why no saved route reaches the environment, while none does. */
  routeFailure: RouteFailure | null
  /** The socket, as the environment client reports it. */
  connection: ConnectionState | null
  /**
   * The protocol version this client speaks, and the one the environment
   * answered with. They are equal once a route has answered `ready`.
   */
  protocol: { client: number; environment: number | null }
  activity: AppActivity
  network: PhoneNetwork
  /** Consecutive failed searches and sockets since the last reset. */
  attempt: number
  /** When the next search starts on its own (ms since the epoch), while `waiting`. */
  retryAt: number | null
  /** The `Origin` the socket last dialled with; `null` before the first dial. */
  socketOrigin: SocketOrigin | null
  /**
   * The client views read and send through, once the environment has accepted
   * its socket. It stays through a background hold, a network gap and a
   * change of route, so views keep what they show; it goes when the token is
   * refused, the protocol does not match, or the environment changes.
   */
  client: EnvironmentClient | null
}

export type SaveEnvironmentInput = {
  environmentId: string
  endpoint: string
  label?: string
  credential: string
  /**
   * The origin of the pairing link (`appOriginFromPairingLink`). Omitted
   * keeps the one already saved.
   */
  appOrigin?: string | null
}

export interface PhoneConnectionController {
  getState(): PhoneConnectionState
  subscribe(listener: () => void): () => void
  /** Read the saved registry and connect to the selected environment. */
  start(): Promise<void>
  /** Make a saved environment the one to connect to. */
  selectEnvironment(environmentId: string): void
  /**
   * Save an environment this phone now holds a token for (a pairing answered)
   * and connect to it. The endpoint becomes its first route.
   */
  saveEnvironment(input: SaveEnvironmentInput): void
  /** Forget an environment, its routes and its token. */
  removeEnvironment(environmentId: string): void
  /** A person asked to try again: clears a refusal and searches at once. */
  retry(): void
  /** Resolves once every registry write handed in so far has finished. */
  flush(): Promise<void>
  dispose(): void
}

export type PhoneConnectionOptions = {
  /**
   * The phone's storage: `hydrate()` before the first read, then the shared
   * registry functions over `registry`, whole registry in, credentials
   * included (the adapter moves them to SecureStore itself).
   */
  storage: ConnectionStorage
  activity: AppActivitySource
  network: NetworkSource
  /**
   * The phone's own `WebSocket`, `fetch` and request ids. `WebSocket` is
   * React Native's constructor; each socket is dialled through
   * `withSocketOrigin` with the environment's app origin.
   */
  transport?: Pick<WebSocketEnvironmentClientOptions, 'fetch' | 'requestId'> & {
    WebSocket?: NativeWebSocketConstructor
  }
  /** Where a missing app origin is reported, once per environment. `console.warn` by default. */
  warn?: (message: string) => void
  /** Replaced in tests. */
  createClient?: (options: WebSocketEnvironmentClientOptions) => EnvironmentClient
  /**
   * How one route is asked; `fetchBootstrap` with no loopback gate by
   * default. `signal` aborts when the search is cancelled.
   */
  probe?: (endpoint: string, signal: AbortSignal) => Promise<BootstrapOutcome>
  timers?: {
    setTimeout: (fn: () => void, delayMs: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  now?: () => number
  /** Delay before each automatic retry, the last one repeated. */
  retryDelaysMs?: readonly number[]
  /** A socket that stayed up this long resets the retry delays when it drops. */
  stableAfterMs?: number
  /** How long one route may take to answer `GET /bootstrap`. */
  probeTimeoutMs?: number
  /** How long a route whose socket just failed is asked last. */
  socketFailureCooldownMs?: number
}

export const PHONE_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000, 30000]
export const PHONE_STABLE_AFTER_MS = 10_000
/**
 * How long a route whose socket failed right after its bootstrap answered is
 * asked after every other route, so a stale LAN address that still answers
 * `GET /bootstrap` cannot keep the phone off a tunnel that works.
 */
export const PHONE_SOCKET_FAILURE_COOLDOWN_MS = 60_000
/** How long one route may take to answer `GET /bootstrap`, as in the shared search. */
const PROBE_TIMEOUT_MS = 6000

/** `signal`, also aborted after `ms`. React Native has no `AbortSignal.any`. */
function withDeadline(signal: AbortSignal, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms)
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, deadline])
  const joined = new AbortController()
  const abort = () => joined.abort()
  if (signal.aborted || deadline.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  deadline.addEventListener('abort', abort, { once: true })
  return joined.signal
}

/** What a probe of a cancelled search answers; never read, as the search is stale. */
const CANCELLED: BootstrapOutcome = {
  status: 'unreachable',
  message: 'The search was cancelled.',
  cause: 'network',
}

const IDLE: BootstrapOutcome = { status: 'idle' }

type Transport = {
  environmentId: string
  endpoint: string
  credential: string
  /** The app origin the socket was dialled with, `null` for the route's own. */
  appOrigin: string | null
  client: EnvironmentClient
  /** The connection object last read, so only a change is acted on. */
  seen: ConnectionState | undefined
  /** When this socket's handshake last succeeded, while it is up. */
  connectedAt: number | null
  /**
   * The controller closed the socket (hold, offline) and its close has not
   * landed yet. Until it does the client still reads `connected`, and a
   * `connect()` would be ignored, so the socket counts as neither.
   */
  closing: boolean
  /** Open again as soon as that close lands. */
  reopen: boolean
  unsubscribe: () => void
}

type Latch = {
  environmentId: string
  status: 'unauthorized' | 'incompatible_protocol'
  /**
   * For a socket's protocol refusal: the route whose bootstrap is asked for
   * the version the environment speaks, until it has answered.
   */
  readVersionFrom?: string
  /**
   * For a refused token: what is needed to decide whether to forget it,
   * until that has been decided (`credential-rejection.ts`).
   */
  confirmRejection?: { endpoint: string; rejected: string; refusal: CredentialRefusal }
}

type Wake = 'start' | 'select' | 'retry' | 'foreground' | 'online' | 'activity' | 'timer' | 'socket'

function view(registry: EnvironmentRegistry): PhoneEnvironment[] {
  return registry.environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    routes: environment.routes,
    paired: environment.credential !== '',
    appOrigin: environment.appOrigin ?? null,
  }))
}

/**
 * The phone's connection controller: one per app. It picks the selected
 * environment from the saved registry, searches its routes local network
 * first with the shared `searchRoutes`, opens one environment client on the
 * route that answered, and follows the phone's lifecycle: it holds (closes the
 * socket and stops every timer) while the app is in the background or the
 * device is offline, and searches again the moment the app is back on screen
 * or the network returns.
 *
 * The controller is the only thing that retries. The environment client is
 * created with `maxAttempts: 0`, so a dropped socket comes back here instead
 * of redialling the same route on its own: the next attempt may need another
 * route (the phone left the LAN), and in the background it must not happen at
 * all.
 *
 * What it records is this device's own: which routes answered, the label an
 * environment gave, which environment is selected. Everything the environment
 * owns arrives through the client's snapshots and events and is never
 * written, merged or guessed at here.
 */
export function createPhoneConnectionController(
  options: PhoneConnectionOptions,
): PhoneConnectionController {
  const createClient = options.createClient ?? createWebSocketEnvironmentClient
  const timers = options.timers ?? {
    setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const now = options.now ?? (() => Date.now())
  const retryDelays = options.retryDelaysMs ?? PHONE_RETRY_DELAYS_MS
  const stableAfterMs = options.stableAfterMs ?? PHONE_STABLE_AFTER_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  const socketFailureCooldownMs =
    options.socketFailureCooldownMs ?? PHONE_SOCKET_FAILURE_COOLDOWN_MS
  /** Routes whose socket failed soon after their bootstrap answered, and when. */
  const socketFailures = new Map<string, number>()
  /**
   * The phone's search order with each route whose socket failed within the
   * cooldown moved behind the others. Moved, not dropped: when nothing else
   * answers it is still asked.
   */
  const demoteFailedSockets = (environment: StoredEnvironment): StoredEnvironment => {
    const ordered = phoneSearchOrder(environment)
    const failed = (endpoint: string) => {
      const at = socketFailures.get(endpoint)
      return at !== undefined && now() - at < socketFailureCooldownMs
    }
    if (!ordered.routes.some((route) => failed(route.endpoint))) return ordered
    return {
      ...ordered,
      routes: [
        ...ordered.routes.filter((route) => !failed(route.endpoint)),
        ...ordered.routes.filter((route) => failed(route.endpoint)),
      ],
    }
  }
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const probeRoute =
    options.probe ??
    ((endpoint: string, signal: AbortSignal) =>
      // The deadline lives in the signal itself, not in `timeoutMs`: a probe
      // that timed out then reads as aborted, so `fetchBootstrap` does not
      // follow it with its own five-second check of what answered.
      fetchBootstrap(endpoint, {
        signal: withDeadline(signal, probeTimeoutMs),
        loopbackAccessDenied: noLoopbackGate,
      }))
  /**
   * The shared search, every probe tied to `signal`. Once the search is
   * cancelled (hold, offline, another search, dispose) a probe in flight is
   * aborted, and the routes `searchRoutes` would ask after it are answered
   * at once without a request.
   */
  const search = (
    environment: StoredEnvironment,
    signal: AbortSignal,
    first?: string,
  ): Promise<RouteSearchResult> =>
    searchRoutes(demoteFailedSockets(environment), {
      first,
      probe: (endpoint) =>
        signal.aborted ? Promise.resolve(CANCELLED) : probeRoute(endpoint, signal),
    })

  let registry: EnvironmentRegistry = EMPTY_REGISTRY
  /** Environments already reported as dialling without an app origin. */
  const warnedOrigin = new Set<string>()
  let loaded = false
  let started = false
  let disposed = false
  let activity = options.activity.current()
  let network = options.network.current()
  let latch: Latch | null = null
  /** The wait before asking the storage to load again, while there is one. */
  let hydrateWait: { resolve: () => void; timer: unknown } | null = null
  /** The bootstrap read explaining a socket's protocol refusal, while in flight. */
  let refusalRead: AbortController | null = null
  /** The bootstrap read deciding whether to forget a refused token, while in flight. */
  let rejectionCheck: AbortController | null = null
  let searchGeneration = 0
  let searchAbort: AbortController | null = null
  let retryTimer: unknown = null
  let attempt = 0
  let transport: Transport | null = null
  const stores = new Map<string, EnvironmentStore>()
  const releases: Array<() => void> = []
  const listeners = new Set<() => void>()

  let state: PhoneConnectionState = {
    status: 'starting',
    environments: [],
    selectedId: null,
    endpoint: null,
    bootstrap: IDLE,
    routeFailure: null,
    connection: null,
    protocol: { client: PROTOCOL_VERSION, environment: null },
    activity,
    network,
    attempt: 0,
    retryAt: null,
    socketOrigin: null,
    client: null,
  }

  const set = (patch: Partial<PhoneConnectionState>) => {
    let changed = false
    for (const key of Object.keys(patch) as Array<keyof PhoneConnectionState>) {
      if (state[key] !== patch[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const selected = () => selectedStoredEnvironment(registry)

  /**
   * The whole registry, credentials included, to the phone's storage, which
   * writes it in the background, in order, and keeps each credential in
   * SecureStore. Never a registry with the credentials blanked: to that
   * adapter that would be every token removed.
   */
  const commit = (next: EnvironmentRegistry) => {
    if (next === registry) return
    registry = next
    set({ environments: view(next), selectedId: next.selectedId })
    writeEnvironmentRegistry(next, options.storage.registry)
  }

  /**
   * After a refused token has latched: forget the token, but only once it is
   * certain that its own environment refused it (`revoked`, or `unknown` and
   * the same address still answers as this environment). Compare-and-clear:
   * a token saved since then is left alone. The latch holds either way.
   *
   * The `unknown` case asks the route's bootstrap. Like every other request
   * it stops for a hold or a network gap and is asked again on return, while
   * the latch it belongs to holds and nothing has been decided.
   */
  const checkRejection = () => {
    const refusal = latch
    const pending = refusal?.confirmRejection
    if (!refusal || !pending || rejectionCheck) return
    const abort = new AbortController()
    rejectionCheck = abort
    void confirmCredentialRejected({
      refusal: pending.refusal,
      environmentId: refusal.environmentId,
      endpoint: pending.endpoint,
      probe: (route) => probeRoute(route, abort.signal),
    }).then((confirmed) => {
      if (rejectionCheck === abort) rejectionCheck = null
      if (abort.signal.aborted || disposed || latch !== refusal) return
      // Decided: kept (no answer, another environment) or forgotten.
      delete refusal.confirmRejection
      if (confirmed) {
        commit(forgetRejectedCredential(registry, refusal.environmentId, pending.rejected))
      }
    })
  }

  const cancelRejectionCheck = () => {
    rejectionCheck?.abort()
    rejectionCheck = null
  }

  /** What reaching a route showed. Repeating the same report writes nothing. */
  const recordHealth = (environmentId: string, endpoint: string, report: RouteHealthReport) => {
    commit(setStoredRouteHealth(registry, environmentId, endpoint, report, new Date(now())))
  }

  const storeFor = (environmentId: string) => {
    let store = stores.get(environmentId)
    if (!store) {
      store = createEnvironmentStore()
      stores.set(environmentId, store)
    }
    return store
  }

  const clearRetry = () => {
    if (retryTimer !== null) timers.clearTimeout(retryTimer)
    retryTimer = null
  }

  const cancelSearch = () => {
    searchGeneration += 1
    searchAbort?.abort()
    searchAbort = null
  }

  /** Close and forget the socket's client. Views keep it only with `keepClient`. */
  const dropTransport = (keepClient = false) => {
    const current = transport
    if (!current) {
      if (!keepClient) set({ client: null, connection: null })
      return
    }
    transport = null
    current.unsubscribe()
    current.client.dispose()
    if (!keepClient) set({ client: null, connection: null })
  }

  /** Close the socket but keep the client, its store and what views show. */
  const quiet = () => {
    cancelSearch()
    clearRetry()
    const current = transport
    if (!current) return
    const phase = current.client.getState().connection.phase
    if (phase !== 'closed' && phase !== 'idle') current.closing = true
    current.reopen = false
    current.client.disconnect()
  }

  const scheduleRetry = () => {
    clearRetry()
    const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)]!
    attempt += 1
    retryTimer = timers.setTimeout(() => {
      retryTimer = null
      wake('timer')
    }, delay)
    set({ status: 'waiting', attempt, retryAt: now() + delay })
  }

  const cancelRefusalRead = () => {
    refusalRead?.abort()
    refusalRead = null
  }

  const latchOn = (
    environmentId: string,
    status: Latch['status'],
    patch: Partial<PhoneConnectionState> = {},
    readVersionFrom?: string,
  ) => {
    cancelRefusalRead()
    cancelRejectionCheck()
    latch = { environmentId, status, ...(readVersionFrom ? { readVersionFrom } : {}) }
    cancelSearch()
    clearRetry()
    dropTransport()
    set({ status, retryAt: null, ...patch })
  }

  const onConnection = (current: Transport) => {
    if (transport !== current || disposed) return
    const connection = current.client.getState().connection
    if (connection === current.seen) return
    current.seen = connection
    set({ connection })
    const { environmentId, endpoint } = current

    if (current.closing) {
      // A close the controller asked for says nothing about the route.
      if (connection.phase !== 'closed' && connection.phase !== 'idle') return
      current.closing = false
      current.connectedAt = null
      if (current.reopen) {
        current.reopen = false
        set({ status: 'connecting' })
        current.client.connect()
      }
      return
    }

    if (connection.phase === 'connected') {
      current.connectedAt = now()
      socketFailures.delete(endpoint)
      recordHealth(environmentId, endpoint, { status: 'available' })
      set({
        status: 'connected',
        client: current.client,
        routeFailure: null,
        retryAt: null,
        protocol: { client: PROTOCOL_VERSION, environment: PROTOCOL_VERSION },
      })
      return
    }

    const failure = connection.failure
    if (failure?.code === 'auth') {
      // The environment refused the token (4401, or a handshake refusal).
      // Every route carries the same token, so no route is asked again and
      // nothing redials until a person acts.
      recordHealth(environmentId, endpoint, { status: 'unauthorized', message: failure.message })
      latchOn(environmentId, 'unauthorized', {
        routeFailure: {
          reason: 'credential_rejected',
          endpoint,
          local: isLoopbackEnvironmentEndpoint(endpoint),
          tried: 1,
          ...(failure.message ? { message: failure.message } : {}),
        },
      })
      const refusal = credentialRefusalOf(failure)
      if (refusal && current.credential && latch) {
        latch.confirmRejection = { endpoint, rejected: current.credential, refusal }
        checkRejection()
      }
      return
    }
    if (failure?.code === 'protocol_incompatible' || failure?.code === 'capability_missing') {
      latchOn(
        environmentId,
        'incompatible_protocol',
        { protocol: { client: PROTOCOL_VERSION, environment: null } },
        endpoint,
      )
      readRefusedVersion()
      return
    }

    // A socket that closed for any other reason. A deliberate close (hold,
    // offline) reads `closed` with no failure and is not one.
    if (connection.phase !== 'closed' || !connection.retriesExhausted || !failure) return
    if (activity === 'background' || !network.online) return
    const report = routeHealthFromConnection(connection)
    if (report) recordHealth(environmentId, endpoint, report)
    const stable = current.connectedAt !== null && now() - current.connectedAt >= stableAfterMs
    current.connectedAt = null
    if (stable) {
      // A connection that had been up for a while dropped: start over at
      // once, asking the route in use first in case it only blinked.
      attempt = 0
      wake('socket')
      return
    }
    // It failed while opening, or soon after: back off before asking again,
    // so a route that answers bootstrap but refuses the socket cannot spin,
    // and ask the other routes before this one next time.
    socketFailures.set(endpoint, now())
    scheduleRetry()
  }

  /**
   * The socket's refusal carries no version the client keeps, so the route's
   * bootstrap is asked for the version the environment speaks now. Only its
   * own answer is shown, and only while the latch it explains still holds.
   * Like every other request it stops for a hold or a network gap; it is
   * asked again when the app is back, while the version is still unknown.
   */
  const readRefusedVersion = () => {
    // This refusal's own latch: a retry that is refused again makes a new
    // one, and this answer must not overwrite that one's.
    const refusal = latch
    const endpoint = refusal?.readVersionFrom
    if (!refusal || !endpoint || refusalRead) return
    const { environmentId } = refusal
    const abort = new AbortController()
    refusalRead = abort
    void probeRoute(endpoint, abort.signal).then((outcome) => {
      if (refusalRead === abort) refusalRead = null
      if (abort.signal.aborted || disposed || latch !== refusal) return
      if (outcome.status === 'unreachable') return
      // Answered: asked no more for this refusal, whatever the answer was.
      delete refusal.readVersionFrom
      if (outcome.status !== 'incompatible_protocol') return
      if (outcome.environmentId && outcome.environmentId !== environmentId) return
      set({
        bootstrap: outcome,
        protocol: {
          client: outcome.clientProtocolVersion,
          environment: outcome.serverProtocolVersion,
        },
      })
    })
  }

  /**
   * The `Origin` a socket to `endpoint` sends. With no app origin saved it is
   * React Native's own default, the route's origin, reported once.
   */
  const socketOriginFor = (environment: StoredEnvironment, endpoint: string) => {
    const { environmentId } = environment
    const appOrigin = environment.appOrigin ?? null
    if (appOrigin) {
      return { appOrigin, socketOrigin: { origin: appOrigin, from: 'app' } as SocketOrigin }
    }
    const origin = routeOrigin(endpoint)
    if (!warnedOrigin.has(environmentId)) {
      warnedOrigin.add(environmentId)
      warn(
        `Environment ${environmentId} has no app origin saved (it was paired before the phone ` +
          `kept one). Its socket sends the route's own origin, ${origin ?? 'unknown'}, which the ` +
          'environment refuses unless that origin is allowed. Pairing again records it.',
      )
    }
    return { appOrigin: null, socketOrigin: { origin, from: 'route' } as SocketOrigin }
  }

  const dial = (environment: StoredEnvironment, endpoint: string) => {
    const credential = environment.credential
    const current = transport
    const { appOrigin, socketOrigin } = socketOriginFor(environment, endpoint)
    if (
      current &&
      current.environmentId === environment.environmentId &&
      current.endpoint === endpoint &&
      current.credential === credential &&
      current.appOrigin === appOrigin
    ) {
      if (current.closing) {
        // The socket closed for the hold is still closing; open again once it has.
        current.reopen = true
        set({ status: 'connecting' })
        return
      }
      if (current.client.getState().connection.phase === 'connected') {
        set({ status: 'connected', client: current.client })
        return
      }
      set({ status: 'connecting' })
      current.client.connect()
      return
    }
    // A different route to the same environment keeps the client views
    // already read from: the store carries over, and so does what they show.
    const keepClient = current?.environmentId === environment.environmentId && state.client !== null
    dropTransport(keepClient)
    set({ socketOrigin })
    const { WebSocket: NativeSocket, ...rest } = options.transport ?? {}
    const BaseSocket =
      NativeSocket ?? (globalThis.WebSocket as unknown as NativeWebSocketConstructor | undefined)
    let client: EnvironmentClient
    try {
      client = createClient({
        url: environmentSocketUrl(endpoint),
        credential: credential || undefined,
        environmentId: environment.environmentId,
        store: storeFor(environment.environmentId),
        reconnect: { maxAttempts: 0 },
        ...rest,
        // With no app origin the native default goes out: the route's own.
        ...(BaseSocket
          ? {
              WebSocket: appOrigin
                ? withSocketOrigin(BaseSocket, appOrigin)
                : (BaseSocket as unknown as WebSocketConstructor),
            }
          : {}),
      })
    } catch {
      // No socket could be made at all (no WebSocket on this runtime). Retried
      // like a socket that failed while opening.
      if (keepClient) set({ client: null, connection: null })
      scheduleRetry()
      return
    }
    const next: Transport = {
      environmentId: environment.environmentId,
      endpoint,
      credential,
      appOrigin,
      client,
      seen: undefined,
      connectedAt: null,
      closing: false,
      reopen: false,
      unsubscribe: () => undefined,
    }
    transport = next
    next.unsubscribe = client.subscribe(() => onConnection(next))
    set({ status: 'connecting', ...(keepClient ? { client } : {}) })
    client.connect()
    onConnection(next)
  }

  const runSearch = async (environment: StoredEnvironment, first?: string) => {
    cancelSearch()
    const generation = searchGeneration
    const abort = new AbortController()
    searchAbort = abort
    set({ status: 'searching', retryAt: null })
    let result: RouteSearchResult
    try {
      result = await search(environment, abort.signal, first)
    } catch {
      // A probe never throws by contract; one that does is no answer.
      result = {
        found: null,
        probes: [],
        failure: {
          reason: 'route_down',
          endpoint: environment.routes[0]!.endpoint,
          local: false,
          tried: environment.routes.length,
        },
      }
    }
    // The search may answer while routes behind the one it took are still
    // being asked; those answers are not needed, so their requests stop.
    abort.abort()
    if (searchAbort === abort) searchAbort = null
    if (generation !== searchGeneration || disposed) return
    const environmentId = environment.environmentId
    for (const probe of result.probes) {
      if (probe.known) continue
      const report = routeHealthFromBootstrap(probe.outcome, environmentId)
      if (report) recordHealth(environmentId, probe.endpoint, report)
    }
    const latest = selected()
    if (!latest || latest.environmentId !== environmentId) return

    if (result.found === null) {
      // Nothing answers. A client that was connected keeps its store and
      // what views show; its socket stays closed until a route answers.
      transport?.client.disconnect()
      set({ routeFailure: result.failure, bootstrap: result.probes[0]?.outcome ?? IDLE })
      scheduleRetry()
      return
    }

    const found = result.found
    const outcome = result.probes.find((probe) => probe.endpoint === found)!.outcome
    if (outcome.status === 'incompatible_protocol') {
      latchOn(environmentId, 'incompatible_protocol', {
        endpoint: found,
        bootstrap: outcome,
        routeFailure: null,
        protocol: {
          client: outcome.clientProtocolVersion,
          environment: outcome.serverProtocolVersion,
        },
      })
      return
    }
    if (outcome.status !== 'ready') return
    // The label is the environment's own answer; the route stays where the
    // person put it in their order, since the search picked it, not them.
    const labelled = upsertStoredEnvironment(
      registry,
      { environmentId, endpoint: found, label: outcome.label, keepOrder: true },
      new Date(now()),
    )
    const relabelled = labelled?.environments.find((item) => item.environmentId === environmentId)
    if (labelled && relabelled && relabelled.label !== latest.label) {
      commit({ ...labelled, selectedId: registry.selectedId })
    }
    set({
      endpoint: found,
      bootstrap: outcome,
      routeFailure: null,
      protocol: { client: PROTOCOL_VERSION, environment: outcome.protocolVersion },
    })
    dial(selected() ?? latest, found)
  }

  /** The one place that decides what to do next. */
  const wake = (reason: Wake) => {
    if (!loaded || disposed) return
    clearRetry()
    const environment = selected()
    if (!environment) {
      cancelSearch()
      dropTransport()
      set({
        status: 'no_environment',
        endpoint: null,
        bootstrap: IDLE,
        routeFailure: null,
        retryAt: null,
      })
      return
    }
    if (latch && latch.environmentId === environment.environmentId) {
      cancelSearch()
      if (activity === 'background' || !network.online) {
        cancelRefusalRead()
        cancelRejectionCheck()
      } else {
        readRefusedVersion()
        checkRejection()
      }
      set({ status: latch.status, retryAt: null })
      return
    }
    cancelRefusalRead()
    cancelRejectionCheck()
    latch = null
    if (activity === 'background') {
      quiet()
      set({ status: 'held', retryAt: null })
      return
    }
    if (!network.online) {
      quiet()
      set({ status: 'offline', retryAt: null })
      return
    }
    const current = transport
    if (
      current &&
      current.environmentId === environment.environmentId &&
      current.credential === environment.credential &&
      environment.routes.some((route) => route.endpoint === current.endpoint) &&
      !current.closing &&
      current.client.getState().connection.phase === 'connected'
    ) {
      // Already connected on a route this environment still has.
      cancelSearch()
      set({ status: 'connected', retryAt: null })
      return
    }
    void runSearch(environment, reason === 'socket' ? current?.endpoint : undefined)
  }

  /**
   * Lifecycle and network changes that start over count from zero, and forget
   * which sockets failed: on another network, or at a person's request, every
   * route deserves its place again.
   */
  const restart = (reason: Wake) => {
    attempt = 0
    socketFailures.clear()
    set({ attempt: 0 })
    wake(reason)
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async start() {
      if (started || disposed) return
      started = true
      releases.push(
        options.activity.subscribe((next) => {
          const previous = activity
          activity = next
          set({ activity: next })
          if (next === previous) return
          if (next === 'background') wake('activity')
          else restart('foreground')
        }),
        options.network.subscribe((next) => {
          const previous = network
          network = next
          set({ network: next })
          if (next.online === previous.online) return
          if (!next.online) wake('activity')
          else restart('online')
        }),
      )
      // Read whatever changed while subscribing.
      activity = options.activity.current()
      network = options.network.current()
      // Nothing reads or writes the registry before the storage has loaded:
      // until then its writes are dropped, so the controller waits, and asks
      // again (an unreadable AsyncStorage) on the retry delays.
      for (let tries = 0; ; tries += 1) {
        try {
          await options.storage.hydrate()
          break
        } catch (error) {
          if (disposed) return
          const delay = retryDelays[Math.min(tries, retryDelays.length - 1)]!
          warn(`The phone's storage did not load (${String(error)}); trying again in ${delay} ms.`)
          await new Promise<void>((resolve) => {
            hydrateWait = { resolve, timer: timers.setTimeout(resolve, delay) }
          })
          hydrateWait = null
          if (disposed) return
        }
      }
      if (disposed) return
      const saved = readEnvironmentRegistry(options.storage.registry)
      registry = saved
      loaded = true
      set({
        environments: view(saved),
        selectedId: saved.selectedId,
        activity,
        network,
      })
      restart('start')
    },
    selectEnvironment(environmentId) {
      if (!loaded || disposed) return
      const next = selectStoredEnvironment(registry, environmentId)
      if (next.selectedId !== environmentId) return
      if (transport && transport.environmentId !== environmentId) dropTransport()
      if (registry.selectedId !== environmentId) {
        set({ endpoint: null, bootstrap: IDLE, routeFailure: null })
      }
      latch = null
      commit(next)
      restart('select')
    },
    saveEnvironment(input) {
      if (!loaded || disposed) return
      let appOrigin: string | undefined
      if (input.appOrigin !== undefined && input.appOrigin !== null) {
        appOrigin = parseAppOrigin(input.appOrigin) ?? undefined
        if (!appOrigin) throw new Error('That app address is not valid.')
      }
      const next = upsertStoredEnvironment(
        registry,
        {
          environmentId: input.environmentId,
          endpoint: input.endpoint,
          label: input.label,
          credential: input.credential,
          ...(appOrigin ? { appOrigin } : {}),
        },
        new Date(now()),
      )
      if (!next) throw new Error('That environment address or ID is not valid.')
      // A socket on another environment, or on this one with the token or the
      // app origin being replaced, is retired now: left open while the new
      // search runs, a late refusal of the old token would latch the new one
      // as refused, and a socket that stays up would keep the old origin.
      const saved = findStoredEnvironment(next.environments, input.environmentId)
      if (saved?.appOrigin) warnedOrigin.delete(input.environmentId)
      if (
        transport &&
        (transport.environmentId !== input.environmentId ||
          transport.credential !== saved?.credential ||
          transport.appOrigin !== (saved?.appOrigin ?? null))
      ) {
        dropTransport()
      }
      if (registry.selectedId !== input.environmentId) {
        set({ endpoint: null, bootstrap: IDLE, routeFailure: null })
      }
      latch = null
      commit(next)
      restart('select')
    },
    removeEnvironment(environmentId) {
      if (!loaded || disposed) return
      if (transport?.environmentId === environmentId) dropTransport()
      stores.delete(environmentId)
      if (latch?.environmentId === environmentId) latch = null
      const wasSelected = registry.selectedId === environmentId
      warnedOrigin.delete(environmentId)
      commit(removeStoredEnvironment(registry, environmentId))
      if (wasSelected) set({ endpoint: null, bootstrap: IDLE, routeFailure: null })
      restart('select')
    },
    retry() {
      if (!loaded || disposed) return
      latch = null
      restart('retry')
    },
    flush: () => options.storage.flush(),
    dispose() {
      if (disposed) return
      disposed = true
      if (hydrateWait) {
        timers.clearTimeout(hydrateWait.timer)
        hydrateWait.resolve()
      }
      cancelSearch()
      cancelRefusalRead()
      cancelRejectionCheck()
      clearRetry()
      for (const release of releases.splice(0)) release()
      dropTransport()
      listeners.clear()
    },
  }
}
