/**
 * Session notices on the phone: a session that finishes, stops for input or
 * fails raises an Android notification, unless it is the one on screen.
 *
 * The phone holds its socket only while the app is on screen (`controller.ts`
 * closes it in the background). So that notices still arrive with the app in
 * the background, turning them on also starts the watch: a foreground service
 * (`modules/session-watch`) that keeps the app's JavaScript and its socket
 * running, at the cost of a permanent "Watching your sessions" notification
 * and some battery. While the watch runs, `activity()` tells the controller
 * the app is active, so it keeps the connection instead of holding.
 *
 * Off until turned on. Everything here is plain TypeScript over ports, so it
 * runs under Node in the tests; `index.ts` wires the device.
 */
import type { EnvironmentClient } from '@openmanager/environment-client'
import type {
  NotificationPermissionResponse,
  SessionWatchNative,
} from '../../modules/session-watch'
import type {
  AppActivity,
  AppActivitySource,
  PhoneConnectionState,
} from '../environment/controller'
import { catchUp, sessionLink, sessionOnPath, type Watched } from './notices'

export const NOTIFICATIONS_STORAGE_KEY = 'openmanager.notifications'

/**
 * - `unsupported`: no native module (web, tests, iOS).
 * - `ask`: Android has not been asked, or may ask again.
 * - `blocked`: refused for good, or switched off in Android settings: only
 *   its settings page can turn them back on.
 */
export type NotificationAccess = 'unsupported' | 'granted' | 'ask' | 'blocked'

export interface SessionNoticesState {
  /** Null until the saved choice has been read. */
  enabled: boolean | null
  access: NotificationAccess
  /** The watch (the foreground service) is running. */
  watching: boolean
  /** A turn-on in progress: the permission prompt is up. */
  asking: boolean
}

export interface SessionWatchPorts {
  native: SessionWatchNative | null
  storage: {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
  }
  /** React Native's own app state: `active`, `background`, `inactive`. */
  appState: {
    current(): string | null | undefined
    subscribe(listener: (status: string) => void): () => void
  }
  log?: (message: string, cause?: unknown) => void
}

export interface ConnectionSource {
  getState(): Pick<PhoneConnectionState, 'client' | 'selectedId'>
  subscribe(listener: () => void): () => void
}

export interface SessionWatch {
  getState(): SessionNoticesState
  subscribe(listener: () => void): () => void
  /** Read the saved choice and, if on, start the watch. */
  start(): Promise<void>
  /** Ask for the permission if needed, then turn notices and the watch on. */
  enable(): Promise<void>
  disable(): Promise<void>
  /** Android's notification settings for this app, when `blocked`. */
  openSettings(): void
  /** The controller's activity: never `background` while the watch runs. */
  activity(base: AppActivitySource): AppActivitySource
  /** Watch the sessions of whichever client the connection holds. */
  attach(connection: ConnectionSource): () => void
  /** The page in front changed (`/session/<id>` is that session's). */
  arrived(pathname: string): void
  /** The headless task the watch's service runs: it lasts until the watch stops. */
  task(): Promise<void>
}

export function createSessionWatch(ports: SessionWatchPorts): SessionWatch {
  const { native, storage, appState } = ports
  const log = ports.log ?? (() => {})
  const listeners = new Set<() => void>()
  const watchListeners = new Set<() => void>()
  let state: SessionNoticesState = {
    enabled: null,
    access: native ? (native.notificationsEnabled() ? 'granted' : 'ask') : 'unsupported',
    watching: native?.isWatching() ?? false,
    asking: false,
  }
  let started = false
  let endTask: (() => void) | null = null
  let onScreen: string | null = null
  const watched = new Map<string, Watched>()

  const set = (patch: Partial<SessionNoticesState>) => {
    const next = { ...state, ...patch }
    if (
      next.enabled === state.enabled &&
      next.access === state.access &&
      next.watching === state.watching &&
      next.asking === state.asking
    ) {
      return
    }
    const watchingChanged = next.watching !== state.watching
    state = next
    for (const listener of [...listeners]) listener()
    if (watchingChanged) for (const listener of [...watchListeners]) listener()
  }

  /** What Android allows now; `blocked` stays blocked until it is enabled again. */
  const readAccess = (): NotificationAccess => {
    if (!native) return 'unsupported'
    if (native.notificationsEnabled()) return 'granted'
    return state.access === 'blocked' ? 'blocked' : 'ask'
  }

  const startWatch = () => {
    if (!native || native.isWatching()) {
      set({ watching: native?.isWatching() ?? false })
      return
    }
    try {
      native.startWatching()
      set({ watching: true })
    } catch (cause) {
      // Android starts a foreground service only from the foreground; the
      // next return to it tries again.
      log('Session notices: the watch did not start', cause)
      set({ watching: false })
    }
  }

  const stopWatch = () => {
    const end = endTask
    endTask = null
    // Ending the task lets the service stop itself; stopping it is the backstop.
    end?.()
    if (native) native.stopWatching()
    set({ watching: false })
  }

  /** The watch runs exactly when notices are on and Android shows them. */
  const reconcile = () => {
    const access = readAccess()
    set({ access })
    if (state.enabled && access === 'granted') {
      if (appState.current() === 'active' || native?.isWatching()) startWatch()
    } else if (state.watching || native?.isWatching()) {
      stopWatch()
    }
  }

  const save = async (enabled: boolean) => {
    try {
      await storage.setItem(NOTIFICATIONS_STORAGE_KEY, enabled ? 'on' : 'off')
    } catch (cause) {
      // The choice holds for this run; the next launch reads the old one.
      log('Session notices: the choice was not saved', cause)
    }
  }

  const post = (environmentId: string, client: EnvironmentClient) => {
    const notices = catchUp(watched, environmentId, client.getState())
    if (notices.length === 0 || !native || !state.enabled) return
    if (!native.notificationsEnabled()) return
    const looking = appState.current() === 'active'
    for (const { sessionId, title, body } of notices) {
      if (looking && onScreen === sessionId) continue
      try {
        // Keyed by the session: a newer notice for it replaces the older.
        native.notify(`${environmentId}:${sessionId}`, title, body, sessionLink(sessionId))
      } catch (cause) {
        log('Session notices: a notice was not shown', cause)
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async start() {
      if (started) return
      started = true
      appState.subscribe((status) => {
        // Back in front: Android may have stopped the watch, or the
        // permission may have changed in its settings meanwhile.
        if (status === 'active') reconcile()
      })
      let saved: string | null = null
      try {
        saved = await storage.getItem(NOTIFICATIONS_STORAGE_KEY)
      } catch (cause) {
        log('Session notices: the choice could not be read', cause)
      }
      // A choice made while reading wins.
      if (state.enabled === null) set({ enabled: saved === 'on' })
      reconcile()
    },

    async enable() {
      if (!native || state.asking) return
      if (!native.notificationsEnabled()) {
        if (state.access === 'blocked') {
          native.openSettings()
          return
        }
        set({ asking: true })
        let answer: NotificationPermissionResponse | null = null
        try {
          answer = await native.requestPermission()
        } catch (cause) {
          log('Session notices: the permission prompt failed', cause)
        }
        const granted = native.notificationsEnabled()
        set({
          asking: false,
          access: granted ? 'granted' : answer && !answer.canAskAgain ? 'blocked' : 'ask',
        })
        if (!granted) return
      }
      set({ enabled: true })
      reconcile()
      await save(true)
    },

    async disable() {
      set({ enabled: false })
      reconcile()
      await save(false)
    },

    openSettings() {
      native?.openSettings()
    },

    activity(base) {
      const current = (): AppActivity =>
        base.current() === 'background' && !state.watching ? 'background' : 'active'
      return {
        current,
        subscribe(listener) {
          let last = current()
          const emit = () => {
            const next = current()
            if (next === last) return
            last = next
            listener(next)
          }
          watchListeners.add(emit)
          const stop = base.subscribe(emit)
          return () => {
            watchListeners.delete(emit)
            stop()
          }
        },
      }
    },

    attach(connection) {
      let current: { client: EnvironmentClient; leave: () => void } | null = null
      const follow = () => {
        const { client, selectedId } = connection.getState()
        if (current?.client === client) return
        current?.leave()
        current = null
        if (!client || !selectedId) return
        const look = () => post(selectedId, client)
        look()
        current = { client, leave: client.subscribe(look) }
      }
      follow()
      const stop = connection.subscribe(follow)
      return () => {
        stop()
        current?.leave()
        current = null
      }
    },

    arrived(pathname) {
      onScreen = sessionOnPath(pathname)
      if (onScreen === null || !native) return
      // Its notice has been seen now.
      for (const environmentId of watched.keys()) {
        try {
          native.cancel(`${environmentId}:${onScreen}`)
        } catch {
          // Nothing to take away.
        }
      }
    },

    task() {
      return new Promise<void>((resolve) => {
        // A watch turned off before its task began ends it at once.
        if (!state.watching) {
          resolve()
          return
        }
        endTask?.()
        endTask = resolve
      })
    },
  }
}
