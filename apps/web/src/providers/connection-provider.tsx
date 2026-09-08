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
  deriveConnectionUi,
  type BootstrapOutcome,
  type ConnectionUiState,
  type DeriveConnectionInput,
  type EnvironmentSelection,
  type TransportStatus,
} from '../lib/connection-state'
import {
  clearStoredEnvironment,
  readStoredEnvironment,
  writeStoredEnvironment,
  type StoredEnvironment,
} from '../lib/environment-store'

type ConnectionValue = {
  ui: ConnectionUiState
  environment: EnvironmentSelection
  connect: (endpoint: string) => void
  retry: () => void
  changeEnvironment: () => void
}

const ConnectionContext = createContext<ConnectionValue | null>(null)

function toSelection(stored: StoredEnvironment | null): EnvironmentSelection {
  if (!stored) return { status: 'none' }
  return {
    status: 'selected',
    endpoint: stored.endpoint,
    environmentId: stored.environmentId,
    label: stored.label,
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
  const [stored, setStored] = useState<StoredEnvironment | null>(() =>
    preview ? null : readStoredEnvironment(),
  )
  const [hasConnected, setHasConnected] = useState(false)
  const [bootstrapNonce, setBootstrapNonce] = useState(0)

  const persist = useCallback((next: StoredEnvironment | null) => {
    setStored(next)
    if (next) writeStoredEnvironment(next)
    else clearStoredEnvironment()
  }, [])

  const environment = preview?.environment ?? toSelection(stored)
  const endpoint = environment.status === 'selected' ? environment.endpoint : null

  const bootstrapQuery = useQuery({
    queryKey: ['environment-bootstrap', endpoint, bootstrapNonce],
    enabled: !preview && endpoint !== null,
    queryFn: async () => {
      if (!endpoint) throw new Error('Missing environment endpoint')
      return fetchBootstrap(endpoint)
    },
  })

  const liveBootstrap = useMemo<BootstrapOutcome>(() => {
    if (!endpoint) return { status: 'idle' }
    if (bootstrapQuery.isFetching || bootstrapQuery.data === undefined) return { status: 'loading' }
    return bootstrapQuery.data
  }, [bootstrapQuery.data, bootstrapQuery.isFetching, endpoint])

  useEffect(() => {
    if (preview || liveBootstrap.status !== 'ready' || !stored) return
    setHasConnected(true)
    if (stored.environmentId === liveBootstrap.environmentId && stored.label === liveBootstrap.label) {
      return
    }
    persist({
      endpoint: stored.endpoint,
      environmentId: liveBootstrap.environmentId,
      label: liveBootstrap.label,
    })
  }, [preview, liveBootstrap, persist, stored])

  const input: DeriveConnectionInput = preview ?? {
    environment,
    bootstrap: liveBootstrap,
    transport: transportFromBootstrap(liveBootstrap, hasConnected || liveBootstrap.status === 'ready'),
  }

  const ui = deriveConnectionUi(input)

  const connect = useCallback(
    (nextEndpoint: string) => {
      setHasConnected(false)
      persist({ endpoint: nextEndpoint })
      setBootstrapNonce((value) => value + 1)
    },
    [persist],
  )

  const retry = useCallback(() => {
    setBootstrapNonce((value) => value + 1)
  }, [])

  const changeEnvironment = useCallback(() => {
    setHasConnected(false)
    persist(null)
    setBootstrapNonce((value) => value + 1)
  }, [persist])

  const value = useMemo(
    () => ({ ui, environment, connect, retry, changeEnvironment }),
    [ui, environment, connect, retry, changeEnvironment],
  )

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnection() {
  const ctx = useContext(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider')
  return ctx
}
