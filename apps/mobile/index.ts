// The app's entry. The runtime fills go first, before expo-router loads a
// single route, so shared code never sees React Native's partial `URL` or a
// missing `AbortSignal.timeout` / `crypto.randomUUID`.
import './src/environment/polyfills'
import { AppRegistry } from 'react-native'
import { SESSION_WATCH_TASK } from './modules/session-watch'
import { sessionWatch } from './src/notifications'
import 'expo-router/entry'

// The background watch's task (see src/notifications/watch.ts). It runs for
// as long as the watch does, which keeps the app's timers, and so its socket,
// alive with nothing on screen.
AppRegistry.registerHeadlessTask(SESSION_WATCH_TASK, () => () => sessionWatch.task())
