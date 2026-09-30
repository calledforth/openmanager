import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  createWebSocketEnvironmentClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '@openmanager/app-core/providers/environment-client'
import { environmentSocketUrl } from '../lib/environment-socket'
import { findStoredEnvironment } from '../lib/environment-store'
import { routeHealthFromConnection } from '../lib/route-health'
import { createEnvironmentCache, writeEnvironmentCache } from '../lib/environment-cache'
import { useConnection } from './connection-provider'

/**
 * Owns the WebSocket client for the selected environment. The client exists
 * only once bootstrap has proven the endpoint is compatible and the selection
 * carries an environment ID; it is replaced whenever the endpoint, credential,
 * or environment identity changes. Identity never changes with the endpoint:
 * a different route to the same environment gets a new socket and the same
 * environment ID, so sessions and the credential carry over.
 */
export function WebEnvironmentClientProvider({
  children,
  createClient = createWebSocketEnvironmentClient,
}: {
  children: ReactNode
  createClient?: typeof createWebSocketEnvironmentClient
}) {
  const {
    ui,
    environment,
    environments,
    retryNonce,
    reportRouteHealth,
    wrongEnvironment,
    routeVerified,
  } = useConnection()
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
  // A route that answered as another environment never gets a socket, even
  // when the device being offline outranks that in the interface: the socket
  // would hand this environment's token to whatever answered.
  const alive = (ui.kind === 'ready' || ui.kind === 'offline') && !wrongEnvironment

  // Staying alive and being opened are different permissions. A client that
  // exists rides out an offline gap, but a new one is only opened on a route
  // that has answered as this environment: offline says nothing about what is
  // at the address, and the socket upgrade carries the environment's token.
  const connectionKey = endpoint && environmentId ? JSON.stringify([endpoint, environmentId]) : null
  const [verifiedKey, setVerifiedKey] = useState<string | null>(null)
  const nextVerifiedKey =
    !alive || !connectionKey
      ? null
      : routeVerified || verifiedKey === connectionKey
        ? connectionKey
        : null
  if (nextVerifiedKey !== verifiedKey) setVerifiedKey(nextVerifiedKey)
  const open = nextVerifiedKey !== null

  // The client is created inside the effect rather than memoized so that
  // StrictMode's setup → cleanup → setup replay (and any real remount) gets a
  // fresh instance; a disposed client ignores connect() for good.
  const [client, setClient] = useState<EnvironmentClient | null>(null)
  const cache = useRef<ReturnType<typeof createEnvironmentCache> | null>(null)
  if (!cache.current) cache.current = createEnvironmentCache()
  useEffect(() => {
    if (!endpoint || !environmentId || !open) {
      setClient(null)
      return
    }
    let cancelled = false
    let release: (() => void) | undefined
    void cache.current!.getStore(environmentId).then((store) => {
      if (cancelled) return
      const next = createClient({
        url: environmentSocketUrl(endpoint),
        credential,
        environmentId,
        store,
      })
      setClient(next)
      let saveTimer: ReturnType<typeof setTimeout> | undefined
      const save = () => {
        saveTimer = undefined
        void writeEnvironmentCache(environmentId, store.getState())
      }
      const unsubscribeCache = store.subscribe(() => {
        if (saveTimer === undefined) saveTimer = setTimeout(save, 250)
      })
      // What the socket learns is about the route it dialled, so it is filed on
      // that route. The store notifies on every event; only a changed connection
      // is worth reading.
      let seen: unknown
      const unsubscribe = next.subscribe(() => {
        const { connection } = next.getState()
        if (connection === seen) return
        seen = connection
        const report = routeHealthFromConnection(connection)
        if (report) reportRouteHealth(environmentId, endpoint, report)
      })
      next.connect()
      release = () => {
        unsubscribe()
        next.dispose()
        unsubscribeCache()
        if (saveTimer !== undefined) clearTimeout(saveTimer)
        save()
        setClient((current) => (current === next ? null : current))
      }
    })
    return () => {
      cancelled = true
      release?.()
    }
  }, [createClient, credential, endpoint, environmentId, open, reportRouteHealth])

  // A manual retry, or the network coming back, should dial now rather than at
  // the end of the current backoff window. connect() on a live client is a
  // no-op, so this is safe to run on every change.
  useEffect(() => {
    if (!client || retryNonce === 0) return
    client.connect()
  }, [client, retryNonce])

  return <EnvironmentClientProvider client={client}>{children}</EnvironmentClientProvider>
}
