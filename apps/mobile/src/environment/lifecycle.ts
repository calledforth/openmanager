import NetInfo, { type NetInfoState } from '@react-native-community/netinfo'
import { AppState, type AppStateStatus } from 'react-native'
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
