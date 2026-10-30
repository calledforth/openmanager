import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

import { SELF_UPDATING } from './distribution'
import { clearDownloads, nativePorts } from './native'
import { createUpdater, type UpdateState, type Updater } from './updater'

/** Coming back to the app asks again, at most this often. */
const RESUME_CHECK_MS = 30 * 60 * 1_000
/** Opening Settings asks again, at most this often. */
const SETTINGS_CHECK_MS = 60 * 1_000

/** One updater for the app: a download outlives the screen that started it. */
const updater: Updater | null = SELF_UPDATING ? createUpdater(nativePorts) : null

const IDLE: UpdateState = { kind: 'idle' }
const noSubscribe = () => () => {}
const idleState = () => IDLE

/** The updater and its state; null in a build that does not update itself. */
export function useUpdater(): { updater: Updater; state: UpdateState } | null {
  const state = useSyncExternalStore(
    updater?.subscribe ?? noSubscribe,
    updater?.getState ?? idleState,
  )
  return updater ? { updater, state } : null
}

/**
 * Asks when the app opens and whenever it comes back to the front. Mounted
 * above the environment provider, which remounts everything under it when a
 * pairing is accepted: that must not clear a download or ask again.
 */
export function UpdateChecks() {
  useEffect(() => {
    if (!updater) return
    const app = updater
    clearDownloads()
    void app.check()
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void app.check(RESUME_CHECK_MS)
    })
    return () => subscription.remove()
  }, [])
  return null
}

/** For `useFocusEffect`: asks when the Settings page opens. */
export function useCheckOnFocus() {
  return useCallback(() => {
    void updater?.check(SETTINGS_CHECK_MS)
  }, [])
}
