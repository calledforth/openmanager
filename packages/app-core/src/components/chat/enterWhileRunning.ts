import { useCallback, useSyncExternalStore } from 'react'
import { useDeviceStorage, type DeviceStorage } from '../../providers/device-host'

/**
 * What a message sent while a turn runs does. `queue`: it waits, and runs as
 * the next turn once this one completes. `steer`: it cuts in once the agent's
 * current step ends (a reply stops at once), and the agent answers it. Enter
 * does the one chosen here, and the composer offers the other beside it.
 */
export type FollowUpAction = 'queue' | 'steer'

export const ENTER_WHILE_RUNNING_STORAGE_KEY = 'openmanager-enter-while-running'

/** Queue unless this device asked otherwise: a message never changes a turn by surprise. */
export const DEFAULT_ENTER_WHILE_RUNNING: FollowUpAction = 'queue'

/** This device's choice. Kept on the device: it is how the user types, not what a chat holds. */
export function readEnterWhileRunning(storage: DeviceStorage | null): FollowUpAction {
  try {
    return storage?.getItem(ENTER_WHILE_RUNNING_STORAGE_KEY) === 'steer'
      ? 'steer'
      : DEFAULT_ENTER_WHILE_RUNNING
  } catch {
    return DEFAULT_ENTER_WHILE_RUNNING
  }
}

const listeners = new Set<() => void>()

export function writeEnterWhileRunning(value: FollowUpAction, storage: DeviceStorage | null): void {
  try {
    storage?.setItem(ENTER_WHILE_RUNNING_STORAGE_KEY, value)
  } catch {
    // A full or private store keeps the old choice; there is nothing to say.
  }
  for (const listener of [...listeners]) listener()
}

/** Every reader on this page hears a change made on it, the Settings choice included. */
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** What Enter does while a turn runs on this device, and how to change it. */
export function useEnterWhileRunning(): [FollowUpAction, (next: FollowUpAction) => void] {
  const storage = useDeviceStorage()
  const read = useCallback(() => readEnterWhileRunning(storage), [storage])
  const value = useSyncExternalStore(subscribe, read, () => DEFAULT_ENTER_WHILE_RUNNING)
  const set = useCallback(
    (next: FollowUpAction) => writeEnterWhileRunning(next, storage),
    [storage],
  )
  return [value, set]
}
