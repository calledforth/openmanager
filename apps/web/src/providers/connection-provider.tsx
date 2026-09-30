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
  type TransportStatus,
} from '../lib/connection-state'
import {
  EMPTY_REGISTRY,
  environmentRegistriesEqual,
  findStoredEnvironment,
  isLoopbackEnvironmentEndpoint,
  parseEnvironmentCredential,
  parseEnvironmentEndpoint,
  preferredRoute,
  preferStoredRoute,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  removeStoredRoute,
  selectedStoredEnvironment,
  selectStoredEnvironment,
  setStoredRouteHealth,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
  type RouteHealthReport,
  type StoredEnvironment,
} from '../lib/environment-store'
import { fetchLocalOwner } from '../lib/local-owner'
import {
  probeRouteHealth,
  routeHealthFromBootstrap,
  WRONG_ENVIRONMENT_MESSAGE,
} from '../lib/route-health'

type PendingConnect = {
  endpoint: string
  credential: string
  claimedEnvironmentId?: string
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
  connect: (endpoint: string, credential?: string) => void
  selectEnvironment: (environmentId: string) => void
  removeEnvironment: (environmentId: string) => void
  /**
   * Reach the environment through this route from now on, selecting the
   * environment if it is not the one in use. The choice is the user's: a route
   * that stops answering is reported, never swapped for another.
   */
  chooseRoute: (environmentId: string, endpoint: string) => void
  /** Forget one route. The last route of an environment cannot be forgotten. */
  removeRoute: (environmentId: string, endpoint: string) => void
  /** Record what the live connection learned about the route it is using. */
  reportRouteHealth: (environmentId: string, endpoint: string, report: RouteHealthReport) => void
  /** Ask every saved route that is not in use whether it still answers. */
  checkRoutes: () => void
  retry: () => void
  changeEnvironment: () => void
  /**
   * Increments on every explicit retry and on every return from offline. The
   * socket provider dials immediately instead of waiting out its backoff.
   */
  retryNonce: number
}

const ConnectionContext = createContext<ConnectionValue | null>(null)

/** Server rendering has no network events; assume a network until told otherwise. */
const onlineOnServer = () => true

function toSelection(
  registry: EnvironmentRegistry,
  pending: PendingConnect | null,
): EnvironmentSelection {
  if (pending) {
    const known = registry.environments.find((item) =>
      item.routes.some((route) => route.endpoint === pending.endpoint),
    )
    return {
      status: 'selected',
      endpoint: pending.endpoint,
      environmentId: known?.environmentId,
      label: known?.label,
    }
  }
  const selected = selectedStoredEnvironment(registry)
  if (!selected) return { status: 'none' }
  return {
    status: 'selected',
    endpoint: preferredRoute(selected).endpoint,
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
}: {
  children: ReactNode
  preview?: DeriveConnectionInput
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
  const online = useSyncExternalStore(subscribeToNetworkStatus, isBrowserOnline, onlineOnServer)
  const wasOffline = useRef(false)

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
  const update = useCallback(
    (change: (current: EnvironmentRegistry) => EnvironmentRegistry | null) => {
      const current = registryRef.current
      const next = change(current)
      if (!next) return null
      if (next === current || environmentRegistriesEqual(next, current)) return current
      registryRef.current = next
      setRegistry(next)
      writeEnvironmentRegistry(next)
      return next
    },
    [],
  )

  const environment = preview?.environment ?? toSelection(registry, pending)
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

  // A bootstrap answer becomes route health once, when it arrives. The socket
  // reports on the same route afterwards and must not be overwritten by an
  // answer that is already on record.
  const recordedBootstrap = useRef<BootstrapOutcome | null>(null)

  useEffect(() => {
    if (preview || !endpoint) return
    const fresh = recordedBootstrap.current !== liveBootstrap
    if (liveBootstrap.status === 'unreachable' || liveBootstrap.status === 'unauthorized') {
      if (!fresh) return
      recordedBootstrap.current = liveBootstrap
      const report = failureId ? routeHealthFromBootstrap(liveBootstrap, failureId) : null
      if (failureId && report) {
        update((current) => setStoredRouteHealth(current, failureId, endpoint, report))
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
    recordedBootstrap.current = liveBootstrap
    if (storedId && storedId !== answeredId) {
      // The selected environment's route now leads somewhere else: a reused
      // localhost port, a tunnel handed to another machine. Say so on the
      // route and stay put. Only a person connecting to the address adopts
      // whatever answers there.
      setHasConnected(false)
      if (fresh) {
        update((current) =>
          setStoredRouteHealth(current, storedId, endpoint, {
            status: 'unreachable',
            message: WRONG_ENVIRONMENT_MESSAGE,
          }),
        )
      }
      return
    }
    const stored = update((current) =>
      upsertStoredEnvironment(current, {
        environmentId: answeredId,
        endpoint,
        label: liveBootstrap.label,
        credential: pending?.credential,
        health: fresh ? { status: 'available' } : undefined,
      }),
    )
    if (!stored) return
    if (liveBootstrap.status === 'ready') setHasConnected(true)
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
  ])

  const answeredByAnother =
    storedId !== undefined &&
    (liveBootstrap.status === 'ready' || liveBootstrap.status === 'incompatible_protocol') &&
    liveBootstrap.environmentId !== undefined &&
    liveBootstrap.environmentId !== storedId
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
  }

  // Returning from offline is the one event worth acting on: the bootstrap
  // query and the socket both get to try again straight away.
  useEffect(() => {
    if (preview) return
    if (!online) {
      wasOffline.current = true
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    setBootstrapNonce((value) => value + 1)
  }, [online, preview])

  const ui = deriveConnectionUi(input)

  const connect = useCallback((nextEndpoint: string, credential = '') => {
    const endpoint = parseEnvironmentEndpoint(nextEndpoint)
    if (!endpoint) return
    const parsed = parseEnvironmentCredential(credential)
    setHasConnected(false)
    setLocalOwnerClaimFailure(null)
    const begin = (nextCredential: string, claimedEnvironmentId?: string) => {
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
  }, [])

  /** Drop what belonged to a connect that is being replaced or abandoned. */
  const abandonPendingConnect = useCallback(() => {
    setPending(null)
    setLocalOwnerClaimFailure(null)
    claimGeneration.current += 1
  }, [])

  const selectEnvironment = useCallback(
    (environmentId: string) => {
      if (!findStoredEnvironment(registryRef.current.environments, environmentId)) return
      setHasConnected(false)
      abandonPendingConnect()
      update((current) => selectStoredEnvironment(current, environmentId))
      setBootstrapNonce((value) => value + 1)
    },
    [abandonPendingConnect, update],
  )

  const removeEnvironment = useCallback(
    (environmentId: string) => {
      if (registryRef.current.selectedId === environmentId) setHasConnected(false)
      abandonPendingConnect()
      update((current) => removeStoredEnvironment(current, environmentId))
      setBootstrapNonce((value) => value + 1)
    },
    [abandonPendingConnect, update],
  )

  const chooseRoute = useCallback(
    (environmentId: string, routeEndpoint: string) => {
      const current = registryRef.current
      const next = preferStoredRoute(current, environmentId, routeEndpoint)
      if (next === current) return
      setHasConnected(false)
      abandonPendingConnect()
      update(() => next)
      setBootstrapNonce((value) => value + 1)
    },
    [abandonPendingConnect, update],
  )

  const removeRoute = useCallback(
    (environmentId: string, routeEndpoint: string) => {
      const current = registryRef.current
      const next = removeStoredRoute(current, environmentId, routeEndpoint)
      if (next === current) return
      const before = selectedStoredEnvironment(current)
      const after = selectedStoredEnvironment(next)
      // Forgetting the route in use moves the connection to the next one.
      if (before && after && preferredRoute(before).endpoint !== preferredRoute(after).endpoint) {
        setHasConnected(false)
        abandonPendingConnect()
        setBootstrapNonce((value) => value + 1)
      }
      // A connect to the forgotten address must not bring the route back when
      // its answer arrives.
      setPending((current) => (current?.endpoint === routeEndpoint ? null : current))
      if (claimingEndpoint.current === routeEndpoint) claimGeneration.current += 1
      update(() => next)
    },
    [abandonPendingConnect, update],
  )

  const reportRouteHealth = useCallback(
    (environmentId: string, routeEndpoint: string, report: RouteHealthReport) => {
      update((current) => setStoredRouteHealth(current, environmentId, routeEndpoint, report))
    },
    [update],
  )

  // One check per route at a time, so a slow answer cannot land after, and
  // overwrite, a newer one for the same route.
  const probing = useRef(new Set<string>())

  const checkRoutes = useCallback(() => {
    if (preview) return
    const isInUse = (registry: EnvironmentRegistry, environmentId: string, route: string) => {
      const selected = selectedStoredEnvironment(registry)
      return (
        selected?.environmentId === environmentId && preferredRoute(selected).endpoint === route
      )
    }
    const current = registryRef.current
    for (const item of current.environments) {
      for (const route of item.routes) {
        // The route in use is reported by the live bootstrap and the socket.
        if (isInUse(current, item.environmentId, route.endpoint)) continue
        const key = JSON.stringify([item.environmentId, route.endpoint])
        if (probing.current.has(key)) continue
        probing.current.add(key)
        void probeRouteHealth(item.environmentId, route.endpoint).then((report) => {
          probing.current.delete(key)
          if (!mounted.current) return
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
    setBootstrapNonce((value) => value + 1)
  }, [])

  const changeEnvironment = useCallback(() => {
    setHasConnected(false)
    abandonPendingConnect()
    update((current) => ({ ...current, selectedId: null }))
    setBootstrapNonce((value) => value + 1)
  }, [abandonPendingConnect, update])

  const value = useMemo(
    () => ({
      ui,
      environment,
      environments: registry.environments,
      selectedId: registry.selectedId,
      connect,
      selectEnvironment,
      removeEnvironment,
      chooseRoute,
      removeRoute,
      reportRouteHealth,
      checkRoutes,
      retry,
      changeEnvironment,
      retryNonce: bootstrapNonce,
    }),
    [
      ui,
      environment,
      registry.environments,
      registry.selectedId,
      connect,
      selectEnvironment,
      removeEnvironment,
      chooseRoute,
      removeRoute,
      reportRouteHealth,
      checkRoutes,
      retry,
      changeEnvironment,
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
