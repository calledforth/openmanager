import { requireOptionalNativeModule } from 'expo'

/** The headless JS task the watch runs; registered in the app's entry. */
export const SESSION_WATCH_TASK = 'OpenManagerSessionWatch'

export interface NotificationPermissionResponse {
  status: 'granted' | 'denied' | 'undetermined'
  granted: boolean
  /** False once Android will no longer show its prompt: only its settings can grant it. */
  canAskAgain: boolean
}

/**
 * The phone's native side of session notices (Android only; see
 * `android/.../SessionWatchModule.kt`). Null where the module is not built
 * in: the web export, tests, iOS.
 */
export interface SessionWatchNative {
  notificationsEnabled(): boolean
  requestPermission(): Promise<NotificationPermissionResponse>
  openSettings(): void
  isWatching(): boolean
  /** Throws when Android refuses (the app is not in the foreground). */
  startWatching(): void
  stopWatching(): boolean
  notify(key: string, title: string, body: string, url: string): void
  cancel(key: string): void
}

export const SessionWatch = requireOptionalNativeModule<SessionWatchNative>('SessionWatch')
