import { useEffect, useMemo, type ReactNode } from 'react'
import {
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import { environmentSocketUrl } from '../lib/environment-socket'
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
  const stored = endpoint
    ? environments.find((item) => item.endpoints.includes(endpoint))
    : undefined
  const credential = stored?.credential || undefined
  const environmentId =
    environment.status === 'selected' ? (environment.environmentId ?? stored?.environmentId) : undefined
  const ready = ui.kind === 'ready'

  const client = useMemo<EnvironmentClient | null>(() => {
    if (!endpoint || !ready) return null
    return createClient({ url: environmentSocketUrl(endpoint), credential, environmentId })
  }, [createClient, credential, endpoint, environmentId, ready])

  useEffect(() => {
    if (!client) return
    client.connect()
    return () => client.dispose()
  }, [client])

  return <EnvironmentClientProvider client={client}>{children}</EnvironmentClientProvider>
}
