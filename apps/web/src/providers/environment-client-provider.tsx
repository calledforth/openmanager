import { useEffect, useState, type ReactNode } from 'react'
import {
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import { environmentSocketUrl } from '../lib/environment-socket'
import { findStoredEnvironment } from '../lib/environment-store'
import { useConnection } from './connection-provider'

/**
 * Owns the WebSocket client for the selected environment. The client exists
 * only once bootstrap has proven the endpoint is compatible; it is replaced
 * whenever the endpoint, credential, or environment identity changes.
 */
export function WebEnvironmentClientProvider({
  children,
  createClient = createWebSocketEnvironmentClient,
}: {
  children: ReactNode
  createClient?: typeof createWebSocketEnvironmentClient
}) {
  const { ui, environment, environments } = useConnection()
  const endpoint = environment.status === 'selected' ? environment.endpoint : null
  const selectedId = environment.status === 'selected' ? environment.environmentId : undefined
  const stored = endpoint ? findStoredEnvironment(environments, endpoint, selectedId) : undefined
  const credential = stored?.credential || undefined
  const environmentId = selectedId ?? stored?.environmentId
  const ready = ui.kind === 'ready'

  // The client is created inside the effect rather than memoized so that
  // StrictMode's setup → cleanup → setup replay (and any real remount) gets a
  // fresh instance; a disposed client ignores connect() for good.
  const [client, setClient] = useState<EnvironmentClient | null>(null)
  useEffect(() => {
    if (!endpoint || !ready) {
      setClient(null)
      return
    }
    const next = createClient({ url: environmentSocketUrl(endpoint), credential, environmentId })
    setClient(next)
    next.connect()
    return () => {
      next.dispose()
      setClient((current) => (current === next ? null : current))
    }
  }, [createClient, credential, endpoint, environmentId, ready])

  return <EnvironmentClientProvider client={client}>{children}</EnvironmentClientProvider>
}
