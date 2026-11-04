/**
 * The browser's side of `DeviceHost`: the defaults the web and desktop hosts
 * run on. This is the one module in the logic entry's graph allowed to name a
 * browser global (see `eslint.config.mjs`), and each use is feature-detected,
 * so off the browser it yields nothing rather than throwing.
 */
import type { DeviceStorage, SubscribePageExit } from '../providers/device-host'

/** `localStorage`, or null where there is none or it refuses access. */
export function browserStorage(): DeviceStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const noop = () => undefined

/**
 * The page is going: unloaded, or frozen (which may end in a discard of the
 * tab). Not when it is only hidden. Captured, so a flush lands before the
 * host's own `pagehide` files the state away for the next load.
 */
export const subscribeBrowserPageExit: SubscribePageExit = (flush) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return noop
  window.addEventListener('pagehide', flush, { capture: true })
  document.addEventListener('freeze', flush, { capture: true })
  return () => {
    window.removeEventListener('pagehide', flush, { capture: true })
    document.removeEventListener('freeze', flush, { capture: true })
  }
}
