import { createContext, useContext } from 'react'
import { browserStorage, subscribeBrowserPageExit } from '../lib/browser-device'

/**
 * Synchronous string storage on this device, in Web Storage's shape. It keeps
 * what one device remembers for itself (folded sidebar rows, where a sent
 * draft's address leads, pre-environment composer drafts, favourite models),
 * never anything the environment owns. Calls may throw (a full quota, private
 * mode); callers catch.
 */
export interface DeviceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Calls `flush` when the page is going away; returns the unsubscribe. */
export type SubscribePageExit = (flush: () => void) => () => void

/**
 * What the host's device offers the shared logic. Each field left out falls
 * back to the browser's own (`lib/browser-device`), which is what the web and
 * desktop hosts use; a host without a DOM passes its own. `storage: null`
 * keeps nothing.
 */
export interface DeviceHost {
  storage?: DeviceStorage | null
  subscribePageExit?: SubscribePageExit
}

export const DeviceHostContext = createContext<DeviceHost>({})

/** The host's device storage; the browser's `localStorage` unless it says otherwise. */
export function useDeviceStorage(): DeviceStorage | null {
  const { storage } = useContext(DeviceHostContext)
  return storage === undefined ? browserStorage() : storage
}

/** How the host says its page is going; the browser's `pagehide`/`freeze` unless it says otherwise. */
export function usePageExit(): SubscribePageExit {
  return useContext(DeviceHostContext).subscribePageExit ?? subscribeBrowserPageExit
}
