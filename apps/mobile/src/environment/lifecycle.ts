import NetInfo, { type NetInfoState } from '@react-native-community/netinfo'
import { AppState, type AppStateStatus } from 'react-native'
import type { SubscribePageExit } from '@openmanager/app-core/logic'
import type { AppActivity, AppActivitySource, NetworkSource, PhoneNetwork } from './controller'

/** `inactive` is a passing state (app switcher, a call banner), not a hold. */
export function activityFromAppState(status: AppStateStatus | null | undefined): AppActivity {
  return status === 'background' ? 'background' : 'active'
}

/**
 * NetInfo's `isConnected` is whether the device has a network at all;
 * `isInternetReachable` is not used, since a LAN with no internet still
 * reaches an environment on it. `null` (not known yet) counts as online.
 */
export function networkFromNetInfo(state: Pick<NetInfoState, 'isConnected'>): PhoneNetwork {
  return { online: state.isConnected !== false }
}

export const appActivity: AppActivitySource = {
  current: () => activityFromAppState(AppState.currentState),
  subscribe(listener) {
    const subscription = AppState.addEventListener('change', (status) =>
      listener(activityFromAppState(status)),
    )
    return () => subscription.remove()
  },
}

let lastNetwork: PhoneNetwork = { online: true }

export const deviceNetwork: NetworkSource = {
  current: () => lastNetwork,
  subscribe(listener) {
    let last = lastNetwork
    return NetInfo.addEventListener((state) => {
      const next = networkFromNetInfo(state)
      lastNetwork = next
      if (next.online === last.online) return
      last = next
      listener(next)
    })
  },
}

/**
 * app-core's page-exit hook on a phone: the app going to the background is
 * the last moment it is sure to run, so a pending draft discard is carried
 * out then. One function for the app's lifetime; app-core keeps its device
 * host memoised on this identity.
 */
export const subscribeAppExit: SubscribePageExit = (flush) => {
  const subscription = AppState.addEventListener('change', (status) => {
    if (status === 'background') flush()
  })
  return () => subscription.remove()
}
