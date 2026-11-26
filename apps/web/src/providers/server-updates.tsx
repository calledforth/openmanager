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
import {
  createServerUpdateWatcher,
  serverUpdateNotice,
  type ServerUpdateNotice,
  type ServerUpdateWatcher,
  type ServerUpdateWatchSnapshot,
} from '@openmanager/environment-client'
import {
  routeSearchOrder,
  type StoredEnvironment,
} from '@openmanager/environment-client/connection'
import { useConnection } from './connection-provider'

/**
 * One update watcher per saved environment (environment-client's
 * server-update.ts), so the toast, the environments page and the connect
 * screen all read the same status. A watcher reads over HTTP with the saved
 * credential, so it works for an environment this page is not connected to,
 * and for one that refused this client's protocol.
 */

type Entry = { key: string; watcher: ServerUpdateWatcher }
type Registry = { watcher: (environmentId: string) => ServerUpdateWatcher | undefined }

const ServerUpdatesContext = createContext<Registry | null>(null)

/** Where a watcher reads from: the route in use for the open one, else the first choice. */
function watchKey(
  environment: StoredEnvironment,
  selectedId: string | null,
  inUseEndpoint: string | null | undefined,
): { endpoint: string; key: string } | undefined {
  if (!environment.credential) return undefined
  const endpoint =
    (environment.environmentId === selectedId ? inUseEndpoint : undefined) ??
    routeSearchOrder(environment)[0]?.endpoint
  if (!endpoint) return undefined
  return { endpoint, key: `${endpoint}\n${environment.credential}` }
}

export function ServerUpdatesProvider({
  children,
  fetch: fetchImpl,
}: {
  children: ReactNode
  /** Tests and stories replace the network. */
  fetch?: typeof fetch
}) {
  const { environments, selectedId, inUseEndpoint } = useConnection()
  const entries = useRef(new Map<string, Entry>())
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const live = new Set<string>()
    let changed = false
    for (const environment of environments) {
      const target = watchKey(environment, selectedId, inUseEndpoint)
      if (!target) continue
      live.add(environment.environmentId)
      const existing = entries.current.get(environment.environmentId)
      if (existing?.key === target.key) continue
      existing?.watcher.dispose()
      entries.current.set(environment.environmentId, {
        key: target.key,
        watcher: createServerUpdateWatcher({
          endpoint: target.endpoint,
          credential: environment.credential,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        }),
      })
      changed = true
    }
    for (const [environmentId, entry] of entries.current) {
      if (live.has(environmentId)) continue
      entry.watcher.dispose()
      entries.current.delete(environmentId)
      changed = true
    }
    if (changed) setVersion((value) => value + 1)
  }, [environments, selectedId, inUseEndpoint, fetchImpl])

  useEffect(() => {
    const current = entries.current
    return () => {
      for (const entry of current.values()) entry.watcher.dispose()
      current.clear()
    }
  }, [])

  const registry = useMemo<Registry>(
    () => ({ watcher: (environmentId) => entries.current.get(environmentId)?.watcher }),
    // A new registry whenever the set of watchers changes, so readers resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  )
  return <ServerUpdatesContext.Provider value={registry}>{children}</ServerUpdatesContext.Provider>
}

const EMPTY: ServerUpdateWatchSnapshot = {
  status: undefined,
  unsupported: false,
  starting: false,
  error: undefined,
  justUpdated: undefined,
}
const noop = () => () => undefined

export type ServerUpdateHandle = {
  snapshot: ServerUpdateWatchSnapshot
  notice: ServerUpdateNotice
  update: (version?: string) => Promise<void>
  refresh: (options?: { check?: boolean }) => Promise<void>
  acknowledge: () => void
}

/** The update status of one saved environment, or nothing outside the provider. */
export function useServerUpdate(environmentId: string | null | undefined): ServerUpdateHandle {
  const registry = useContext(ServerUpdatesContext)
  const watcher = environmentId ? registry?.watcher(environmentId) : undefined
  const snapshot = useSyncExternalStore(
    watcher ? watcher.subscribe : noop,
    watcher ? watcher.getSnapshot : () => EMPTY,
  )
  const update = useCallback(
    async (version?: string) => {
      // The failure lands in the snapshot's `error`, which the surface shows.
      await watcher?.update(version).catch(() => undefined)
    },
    [watcher],
  )
  const refresh = useCallback(
    async (options?: { check?: boolean }) => watcher?.refresh(options),
    [watcher],
  )
  const acknowledge = useCallback(() => watcher?.acknowledge(), [watcher])
  return { snapshot, notice: serverUpdateNotice(snapshot), update, refresh, acknowledge }
}
