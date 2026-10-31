import { createContext, useContext, useSyncExternalStore } from 'react'

/** What the composer has open over the page. */
export type ComposerOverlay =
  | { kind: 'model' }
  /** The project picker; `browse` opens it on the folder browser. */
  | { kind: 'project'; browse?: boolean }
  | { kind: 'settings' }
  | { kind: 'plan' }
  | { kind: 'camera' }
  /** The system's photo picker, open over the app: what it hands back is attached. */
  | { kind: 'library' }
  /** Where a photo comes from (the camera or the photo library), standing on the attach button. */
  | { kind: 'attach'; anchor: PickAnchor }
  /** A popover, standing on the pick that opened it (its place in the window). */
  | { kind: 'mode' | 'effort'; anchor: PickAnchor }

export interface PickAnchor {
  x: number
  y: number
  width: number
  height: number
}

export interface ComposerUiState {
  overlay: ComposerOverlay | null
}

const INITIAL: ComposerUiState = { overlay: null }

/**
 * The composer's own on-screen state: which sheet or popover is open. A store
 * rather than component state, so the ⋯ menu (in the page's header) can open
 * Session settings, and so only what reads it renders when it changes.
 * Nothing here is the environment's.
 */
export function createComposerUi(initial: Partial<ComposerUiState> = {}) {
  let state: ComposerUiState = { ...INITIAL, ...initial }
  const listeners = new Set<() => void>()
  const set = (overlay: ComposerOverlay | null) => {
    if (overlay === state.overlay) return
    state = { overlay }
    for (const listener of [...listeners]) listener()
  }
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open: (overlay: ComposerOverlay) => set(overlay),
    close: () => set(null),
  }
}

export type ComposerUi = ReturnType<typeof createComposerUi>

export const ComposerUiContext = createContext<ComposerUi | null>(null)

export function useComposerUi(): ComposerUi {
  const ui = useContext(ComposerUiContext)
  if (!ui) throw new Error('useComposerUi must be used inside a ComposerUiContext')
  return ui
}

/** The composer's on-screen state, re-rendering when it changes. */
export function useComposerUiState(ui: ComposerUi): ComposerUiState {
  return useSyncExternalStore(ui.subscribe, ui.get, ui.get)
}

/**
 * A sample session's composer opened in a given state, from the address
 * (`?composer=model|mode|effort|settings|plan`): how the fixture
 * build is shot for review without a finger. Mode and effort stand where
 * their picks sit in the dock on a 390-wide screen.
 */
export function fixtureComposerUi(
  param: string | undefined,
  window: { width: number; height: number },
): Partial<ComposerUiState> {
  const pickAt = (x: number): PickAnchor => ({ x, y: window.height - 72, width: 80, height: 26 })
  switch (param) {
    case 'model':
    case 'settings':
    case 'plan':
    case 'project':
      return { overlay: { kind: param } }
    case 'mode':
      return { overlay: { kind: 'mode', anchor: pickAt(118) } }
    case 'effort':
      return { overlay: { kind: 'effort', anchor: pickAt(196) } }
    default:
      return {}
  }
}
