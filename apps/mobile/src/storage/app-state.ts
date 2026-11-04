/**
 * The phone's "page is going away": the app leaving the foreground. iOS
 * reports `inactive` on the way to the app switcher, where the app can be
 * swiped away without ever reaching `background`, so both count.
 *
 * Writes need no flush of their own: each starts as soon as it is asked for
 * (`write-queue.ts`). This is for app-core's pending work (a draft discard),
 * which turns into writes when it is flushed.
 */

/** The part of React Native's `AppState` this uses. */
export type AppStateLike = {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void }
}

/** In `SubscribePageExit`'s shape: calls `flush` on leaving the foreground, returns the unsubscribe. */
export function createAppStatePageExit(appState: AppStateLike) {
  return (flush: () => void): (() => void) => {
    const subscription = appState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') flush()
    })
    return () => subscription.remove()
  }
}
