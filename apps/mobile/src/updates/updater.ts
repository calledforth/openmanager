import { parseFeed, type UpdateRelease } from './feed'

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'check_failed' }
  | { kind: 'available'; release: UpdateRelease }
  /** `percent` is null while the size is unknown. */
  | { kind: 'downloading'; release: UpdateRelease; percent: number | null }
  /** On the phone, waiting on Android's install screen or a tap. */
  | { kind: 'ready'; release: UpdateRelease; apk: string }
  | { kind: 'download_failed'; release: UpdateRelease }

/** What the updater needs from the phone, so its rules can run without one. */
export type UpdaterPorts = {
  /** This APK's build number. */
  currentBuild: number
  /** The feed's JSON; throws when it cannot be read. */
  fetchFeed: () => Promise<unknown>
  /** Saves the APK and answers its handle for `install`; throws on failure. */
  download: (
    release: UpdateRelease,
    onProgress: (fraction: number | null) => void,
  ) => Promise<string>
  /** Hands the APK to Android's installer; settles when that screen closes. */
  install: (apk: string) => Promise<void>
  now: () => number
}

export type Updater = {
  getState: () => UpdateState
  subscribe: (listener: () => void) => () => void
  /**
   * Asks the feed, unless it was asked within `maxAgeMs`. A check with an age
   * is a background one: an "up to date" row stays as it is while it runs.
   */
  check: (maxAgeMs?: number) => Promise<void>
  /** Takes the known release as far as it can go: download, then install. */
  update: () => Promise<void>
  /** The build the home's notice was put away for. */
  dismissedBuild: () => number | null
  dismiss: () => void
}

export function createUpdater(ports: UpdaterPorts): Updater {
  let state: UpdateState = { kind: 'idle' }
  let checkedAt: number | null = null
  let checking = false
  let dismissed: number | null = null
  const listeners = new Set<() => void>()

  const set = (next: UpdateState) => {
    state = next
    for (const listener of listeners) listener()
  }

  const busy = () => state.kind === 'downloading' || state.kind === 'ready'

  const check = async (maxAgeMs = 0) => {
    if (checking || busy()) return
    if (checkedAt !== null && ports.now() - checkedAt < maxAgeMs) return
    checking = true
    // What the phone already knows stays on screen while it asks again.
    const keep =
      state.kind === 'available' ||
      state.kind === 'download_failed' ||
      (state.kind === 'current' && maxAgeMs > 0)
    if (!keep) set({ kind: 'checking' })
    try {
      const release = parseFeed(await ports.fetchFeed())
      if (!release) throw new Error('The update feed is not readable.')
      checkedAt = ports.now()
      // A download started while the feed was being read wins.
      if (busy()) return
      if (release.build <= ports.currentBuild) {
        set({ kind: 'current' })
      } else if (state.kind !== 'download_failed' || state.release.build !== release.build) {
        set({ kind: 'available', release })
      }
    } catch {
      if (!keep) set({ kind: 'check_failed' })
    } finally {
      checking = false
    }
  }

  const install = async (apk: string) => {
    try {
      await ports.install(apk)
    } catch {
      // Android keeps one install screen open at a time, and a screen left
      // open answers the next tap this way. The APK is still good.
    }
  }

  const update = async () => {
    if (state.kind === 'ready') return install(state.apk)
    if (state.kind !== 'available' && state.kind !== 'download_failed') return
    const { release } = state
    let shown: number | null = null
    set({ kind: 'downloading', release, percent: null })
    let apk: string
    try {
      apk = await ports.download(release, (fraction) => {
        const percent = fraction === null ? null : Math.floor(fraction * 100)
        if (percent === shown) return
        shown = percent
        set({ kind: 'downloading', release, percent })
      })
    } catch {
      set({ kind: 'download_failed', release })
      return
    }
    set({ kind: 'ready', release, apk })
    await install(apk)
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    check,
    update,
    dismissedBuild: () => dismissed,
    dismiss: () => {
      if (state.kind !== 'available' && state.kind !== 'download_failed') return
      dismissed = state.release.build
      // A new state object, so a screen reading the store draws again.
      set({ ...state })
    },
  }
}
