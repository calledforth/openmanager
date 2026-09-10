import { createInitialState } from './state'
import type { EnvironmentState, Unsubscribe } from './types'

export interface EnvironmentStore {
  getState(): EnvironmentState
  subscribe(listener: () => void): Unsubscribe
  /** Applies a pure update; listeners run only when the root identity changes. */
  update(reducer: (state: EnvironmentState) => EnvironmentState): void
}

export function createEnvironmentStore(initial?: EnvironmentState): EnvironmentStore {
  let state = initial ?? createInitialState()
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(reducer) {
      const next = reducer(state)
      if (next === state) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}
