import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  createServerUpdateWatcher,
  serverUpdateNotice,
  type ServerUpdateNotice,
  type ServerUpdateWatcher,
  type ServerUpdateWatchSnapshot,
} from '@openmanager/environment-client'

import {
  usePhoneConnection,
  usePhoneConnectionController,
} from '../environment/PhoneEnvironmentProvider'
import type { PhoneConnectionController } from '../environment/controller'

/**
 * One watcher per environment for the app's lifetime, like the APK updater:
 * an update outlives the screen that started it, and the home and the
 * environment's page read the same one. A new route or token replaces it.
 */
const watchers = new Map<string, { key: string; watcher: ServerUpdateWatcher }>()
/** Offers put away this run, by environment: the version that was offered. */
const dismissed = new Map<string, string>()
const dismissListeners = new Set<() => void>()

function watcherFor(
  controller: PhoneConnectionController,
  environmentId: string,
): ServerUpdateWatcher | undefined {
  const target = controller.serverUpdateTarget(environmentId)
  const existing = watchers.get(environmentId)
  if (!target) {
    existing?.watcher.dispose()
    watchers.delete(environmentId)
    return undefined
  }
  const key = `${target.endpoint}\n${target.credential}`
  if (existing?.key === key) return existing.watcher
  existing?.watcher.dispose()
  const watcher = createServerUpdateWatcher(target)
  watchers.set(environmentId, { key, watcher })
  return watcher
}

const EMPTY: ServerUpdateWatchSnapshot = {
  status: undefined,
  unsupported: false,
  starting: false,
  error: undefined,
  justUpdated: undefined,
}
const noSubscribe = () => () => {}
const empty = () => EMPTY

export type PhoneServerUpdate = {
  snapshot: ServerUpdateWatchSnapshot
  notice: ServerUpdateNotice
  dismissedVersion: string | undefined
  update: (version?: string) => void
  check: () => void
  dismiss: () => void
  acknowledge: () => void
}

export function useServerUpdate(environmentId: string): PhoneServerUpdate {
  const controller = usePhoneConnectionController()
  const state = usePhoneConnection()
  const endpoint = state.links[environmentId]?.endpoint
  const saved = state.environments.find((item) => item.environmentId === environmentId)
  const watcher = useMemo(
    () => watcherFor(controller, environmentId),
    // The route in use and the token are what a watcher is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, environmentId, endpoint, saved?.paired, saved?.routes],
  )
  const snapshot = useSyncExternalStore(
    watcher?.subscribe ?? noSubscribe,
    watcher?.getSnapshot ?? empty,
  )
  const dismissedVersion = useSyncExternalStore(
    (listener) => {
      dismissListeners.add(listener)
      return () => dismissListeners.delete(listener)
    },
    () => dismissed.get(environmentId),
  )
  const notice = serverUpdateNotice(snapshot)
  const update = useCallback(
    (version?: string) => void watcher?.update(version).catch(() => undefined),
    [watcher],
  )
  const check = useCallback(() => void watcher?.refresh({ check: true }), [watcher])
  const acknowledge = useCallback(() => watcher?.acknowledge(), [watcher])
  const offered = notice.kind === 'available' ? notice.to : undefined
  const dismiss = useCallback(() => {
    if (!offered) return
    dismissed.set(environmentId, offered)
    for (const listener of dismissListeners) listener()
  }, [environmentId, offered])
  return { snapshot, notice, dismissedVersion, update, check, dismiss, acknowledge }
}
