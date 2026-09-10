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
 * only once bootstrap has proven the endpoint is compatible and the selection
 * carries an environment ID; it is replaced whenever the endpoint, credential,
 * or environment identity changes.
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
  // Identity comes only from the selection's environment ID (filled from the
  // registry once bootstrap has answered). An endpoint can belong to several
  // environments over time, so it is never used to pick a credential.
  const environmentId =
    environment.status === 'selected' ? (environment.environmentId ?? null) : null
  const stored = findStoredEnvironment(environments, environmentId)
  const credential = stored?.credential || undefined
  const ready = ui.kind === 'ready'

  // The client is created inside the effect rather than memoized so that
  // StrictMode's setup → cleanup → setup replay (and any real remount) gets a
  // fresh instance; a disposed client ignores connect() for good.
  const [client, setClient] = useState<EnvironmentClient | null>(null)
  useEffect(() => {
    if (!endpoint || !environmentId || !ready) {
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
