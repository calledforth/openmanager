import { composeView, pruneOverlay } from './overlay'
import { createInitialState } from './state'
import type { EnvironmentState, Unsubscribe } from './types'

export interface EnvironmentStore {
  /**
   * What to show: server state with the user's unconfirmed actions laid
   * over it (overlay.ts). The same object while nothing is pending.
   */
  getState(): EnvironmentState
  /** Server state and the overlay as held, with nothing composed: what a cache keeps. */
  getServerState(): EnvironmentState
  subscribe(listener: () => void): Unsubscribe
  /**
   * Applies a pure update to server state and the overlay; listeners run only
   * when the root identity changes. Overlay entries the update satisfied go.
   */
  update(reducer: (state: EnvironmentState) => EnvironmentState): void
}

export function createEnvironmentStore(initial?: EnvironmentState): EnvironmentStore {
  let state = initial ?? createInitialState()
  const listeners = new Set<() => void>()
  return {
    getState: () => composeView(state),
    getServerState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(reducer) {
      const next = pruneOverlay(reducer(state))
      if (next === state) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}
