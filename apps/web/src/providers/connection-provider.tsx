import { useQuery } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { fetchBootstrap } from '../lib/bootstrap'
import { isBrowserOnline, subscribeToNetworkStatus } from '../lib/browser-runtime'
import {
  bootstrapOutcomeFromQuery,
  deriveConnectionUi,
  type BootstrapOutcome,
  type ConnectionUiState,
  type DeriveConnectionInput,
  type EnvironmentSelection,
  type RouteFailure,
  type RouteFailureReason,
  type RouteOffer,
  type RouteSearch,
  type TransportStatus,
} from '../lib/connection-state'
import {
  classifyDiscoveredRoute,
  EMPTY_REGISTRY,
  environmentRegistriesEqual,
  findStoredEnvironment,
  isLoopbackEnvironmentEndpoint,
  parseEnvironmentCredential,
  parseEnvironmentEndpoint,
  preferStoredRoute,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  removeStoredRoute,
  routeInUse,
  selectedStoredEnvironment,
  selectStoredEnvironment,
  adoptPersistedCredentials,
  ENVIRONMENT_STORAGE_KEY,
  setStoredCredential,
  setStoredRouteHealth,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
  type RouteHealthReport,
  type StoredEnvironment,
} from '../lib/environment-store'
import { fetchLocalOwner } from '../lib/local-owner'
import { searchRoutes } from '../lib/route-fallback'
import {
  probeRouteHealth,
  routeHealthFromBootstrap,
  WRONG_ENVIRONMENT_MESSAGE,
} from '../lib/route-health'

/**
 * How long to wait before asking every saved route again while none reaches
 * the environment. Grows so a long outage is not a stream of requests, and
 * stops growing so a server that comes back is found within half a minute.
 */
const ROUTE_RETRY_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 15000, 30000]

/**
 * Reasons that only say the environment did not answer, not why. After the
 * environment said it was shutting down, they mean it is still stopped.
 */
const SILENT_REASONS: ReadonlySet<RouteFailureReason> = new Set([
  'route_down',
  'tunnel_down',
  'environment_offline',
])

/** The route the client switched to for each environment, by environment ID. */
type ActiveRoutes = Readonly<Record<string, string>>

type TrackedFailure = RouteFailure & { environmentId: string }
type TrackedSearch = RouteSearch & { environmentId: string }

type PendingConnect = {
  endpoint: string
  credential: string
  claimedEnvironmentId?: string
  /** The person agreed to add this address to an environment already saved. */
  confirmed?: boolean
}

type LocalOwnerClaimFailure = {
  endpoint: string
  message: string
}

type ConnectionValue = {
  ui: ConnectionUiState
  environment: EnvironmentSelection
  environments: StoredEnvironment[]
  selectedId: string | null
  /**
   * The route the selected environment is reached through. Not always the
   * person's first choice: a local route is tried first, and a route that
   * fails is replaced by the next one that answers.
   */
  inUseEndpoint: string | null
  connect: (endpoint: string, credential?: string) => void
  selectEnvironment: (environmentId: string) => void
  removeEnvironment: (environmentId: string) => void
  /**
   * Make this route the person's first choice and reach the environment
   * through it now, selecting the environment if it is not the one in use. If
   * it stops answering, the next route that answers takes over.
   */
  chooseRoute: (environmentId: string, endpoint: string) => void
  /** Forget one route. The last route of an environment cannot be forgotten. */
  removeRoute: (environmentId: string, endpoint: string) => void
  /** Record what the live connection learned about the route it is using. */
  /**
   * `credential` is the token the reporting socket dialled with. A report from
   * a socket whose token has since been replaced (the owner rotated it) is
   * about a token nobody uses any more, and is dropped.
   */
  reportRouteHealth: (
    environmentId: string,
    endpoint: string,
    report: RouteHealthReport,
    credential?: string,
  ) => void
  /** Ask every saved route that is not in use whether it still answers. */
  checkRoutes: () => void
  retry: () => void
  changeEnvironment: () => void
  /**
   * Add the address that is waiting for consent (`ui.kind === 'confirm_route'`)
   * to the environment it answered as, and reach the environment through it.
   */
  confirmRoute: () => void
  /** Drop that address. Nothing is saved and the saved token is not sent. */
  declineRoute: () => void
  /**
   * Save a new client token for an environment, as the owner gets one back
   * when it rotates its credential. The connection redials with it.
   */
  replaceCredential: (environmentId: string, credential: string) => void
  /**
   * Save the credential a pairing exchange answered with, reached through the
   * link's route, select that environment and connect to it. Returns false,
   * saving nothing, when the environment already has a credential here: a
   * pairing link never replaces one. A device that has one redeems the link
   * over its own socket instead.
   */
  addPairedEnvironment: (input: {
    environmentId: string
    endpoint: string
    label: string
    credential: string
  }) => boolean
  /**
   * The route in use answered as a different environment. No socket may be
   * opened on it, whatever else the connection state says: the socket would
   * carry this environment's token to whatever answered.
   */
  wrongEnvironment: boolean
  /**
   * The route in use has answered, on this connection attempt, as the saved
   * environment it belongs to. A new socket may only be opened on a route that
   * has: before that, nothing says the address still leads to the environment
   * whose token the socket would carry.
   */
  routeVerified: boolean
  /**
   * Increments on every explicit retry and on every return from offline. The
   * socket provider dials immediately instead of waiting out its backoff.
   */
  retryNonce: number
}

const ConnectionContext = createContext<ConnectionValue | null>(null)

function routeKey(environmentId: string, endpoint: string): string {
  return JSON.stringify([environmentId, endpoint])
}

/** Server rendering has no network events; assume a network until told otherwise. */
const onlineOnServer = () => true

function inUseFor(
  environment: StoredEnvironment | null | undefined,
  activeRoutes: ActiveRoutes,
): string | null {
  return environment
    ? routeInUse(environment, activeRoutes[environment.environmentId]).endpoint
    : null
}

function toSelection(
  registry: EnvironmentRegistry,
  pending: PendingConnect | null,
  activeRoutes: ActiveRoutes,
): EnvironmentSelection {
  if (pending) {
    // No identity until the address has answered for itself. A record that
    // has this address only says what used to be there; lending its ID to the
    // connect would let a socket carry that record's token to the address
    // before anything has said which environment is behind it.
    //
    // The one exception is the route already in use: entering it again is
    // asking the same connection to try again, so the live client, and the
    // session it holds, stays while the answer is out.
    const selected = selectedStoredEnvironment(registry)
    const inUse =
      selected && inUseFor(selected, activeRoutes) === pending.endpoint ? selected : undefined
    const known =
      inUse ??
      registry.environments.find((item) =>
        item.routes.some((route) => route.endpoint === pending.endpoint),
      )
    return {
      status: 'selected',
      endpoint: pending.endpoint,
      environmentId: inUse?.environmentId,
      label: known?.label,
    }
  }
  const selected = selectedStoredEnvironment(registry)
  if (!selected) return { status: 'none' }
  return {
    status: 'selected',
    endpoint: inUseFor(selected, activeRoutes)!,
    environmentId: selected.environmentId,
    label: selected.label,
  }
}

function transportFromBootstrap(
  bootstrap: BootstrapOutcome,
  hasConnected: boolean,
): TransportStatus {
  if (bootstrap.status === 'ready') {
    return { phase: 'connected', hasConnected: true, failure: null }
  }
  if (bootstrap.status === 'loading' || bootstrap.status === 'idle') {
    return {
      phase: hasConnected ? 'reconnecting' : 'connecting',
      hasConnected,
      failure: null,
    }
  }
  if (bootstrap.status === 'unauthorized') {
    return { phase: 'closed', hasConnected, failure: { code: 'auth', message: bootstrap.message } }
  }
  if (bootstrap.status === 'incompatible_protocol') {
    return { phase: 'closed', hasConnected, failure: { code: 'protocol_incompatible' } }
  }
  return {
    phase: 'closed',
    hasConnected,
    failure: { code: 'unreachable', message: bootstrap.message },
  }
}

export function ConnectionProvider({
  children,
  preview,
  retryDelaysMs = ROUTE_RETRY_DELAYS_MS,
}: {
  children: ReactNode
  preview?: DeriveConnectionInput
  /** Delays between asking every route again while none answers. For tests. */
  retryDelaysMs?: readonly number[]
}) {
  const [registry, setRegistry] = useState<EnvironmentRegistry>(() =>
    preview ? EMPTY_REGISTRY : readEnvironmentRegistry(),
  )
  const [pending, setPending] = useState<PendingConnect | null>(null)
  const [hasConnected, setHasConnected] = useState(false)
  const [bootstrapNonce, setBootstrapNonce] = useState(0)
  const [localOwnerClaimFailure, setLocalOwnerClaimFailure] =
    useState<LocalOwnerClaimFailure | null>(null)
  const claimGeneration = useRef(0)
  /** The address of the owner claim in flight, so forgetting it can cancel the claim. */
  const claimingEndpoint = useRef<string | null>(null)
  /**
   * Routes forgotten since the last connect began. A connect in flight to a
   * shared address cannot be cancelled outright, since it may be to the other
   * environment; its answer is checked against this instead, so it cannot
   * bring a forgotten route back.
   */
  const forgottenRoutes = useRef(new Set<string>())
  const online = useSyncExternalStore(subscribeToNetworkStatus, isBrowserOnline, onlineOnServer)
  const wasOffline = useRef(false)

  // The route in use is the client's pick, not the person's order: it starts
  // at the first route in search order and moves when that route fails. Kept
  // for this page only, so a reload starts again from a local route.
  const [activeRoutes, setActiveRoutes] = useState<ActiveRoutes>({})
  const activeRoutesRef = useRef(activeRoutes)
  const setActiveRoute = useCallback((environmentId: string, routeEndpoint: string | null) => {
    const current = activeRoutesRef.current
    if ((current[environmentId] ?? null) === routeEndpoint) return
    const next = { ...current }
    if (routeEndpoint) next[environmentId] = routeEndpoint
    else delete next[environmentId]
    activeRoutesRef.current = next
    setActiveRoutes(next)
  }, [])

  // Why no route reaches the selected environment, and whether its other
  // routes are being tried right now. A search is identified by its
  // generation; anything that changes what is being reached bumps it, so a
  // late answer cannot move a selection that has moved on.
  const [routeFailure, setRouteFailureState] = useState<TrackedFailure | null>(null)
  const routeFailureRef = useRef<TrackedFailure | null>(null)
  const setRouteFailure = useCallback((failure: TrackedFailure | null) => {
    routeFailureRef.current = failure
    setRouteFailureState(failure)
  }, [])
  const [routeSearch, setRouteSearch] = useState<TrackedSearch | null>(null)
  /**
   * Environments that closed their socket because they were shutting down,
   * each kept until one of its routes answers again. A gateway in front of a
   * stopped server cannot say so in a way a browser may read; the server said
   * it first.
   */
  const announcedStops = useRef(new Set<string>())
  /** How many shutdowns each environment has announced, to date answers by. */
  const stopCounts = useRef(new Map<string, number>())
  const searchGeneration = useRef(0)
  const searching = useRef(false)
  const retryAttempt = useRef(0)
  /**
   * Cancel any search and drop the reason on screen. A token the environment
   * refused is the exception unless a person asked (`reset`): only their
   * action, or the socket getting through, may send that token again.
   * Anything automatic (the network returning, a route being forgotten)
   * leaves it refused.
   */
  const stopRouteSearch = useCallback(
    (reset = false) => {
      searchGeneration.current += 1
      searching.current = false
      retryAttempt.current = 0
      setRouteSearch(null)
      if (reset || routeFailureRef.current?.reason !== 'credential_rejected') setRouteFailure(null)
    },
    [setRouteFailure],
  )
  /** The environment refused its token: nothing may be retried on its own. */
  const tokenRefused = useCallback(
    (environmentId: string) =>
      routeFailureRef.current?.environmentId === environmentId &&
      routeFailureRef.current.reason === 'credential_rejected',
    [],
  )

  // Socket reports arrive outside render and need what the latest render saw.
  const pendingRef = useRef(pending)
  const onlineRef = useRef(online)
  useEffect(() => {
    pendingRef.current = pending
    onlineRef.current = online
  }, [pending, online])

  // Route probes and socket reports land between renders, so every change is
  // computed from the latest registry rather than the one a render captured.
  const registryRef = useRef(registry)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Apply a change and persist it. Returns null when the change was refused. */
  // The registry as this tab last read or wrote it, to tell what other tabs
  // have saved since.
  const persistedRef = useRef(registry)
  const update = useCallback(
    (change: (current: EnvironmentRegistry) => EnvironmentRegistry | null) => {
      const current = registryRef.current
      const changed = change(current)
      if (!changed) return null
      if (changed === current || environmentRegistriesEqual(changed, current)) return current
      const next = preview
        ? changed
        : adoptPersistedCredentials(changed, persistedRef.current, readEnvironmentRegistry())
      registryRef.current = next
      persistedRef.current = next
      setRegistry(next)
      writeEnvironmentRegistry(next)
      // A token taken from another tab is not the one that was refused.
      if (next !== changed) {
        for (const environment of next.environments) {
          const before = findStoredEnvironment(changed.environments, environment.environmentId)
          if (
            before?.credential !== environment.credential &&
            tokenRefused(environment.environmentId)
          ) {
            stopRouteSearch(true)
          }
        }
      }
      return next
    },
    [preview, stopRouteSearch, tokenRefused],
  )

  const environment = preview?.environment ?? toSelection(registry, pending, activeRoutes)
  const endpoint = environment.status === 'selected' ? environment.endpoint : null
  // Identity for a health report comes from the stored selection only. While a
  // connect is pending, the endpoint has not yet proven which environment it is.
  const storedId =
    !pending && environment.status === 'selected' ? environment.environmentId : undefined
  // A failed connect still says something about a saved route when the address
  // is one the selected environment already has: reconnecting to it, or
  // re-entering it with a new token.
  const selectedRecord = selectedStoredEnvironment(registry)
  const failureId =
    storedId ??
    (pending && selectedRecord?.routes.some((route) => route.endpoint === pending.endpoint)
      ? selectedRecord.environmentId
      : undefined)

  const bootstrapQuery = useQuery({
    queryKey: ['environment-bootstrap', endpoint, bootstrapNonce],
    enabled: !preview && endpoint !== null,
    queryFn: async () => {
      if (!endpoint) throw new Error('Missing environment endpoint')
      // HTTP bootstrap is unauthenticated discovery. The stored credential is
      // for the later WebSocket upgrade; sending Authorization here would
      // preflight CORS and the environment server does not handle OPTIONS.
      return fetchBootstrap(endpoint)
    },
  })

  const liveBootstrap = useMemo(
    () => bootstrapOutcomeFromQuery(endpoint !== null, bootstrapQuery.data),
    [bootstrapQuery.data, endpoint],
  )

  // `/bootstrap` is unauthenticated, so the environment ID in an answer is a
  // claim, not a proof. A new address claiming a saved environment would be
  // merged into that record and handed its token on the next socket upgrade.
  // When the connect brought no token of its own, that merge waits for a
  // person to agree; until then the address is neither saved nor dialled.
  const routeOffer = useMemo<RouteOffer | undefined>(() => {
    if (!pending || pending.confirmed || pending.endpoint !== endpoint) return undefined
    if (liveBootstrap.status !== 'ready' && liveBootstrap.status !== 'incompatible_protocol') {
      return undefined
    }
    const answeredId = liveBootstrap.environmentId
    if (!answeredId) return undefined
    if (pending.claimedEnvironmentId && pending.claimedEnvironmentId !== answeredId) {
      return undefined
    }
    const found = classifyDiscoveredRoute(registry, {
      environmentId: answeredId,
      endpoint: pending.endpoint,
      credential: pending.credential,
    })
    if (found.kind !== 'new_route' || !found.sendsSavedCredential) return undefined
    return { endpoint: pending.endpoint, label: found.environment.label }
  }, [pending, endpoint, liveBootstrap, registry])

  // A bootstrap answer becomes route health once, when it arrives. The socket
  // reports on the same route afterwards and must not be overwritten by an
  // answer that is already on record.
  const recordedBootstrap = useRef<BootstrapOutcome | null>(null)
  // Counts what the live connection has said about each route, so a probe that
  // started before such a report can tell its answer is the older one.
  const liveReports = useRef(new Map<string, number>())
  const noteLiveReport = useCallback((environmentId: string, routeEndpoint: string) => {
    const key = routeKey(environmentId, routeEndpoint)
    liveReports.current.set(key, (liveReports.current.get(key) ?? 0) + 1)
  }, [])

  /**
   * Ask the environment's saved routes, local first, for one that reaches it.
   *
   * - `bootstrap`: the route in use just failed its bootstrap (`known`). The
   *   interface says another route is being tried.
   * - `socket`: the live socket dropped. If its route still answers this is a
   *   blip, left to the socket's own backoff; otherwise the next route that
   *   answers takes over.
   * - `retry`: no route answered last time. Asked again quietly, keeping the
   *   reason on screen until something answers.
   *
   * A route that answers is only made the route in use; the main bootstrap
   * query then verifies it, as for any route, before a socket is opened.
   */
  const startRouteSearch = useCallback(
    (
      environmentId: string,
      origin: 'bootstrap' | 'socket' | 'retry',
      known?: { endpoint: string; outcome: BootstrapOutcome },
    ) => {
      const record = findStoredEnvironment(registryRef.current.environments, environmentId)
      if (!record || tokenRefused(environmentId)) return
      const generation = ++searchGeneration.current
      searching.current = true
      const from = inUseFor(record, activeRoutesRef.current)!
      if (origin === 'bootstrap') setRouteSearch({ environmentId, from })
      void searchRoutes(record, {
        known,
        first: origin === 'socket' ? from : undefined,
      }).then((result) => {
        if (generation !== searchGeneration.current || !mounted.current) return
        searching.current = false
        setRouteSearch(null)
        // A blip check that found the route answering says nothing about the
        // socket, which is still failing: its own report stays on record.
        const blip = origin === 'socket' && result.found === from
        for (const probe of result.probes) {
          if (probe.known || (blip && probe.endpoint === from)) continue
          const report = routeHealthFromBootstrap(probe.outcome, environmentId)
          if (!report) continue
          noteLiveReport(environmentId, probe.endpoint)
          update((current) => setStoredRouteHealth(current, environmentId, probe.endpoint, report))
        }
        if (result.found === null) {
          const stopped =
            announcedStops.current.has(environmentId) && SILENT_REASONS.has(result.failure.reason)
          setRouteFailure({
            ...result.failure,
            ...(stopped ? { reason: 'environment_offline', stopped: true } : {}),
            environmentId,
          })
          return
        }
        announcedStops.current.delete(environmentId)
        setRouteFailure(null)
        const latest = findStoredEnvironment(registryRef.current.environments, environmentId)
        const inUse = inUseFor(latest, activeRoutesRef.current)
        if (origin === 'socket' && result.found === inUse) return
        setActiveRoute(environmentId, result.found)
        setBootstrapNonce((value) => value + 1)
      })
    },
    [noteLiveReport, setActiveRoute, setRouteFailure, tokenRefused, update],
  )

  useEffect(() => {
    if (preview || !endpoint) return
    const fresh = recordedBootstrap.current !== liveBootstrap
    if (liveBootstrap.status === 'unreachable' || liveBootstrap.status === 'unauthorized') {
      if (!fresh) return
      recordedBootstrap.current = liveBootstrap
      const report = failureId ? routeHealthFromBootstrap(liveBootstrap, failureId) : null
      if (failureId && report) {
        noteLiveReport(failureId, endpoint)
        update((current) => setStoredRouteHealth(current, failureId, endpoint, report))
      }
      // The route in use of a saved selection failed: try the others. A
      // connect a person started is to the address they typed, and offline
      // nothing would answer; returning online asks again.
      if (storedId && online) {
        startRouteSearch(storedId, 'bootstrap', { endpoint, outcome: liveBootstrap })
      }
      return
    }
    if (liveBootstrap.status !== 'ready' && liveBootstrap.status !== 'incompatible_protocol') return
    const answeredId = liveBootstrap.environmentId
    if (!answeredId) return
    if (pending?.claimedEnvironmentId && pending.claimedEnvironmentId !== answeredId) {
      setHasConnected(false)
      if (localOwnerClaimFailure?.endpoint !== endpoint) {
        setLocalOwnerClaimFailure({
          endpoint,
          message:
            'The local owner credential belongs to a different environment. Change environment and reconnect to claim a matching credential.',
        })
      }
      return
    }
    if (pending && forgottenRoutes.current.has(routeKey(answeredId, endpoint))) {
      // Not put on record: if the selection falls back to this same address,
      // the answer still has to be read as that environment's route health.
      setPending(null)
      return
    }
    // Not put on record either: once the person agrees, this same answer is
    // what makes the address a route, and it must still count as fresh.
    if (routeOffer) return
    recordedBootstrap.current = liveBootstrap
    if (storedId && storedId !== answeredId) {
      // The selected environment's route now leads somewhere else: a reused
      // localhost port, a tunnel handed to another machine. Say so on the
      // route and stay put. Only a person connecting to the address adopts
      // whatever answers there.
      setHasConnected(false)
      if (fresh) {
        noteLiveReport(storedId, endpoint)
        update((current) =>
          setStoredRouteHealth(current, storedId, endpoint, {
            status: 'unreachable',
            message: WRONG_ENVIRONMENT_MESSAGE,
          }),
        )
        // Another of the environment's routes may still lead to it.
        if (online) startRouteSearch(storedId, 'bootstrap', { endpoint, outcome: liveBootstrap })
      }
      return
    }
    if (fresh) noteLiveReport(answeredId, endpoint)
    const stored = update((current) =>
      upsertStoredEnvironment(current, {
        environmentId: answeredId,
        endpoint,
        label: liveBootstrap.label,
        credential: pending?.credential,
        health: fresh ? { status: 'available' } : undefined,
        // A typed address is the person's choice and goes first. A saved
        // route the client picked by itself is not, so the order stays.
        keepOrder: !pending,
      }),
    )
    if (!stored) return
    // The environment answered, even if in another protocol version. Only a
    // new answer counts: this effect also runs again on the one from before
    // the server stopped.
    if (fresh) announcedStops.current.delete(answeredId)
    if (pending) setActiveRoute(answeredId, endpoint)
    if (liveBootstrap.status === 'ready') {
      setHasConnected(true)
      retryAttempt.current = 0
    }
    if (pending) setPending(null)
  }, [
    preview,
    liveBootstrap,
    endpoint,
    update,
    pending,
    localOwnerClaimFailure,
    storedId,
    failureId,
    noteLiveReport,
    routeOffer,
    online,
    startRouteSearch,
    setActiveRoute,
  ])

  const answeredByAnother =
    storedId !== undefined &&
    (liveBootstrap.status === 'ready' || liveBootstrap.status === 'incompatible_protocol') &&
    liveBootstrap.environmentId !== undefined &&
    liveBootstrap.environmentId !== storedId
  const routeVerified =
    storedId !== undefined &&
    liveBootstrap.status === 'ready' &&
    liveBootstrap.environmentId === storedId
  const effectiveBootstrap: BootstrapOutcome =
    localOwnerClaimFailure?.endpoint === endpoint
      ? { status: 'unauthorized', message: localOwnerClaimFailure.message }
      : answeredByAnother
        ? {
            status: 'unreachable',
            message: `${WRONG_ENVIRONMENT_MESSAGE} Use another route to this environment, or connect to the address again to add what answers there.`,
          }
        : liveBootstrap

  const input: DeriveConnectionInput = preview ?? {
    environment,
    bootstrap: effectiveBootstrap,
    transport: transportFromBootstrap(
      effectiveBootstrap,
      hasConnected || effectiveBootstrap.status === 'ready',
    ),
    network: { online },
    routeOffer,
    routeFailure: storedId && routeFailure?.environmentId === storedId ? routeFailure : undefined,
    routeSearch: storedId && routeSearch?.environmentId === storedId ? routeSearch : undefined,
    // Only a saved selection has routes to search and retry; a typed connect
    // that fails waits for the person.
    autoRetry: storedId !== undefined,
  }

  // Returning from offline is the one event worth acting on: the bootstrap
  // query and the socket both get to try again straight away. What the routes
  // said while there was no network says nothing, so it is dropped.
  useEffect(() => {
    if (preview) return
    if (!online) {
      wasOffline.current = true
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    // A refused token is still refused after the network comes back.
    stopRouteSearch()
    setBootstrapNonce((value) => value + 1)
  }, [online, preview, stopRouteSearch])

  // While no route answers, ask them all again with a growing delay. A token
  // the environment refused is not retried: it needs a person.
  useEffect(() => {
    if (preview || !online || !routeFailure) return
    if (routeFailure.reason === 'credential_rejected') return
    const delay = retryDelaysMs[Math.min(retryAttempt.current, retryDelaysMs.length - 1)]
    const timer = setTimeout(() => {
      retryAttempt.current += 1
      startRouteSearch(routeFailure.environmentId, 'retry')
    }, delay)
    return () => clearTimeout(timer)
  }, [preview, online, routeFailure, startRouteSearch, retryDelaysMs])

  const ui = deriveConnectionUi(input)

  const connect = useCallback(
    (nextEndpoint: string, credential = '') => {
      const endpoint = parseEnvironmentEndpoint(nextEndpoint)
      if (!endpoint) return
      const parsed = parseEnvironmentCredential(credential)
      forgottenRoutes.current.clear()
      // A refused token stays refused until the typed connect exists: cleared
      // any earlier, the old selection would be dialled again with it while a
      // local owner claim is still out.
      stopRouteSearch()
      setHasConnected(false)
      setLocalOwnerClaimFailure(null)
      const begin = (nextCredential: string, claimedEnvironmentId?: string) => {
        stopRouteSearch(true)
        setPending({ endpoint, credential: nextCredential, claimedEnvironmentId })
        setBootstrapNonce((value) => value + 1)
      }
      // A pasted token always wins. Remote endpoints are never asked for an
      // owner credential (pairing is how those clients enroll). On loopback a
      // blank token claims the process-minted owner credential before persist
      // so the registry is keyed to the environment ID with that token.
      if (parsed || !isLoopbackEnvironmentEndpoint(endpoint)) {
        claimGeneration.current += 1
        begin(parsed)
        return
      }
      const requestId = ++claimGeneration.current
      claimingEndpoint.current = endpoint
      void fetchLocalOwner(endpoint).then((claim) => {
        if (requestId !== claimGeneration.current) return
        begin(claim?.credential ?? '', claim?.environmentId)
      })
    },
    [stopRouteSearch],
  )

  /**
   * Drop what belonged to a connect, or a route search, that is being
   * replaced or abandoned.
   */
  const abandonPendingConnect = useCallback(
    (reset = true) => {
      setPending(null)
      setLocalOwnerClaimFailure(null)
      claimGeneration.current += 1
      stopRouteSearch(reset)
    },
    [stopRouteSearch],
  )

  const confirmRoute = useCallback(() => {
    setPending((current) => (current ? { ...current, confirmed: true } : current))
  }, [])

  const declineRoute = useCallback(() => {
    abandonPendingConnect()
    // Back to the saved selection, asked afresh rather than read from a cache.
    setBootstrapNonce((value) => value + 1)
  }, [abandonPendingConnect])

  const selectEnvironment = useCallback(
    (environmentId: string) => {
      if (!findStoredEnvironment(registryRef.current.environments, environmentId)) return
      setHasConnected(false)
      abandonPendingConnect()
      // Selecting an environment starts again from its first route in search
      // order, a local one when it has one.
      setActiveRoute(environmentId, null)
      update((current) => selectStoredEnvironment(current, environmentId))
      setBootstrapNonce((value) => value + 1)
    },
    [abandonPendingConnect, setActiveRoute, update],
  )

  const removeEnvironment = useCallback(
    (environmentId: string) => {
      const selected = registryRef.current.selectedId === environmentId
      if (selected) setHasConnected(false)
      // Removing another environment is no answer to the selected one's
      // refused token.
      abandonPendingConnect(selected)
      setActiveRoute(environmentId, null)
      update((current) => removeStoredEnvironment(current, environmentId))
      setBootstrapNonce((value) => value + 1)
    },
    [abandonPendingConnect, setActiveRoute, update],
  )

  const chooseRoute = useCallback(
    (environmentId: string, routeEndpoint: string) => {
      const current = registryRef.current
      const record = findStoredEnvironment(current.environments, environmentId)
      if (!record?.routes.some((route) => route.endpoint === routeEndpoint)) return
      const next = preferStoredRoute(current, environmentId, routeEndpoint)
      const alreadyInUse =
        current.selectedId === environmentId &&
        inUseFor(record, activeRoutesRef.current) === routeEndpoint
      if (alreadyInUse) {
        // Only the saved order changes; the working connection stays as it is.
        if (next !== current) update(() => next)
        return
      }
      setHasConnected(false)
      abandonPendingConnect()
      setActiveRoute(environmentId, routeEndpoint)
      update(() => next)
      setBootstrapNonce((value) => value + 1)
    },
    [abandonPendingConnect, setActiveRoute, update],
  )

  const removeRoute = useCallback(
    (environmentId: string, routeEndpoint: string) => {
      const current = registryRef.current
      const next = removeStoredRoute(current, environmentId, routeEndpoint)
      if (next === current) return
      const before = inUseFor(selectedStoredEnvironment(current), activeRoutesRef.current)
      if (activeRoutesRef.current[environmentId] === routeEndpoint) {
        setActiveRoute(environmentId, null)
      }
      const after = inUseFor(selectedStoredEnvironment(next), activeRoutesRef.current)
      // Forgetting the route in use moves the connection to the next one.
      if (before && after && before !== after) {
        stopRouteSearch()
        setHasConnected(false)
        setBootstrapNonce((value) => value + 1)
      } else if (
        routeFailureRef.current?.environmentId === environmentId &&
        !tokenRefused(environmentId)
      ) {
        // The reason on screen was worked out from routes that included this
        // one. Ask again without it.
        stopRouteSearch()
        setBootstrapNonce((value) => value + 1)
      }
      // A connect to the forgotten address must not bring the route back when
      // its answer arrives. When another environment still has the address the
      // connect may be to that one, so it runs on and its answer is checked
      // against the forgotten routes instead.
      forgottenRoutes.current.add(routeKey(environmentId, routeEndpoint))
      const stillSaved = next.environments.some((item) =>
        item.routes.some((route) => route.endpoint === routeEndpoint),
      )
      if (!stillSaved) {
        setPending((current) => (current?.endpoint === routeEndpoint ? null : current))
        if (claimingEndpoint.current === routeEndpoint) claimGeneration.current += 1
      }
      update(() => next)
    },
    [setActiveRoute, stopRouteSearch, tokenRefused, update],
  )

  const reportRouteHealth = useCallback(
    (
      environmentId: string,
      routeEndpoint: string,
      report: RouteHealthReport,
      credential?: string,
    ) => {
      if (credential !== undefined) {
        // A report from a socket whose token has been replaced, here or by
        // another tab, is about a token nobody uses any more.
        if (
          findStoredEnvironment(registryRef.current.environments, environmentId)?.credential !==
          credential
        ) {
          return
        }
        const saved = preview
          ? undefined
          : findStoredEnvironment(readEnvironmentRegistry().environments, environmentId)?.credential
        if (saved && saved !== credential) {
          update((current) => setStoredCredential(current, environmentId, saved))
          if (tokenRefused(environmentId)) stopRouteSearch(true)
          return
        }
      }
      noteLiveReport(environmentId, routeEndpoint)
      update((current) => setStoredRouteHealth(current, environmentId, routeEndpoint, report))
      // Only the socket on the selected environment's route in use drives the
      // connection. A connect a person started settles on its own.
      const selected = selectedStoredEnvironment(registryRef.current)
      if (pendingRef.current || selected?.environmentId !== environmentId) return
      if (inUseFor(selected, activeRoutesRef.current) !== routeEndpoint) return
      if (report.stopped) {
        announcedStops.current.add(environmentId)
        stopCounts.current.set(environmentId, (stopCounts.current.get(environmentId) ?? 0) + 1)
        // A search already out started before the server said it stopped; a
        // route it finds answering says nothing about the server now.
        searchGeneration.current += 1
        searching.current = false
        setRouteSearch(null)
      }
      if (report.status === 'available') {
        announcedStops.current.delete(environmentId)
        // The socket is back: a search still out for it would only find, too
        // late, that nothing answered while the socket was down.
        searchGeneration.current += 1
        searching.current = false
        retryAttempt.current = 0
        setRouteSearch(null)
        if (routeFailureRef.current) setRouteFailure(null)
        return
      }
      if (report.status === 'unauthorized') {
        // The environment itself refused the token, and every route carries
        // the same one: nothing to search for.
        searchGeneration.current += 1
        searching.current = false
        setRouteSearch(null)
        setRouteFailure({
          environmentId,
          reason: 'credential_rejected',
          endpoint: routeEndpoint,
          local: isLoopbackEnvironmentEndpoint(routeEndpoint),
          tried: 1,
          ...(report.message ? { message: report.message } : {}),
        })
        return
      }
      if (
        report.status === 'unreachable' &&
        onlineRef.current &&
        !searching.current &&
        !routeFailureRef.current
      ) {
        startRouteSearch(environmentId, 'socket')
      }
    },
    [
      noteLiveReport,
      preview,
      setRouteFailure,
      startRouteSearch,
      stopRouteSearch,
      tokenRefused,
      update,
    ],
  )

  // One check per route at a time, so a slow answer cannot land after, and
  // overwrite, a newer one for the same route.
  const probing = useRef(new Set<string>())

  const checkRoutes = useCallback(() => {
    if (preview) return
    const isInUse = (registry: EnvironmentRegistry, environmentId: string, route: string) => {
      const selected = selectedStoredEnvironment(registry)
      return (
        selected?.environmentId === environmentId &&
        inUseFor(selected, activeRoutesRef.current) === route
      )
    }
    const current = registryRef.current
    for (const item of current.environments) {
      for (const route of item.routes) {
        // The route in use is reported by the live bootstrap and the socket.
        if (isInUse(current, item.environmentId, route.endpoint)) continue
        const key = routeKey(item.environmentId, route.endpoint)
        if (probing.current.has(key)) continue
        probing.current.add(key)
        const reportsAtStart = liveReports.current.get(key) ?? 0
        const stopsAtStart = stopCounts.current.get(item.environmentId) ?? 0
        void probeRouteHealth(item.environmentId, route.endpoint).then((report) => {
          probing.current.delete(key)
          if (!mounted.current) return
          // The route was used while the probe was out: what the connection
          // said about it is newer than this answer.
          if ((liveReports.current.get(key) ?? 0) !== reportsAtStart) return
          // The environment answered since it said it was shutting down, if
          // this check started after it said so.
          if (
            report.status === 'available' &&
            (stopCounts.current.get(item.environmentId) ?? 0) === stopsAtStart
          ) {
            announcedStops.current.delete(item.environmentId)
          }
          update((latest) =>
            isInUse(latest, item.environmentId, route.endpoint)
              ? latest
              : setStoredRouteHealth(latest, item.environmentId, route.endpoint, report),
          )
        })
      }
    }
  }, [preview, update])

  const retry = useCallback(() => {
    stopRouteSearch(true)
    setBootstrapNonce((value) => value + 1)
  }, [stopRouteSearch])

  const changeEnvironment = useCallback(() => {
    setHasConnected(false)
    abandonPendingConnect()
    update((current) => ({ ...current, selectedId: null }))
    setBootstrapNonce((value) => value + 1)
  }, [abandonPendingConnect, update])

  const inUseEndpoint = inUseFor(selectedRecord, activeRoutes)

  const replaceCredential = useCallback(
    (environmentId: string, credential: string) => {
      const before = registryRef.current
      const next = update((current) => setStoredCredential(current, environmentId, credential))
      // The old token's refusal, if its socket reported one first, is not a
      // refusal of the new one.
      if (next && next !== before && tokenRefused(environmentId)) stopRouteSearch(true)
    },
    [stopRouteSearch, tokenRefused, update],
  )

  const addPairedEnvironment = useCallback(
    (input: { environmentId: string; endpoint: string; label: string; credential: string }) => {
      const endpoint = parseEnvironmentEndpoint(input.endpoint)
      if (!endpoint || !parseEnvironmentCredential(input.credential)) return false
      // Another tab may have saved one since this tab last read the registry,
      // so both copies are checked even when this tab has a record already.
      const inMemory = findStoredEnvironment(registryRef.current.environments, input.environmentId)
      const persisted = preview
        ? undefined
        : findStoredEnvironment(readEnvironmentRegistry().environments, input.environmentId)
      if (inMemory?.credential || persisted?.credential) return false
      const next = update((current) => upsertStoredEnvironment(current, { ...input, endpoint }))
      if (!next) return false
      setHasConnected(false)
      abandonPendingConnect()
      forgottenRoutes.current.delete(routeKey(input.environmentId, endpoint))
      setActiveRoute(input.environmentId, endpoint)
      setBootstrapNonce((value) => value + 1)
      return true
    },
    [abandonPendingConnect, preview, setActiveRoute, update],
  )

  // Another tab rotated a token (or connected again with a new one): this tab
  // switches to it rather than redialing, or being refused, with the old one.
  useEffect(() => {
    if (preview) return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ENVIRONMENT_STORAGE_KEY) return
      // The token is already saved, so this tab takes it without writing
      // its own copy of everything else back over the other tab's.
      for (const saved of readEnvironmentRegistry().environments) {
        const id = saved.environmentId
        const mine = findStoredEnvironment(registryRef.current.environments, id)
        if (!mine || !saved.credential || saved.credential === mine.credential) continue
        const next = setStoredCredential(registryRef.current, id, saved.credential)
        registryRef.current = next
        persistedRef.current = setStoredCredential(persistedRef.current, id, saved.credential)
        setRegistry(next)
        if (tokenRefused(id)) stopRouteSearch(true)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [preview, stopRouteSearch, tokenRefused])

  const value = useMemo(
    () => ({
      ui,
      environment,
      environments: registry.environments,
      selectedId: registry.selectedId,
      inUseEndpoint,
      connect,
      selectEnvironment,
      removeEnvironment,
      chooseRoute,
      removeRoute,
      reportRouteHealth,
      checkRoutes,
      retry,
      changeEnvironment,
      confirmRoute,
      declineRoute,
      replaceCredential,
      addPairedEnvironment,
      wrongEnvironment: answeredByAnother,
      routeVerified,
      retryNonce: bootstrapNonce,
    }),
    [
      ui,
      environment,
      registry.environments,
      registry.selectedId,
      inUseEndpoint,
      connect,
      selectEnvironment,
      removeEnvironment,
      chooseRoute,
      removeRoute,
      reportRouteHealth,
      checkRoutes,
      retry,
      changeEnvironment,
      confirmRoute,
      declineRoute,
      replaceCredential,
      addPairedEnvironment,
      answeredByAnother,
      routeVerified,
      bootstrapNonce,
    ],
  )

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnection() {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider')
  return ctx
}
