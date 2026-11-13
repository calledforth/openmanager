import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { DeviceHostContext, type DeviceStorage } from '@openmanager/app-core/logic'

/** What `HydratedDevice` needs of the phone's storage: its device store, and its load. */
export interface LoadingDeviceStore {
  readonly device: DeviceStorage
  readonly hydrated: boolean
  hydrate(): Promise<void>
}

/**
 * The device's storage for the shared logic, once it has loaded. Before then
 * the store refuses every read and write (`PhoneStorageNotReadyError`), and
 * the shared helpers swallow that: a choice made then would be dropped
 * without a word. So until the load lands this provides no storage (reads
 * fall back to their defaults), and with `hold` it renders nothing at all:
 * a setting is not offered until it can be kept. The load is the same one
 * boot starts (`hydrate` returns it).
 */
export function HydratedDevice({
  store,
  hold = false,
  children,
}: {
  store: LoadingDeviceStore
  /** Render nothing until the store has loaded: for what writes to it. */
  hold?: boolean
  children: ReactNode
}) {
  const [ready, setReady] = useState(store.hydrated)
  useEffect(() => {
    if (ready) return
    let live = true
    store.hydrate().then(
      () => {
        if (live) setReady(true)
      },
      // A failed load is boot's to report and retry; this keeps waiting.
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [ready, store])
  const host = useMemo(() => ({ storage: ready ? store.device : null }), [ready, store])
  if (hold && !ready) return null
  return <DeviceHostContext.Provider value={host}>{children}</DeviceHostContext.Provider>
}
