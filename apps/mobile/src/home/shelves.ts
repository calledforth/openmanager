/**
 * Which of the home's shelves are unfolded, kept on the phone as web keeps
 * its own in `localStorage`: the look of this phone's list, nothing an
 * environment knows. Cooking starts open, so a session sent cooking is seen
 * landing; Settled starts folded, since it is the long tail.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'

import type { HomeShelf } from './rows'

export type ShelvesOpen = Record<HomeShelf, boolean>

export const SHELVES_OPEN_KEY = 'openmanager.home.shelves-open'
export const DEFAULT_SHELVES_OPEN: ShelvesOpen = { cooking: true, settled: false }

/** What was saved, read leniently: anything unreadable is the default. */
export function readShelvesOpen(raw: string | null): ShelvesOpen {
  if (!raw) return DEFAULT_SHELVES_OPEN
  try {
    const saved = JSON.parse(raw) as Partial<Record<HomeShelf, unknown>> | null
    return {
      cooking: typeof saved?.cooking === 'boolean' ? saved.cooking : DEFAULT_SHELVES_OPEN.cooking,
      settled: typeof saved?.settled === 'boolean' ? saved.settled : DEFAULT_SHELVES_OPEN.settled,
    }
  } catch {
    return DEFAULT_SHELVES_OPEN
  }
}

let state = DEFAULT_SHELVES_OPEN
/** Read once per launch; a fold made before the read lands is the newer word. */
let asked = false
let touched = false
const listeners = new Set<() => void>()

function publish(next: ShelvesOpen) {
  if (next.cooking === state.cooking && next.settled === state.settled) return
  state = next
  for (const listener of listeners) listener()
}

function hydrate() {
  if (asked) return
  asked = true
  AsyncStorage.getItem(SHELVES_OPEN_KEY).then(
    (raw) => {
      if (!touched) publish(readShelvesOpen(raw))
    },
    () => undefined,
  )
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const read = () => state

/** Fold or unfold a shelf, and remember it. */
export function setShelfOpen(shelf: HomeShelf, open: boolean) {
  touched = true
  publish({ ...state, [shelf]: open })
  // Best effort: a fold that could not be saved is still folded now.
  AsyncStorage.setItem(SHELVES_OPEN_KEY, JSON.stringify(state)).catch(() => undefined)
}

/** The shelves' folds, as last left on this phone. */
export function useShelvesOpen(): ShelvesOpen {
  hydrate()
  return useSyncExternalStore(subscribe, read, read)
}
