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
  const { ui, environment, environments, retryNonce } = useConnection()
  const endpoint = environment.status === 'selected' ? environment.endpoint : null
  // Identity comes only from the selection's environment ID (filled from the
  // registry once bootstrap has answered). An endpoint can belong to several
  // environments over time, so it is never used to pick a credential.
  const environmentId =
    environment.status === 'selected' ? (environment.environmentId ?? null) : null
  const stored = findStoredEnvironment(environments, environmentId)
  const credential = stored?.credential || undefined
  // An offline blip must not tear the client down: the socket's own backoff
  // loop is what recovers the session, and disposing would drop the store with
  // it. Only a different environment, or a failure that needs a person,
  // replaces the client.
  const alive = ui.kind === 'ready' || ui.kind === 'offline'

  // The client is created inside the effect rather than memoized so that
  // StrictMode's setup → cleanup → setup replay (and any real remount) gets a
  // fresh instance; a disposed client ignores connect() for good.
  const [client, setClient] = useState<EnvironmentClient | null>(null)
  useEffect(() => {
    if (!endpoint || !environmentId || !alive) {
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
  }, [createClient, credential, endpoint, environmentId, alive])

  // A manual retry, or the network coming back, should dial now rather than at
  // the end of the current backoff window. connect() on a live client is a
  // no-op, so this is safe to run on every change.
  useEffect(() => {
    if (!client || retryNonce === 0) return
    client.connect()
  }, [client, retryNonce])

  return <EnvironmentClientProvider client={client}>{children}</EnvironmentClientProvider>
}
