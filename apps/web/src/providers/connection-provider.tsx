import { useQuery } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { fetchBootstrap } from '../lib/bootstrap'
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
  parseEnvironmentCredential,
  parseEnvironmentEndpoint,
  readEnvironmentRegistry,
  removeStoredEnvironment,
  selectedStoredEnvironment,
  selectStoredEnvironment,
  upsertStoredEnvironment,
  writeEnvironmentRegistry,
  type EnvironmentRegistry,
  type StoredEnvironment,
} from '../lib/environment-store'

type PendingConnect = {
  endpoint: string
  credential: string
}

type ConnectionValue = {
  ui: ConnectionUiState
  environment: EnvironmentSelection
  environments: StoredEnvironment[]
  selectedId: string | null
  connect: (endpoint: string, credential?: string) => void
  selectEnvironment: (environmentId: string) => void
  removeEnvironment: (environmentId: string) => void
  retry: () => void
  changeEnvironment: () => void
}

const ConnectionContext = createContext<ConnectionValue | null>(null)

function toSelection(
  registry: EnvironmentRegistry,
  pending: PendingConnect | null,
): EnvironmentSelection {
  if (pending) {
    const known = registry.environments.find((item) => item.endpoints.includes(pending.endpoint))
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
    endpoint: selected.endpoints[0]!,
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

  const persist = useCallback((next: EnvironmentRegistry) => {
    setRegistry(next)
    try {
      writeEnvironmentRegistry(next)
    } catch {
      return
    }
  }, [])

  const environment = preview?.environment ?? toSelection(registry, pending)
  const endpoint = environment.status === 'selected' ? environment.endpoint : null

  const bootstrapQuery = useQuery({
    queryKey: ['environment-bootstrap', endpoint, bootstrapNonce],
    enabled: !preview && endpoint !== null,
    queryFn: async () => {
      if (!endpoint) throw new Error('Missing environment endpoint')
      return fetchBootstrap(endpoint)
    },
  })

  const liveBootstrap = useMemo(
    () => bootstrapOutcomeFromQuery(endpoint !== null, bootstrapQuery.data),
    [bootstrapQuery.data, endpoint],
  )

  useEffect(() => {
    if (preview) return
    if (liveBootstrap.status !== 'ready' && liveBootstrap.status !== 'incompatible_protocol') return
    if (!liveBootstrap.environmentId || !endpoint) return
    const next = upsertStoredEnvironment(registry, {
      environmentId: liveBootstrap.environmentId,
      endpoint,
      label: liveBootstrap.label,
      credential: pending?.credential,
    })
    if (!next) return
    const unchanged = environmentRegistriesEqual(next, registry)
    if (unchanged && pending === null) return
    persist(next)
    if (pending) setPending(null)
  }, [preview, liveBootstrap, endpoint, persist, registry, pending])

  const input: DeriveConnectionInput = preview ?? {
    environment,
    bootstrap: liveBootstrap,
    transport: transportFromBootstrap(liveBootstrap, hasConnected || liveBootstrap.status === 'ready'),
  }

  const ui = deriveConnectionUi(input)

  const connect = useCallback((nextEndpoint: string, credential = '') => {
    const endpoint = parseEnvironmentEndpoint(nextEndpoint)
    if (!endpoint) return
    setHasConnected(false)
    setPending({ endpoint, credential: parseEnvironmentCredential(credential) })
    setBootstrapNonce((value) => value + 1)
  }, [])

  const selectEnvironment = useCallback(
    (environmentId: string) => {
      const next = selectStoredEnvironment(registry, environmentId)
      if (next.selectedId !== environmentId) return
      setHasConnected(false)
      setPending(null)
      persist(next)
      setBootstrapNonce((value) => value + 1)
    },
    [persist, registry],
  )

  const removeEnvironment = useCallback(
    (environmentId: string) => {
      const selected = selectedStoredEnvironment(registry)
      const next = removeStoredEnvironment(registry, environmentId)
      if (selected?.environmentId === environmentId) {
        setHasConnected(false)
        setPending(null)
      }
      persist(next)
      setBootstrapNonce((value) => value + 1)
    },
    [persist, registry],
  )

  const retry = useCallback(() => {
    setBootstrapNonce((value) => value + 1)
  }, [])

  const changeEnvironment = useCallback(() => {
    setHasConnected(false)
    setPending(null)
    persist({ ...registry, selectedId: null })
    setBootstrapNonce((value) => value + 1)
  }, [persist, registry])

  const value = useMemo(
    () => ({
      ui,
      environment,
      environments: registry.environments,
      selectedId: registry.selectedId,
      connect,
      selectEnvironment,
      removeEnvironment,
      retry,
      changeEnvironment,
    }),
    [
      ui,
      environment,
      registry.environments,
      registry.selectedId,
      connect,
      selectEnvironment,
      removeEnvironment,
      retry,
      changeEnvironment,
    ],
  )

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnection() {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider')
  return ctx
}
