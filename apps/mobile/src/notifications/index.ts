/**
 * The phone's session notices, wired to the device: the native module,
 * AsyncStorage for the choice, React Native's `AppState`. One for the life of
 * the app, like the connection controller it watches.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'

import { SessionWatch } from '../../modules/session-watch'
import { createSessionWatch } from './watch'

export const sessionWatch = createSessionWatch({
  native: SessionWatch,
  storage: AsyncStorage,
  appState: {
    current: () => AppState.currentState,
    subscribe(listener) {
      const subscription = AppState.addEventListener('change', listener)
      return () => subscription.remove()
    },
  },
  log: (message, cause) => console.warn(message, cause),
})

export type { NotificationAccess, SessionNoticesState } from './watch'
