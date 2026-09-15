/**
 * The web shell is a normal browser app. It must not require Electron IPC
 * or a Convex deployment URL to boot.
 */
export function hasElectronBridge(target: object = globalThis): boolean {
  return 'electronAPI' in target
}

type NetworkTarget = {
  navigator?: { onLine?: boolean }
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

/**
 * The browser's own verdict on whether this device has a network at all.
 * Anything other than an explicit `false` counts as online: `navigator.onLine`
 * is absent in some runtimes, and a missing API must never strand the shell in
 * an offline surface.
 */
export function isBrowserOnline(target: NetworkTarget = globalThis): boolean {
  return target.navigator?.onLine !== false
}

/**
 * Calls `listener` on every `online`/`offline` transition. Shaped for
 * `useSyncExternalStore`, so it takes no argument and returns an unsubscribe.
 */
export function subscribeToNetworkStatus(
  listener: () => void,
  target: NetworkTarget = globalThis,
): () => void {
  target.addEventListener?.('online', listener)
  target.addEventListener?.('offline', listener)
  return () => {
    target.removeEventListener?.('online', listener)
    target.removeEventListener?.('offline', listener)
  }
}
