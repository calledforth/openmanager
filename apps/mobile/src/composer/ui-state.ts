import { createContext, useContext, useSyncExternalStore } from 'react'

/** What the composer has open over the page. */
export type ComposerOverlay =
  | { kind: 'model' }
  | { kind: 'project' }
  | { kind: 'settings' }
  | { kind: 'plan' }
  | { kind: 'camera' }
  /** A popover, standing on the pick that opened it (its place in the window). */
  | { kind: 'mode' | 'effort'; anchor: PickAnchor }

export interface PickAnchor {
  x: number
  y: number
  width: number
  height: number
}

export interface ComposerUiState {
  /** The full-screen composer, with the picks as a tray above the keyboard. */
  expanded: boolean
  overlay: ComposerOverlay | null
}

const INITIAL: ComposerUiState = { expanded: false, overlay: null }

/**
 * The composer's own on-screen state: whether it is pulled up, and which
 * sheet or popover is open. A store rather than component state, so the ⋯
 * menu (in the page's header) can open Session settings, and so only what
 * reads it renders when it changes. Nothing here is the environment's.
 */
export function createComposerUi(initial: Partial<ComposerUiState> = {}) {
  let state: ComposerUiState = { ...INITIAL, ...initial }
  let promptId: string | null = null
  const listeners = new Set<() => void>()
  const set = (next: ComposerUiState) => {
    if (next.expanded === state.expanded && next.overlay === state.overlay) return
    state = next
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
    expand: () => set({ ...state, expanded: true }),
    /** Back to the dock; anything open over the composer closes with it. */
    collapse: () => set({ expanded: false, overlay: null }),
    open: (overlay: ComposerOverlay) => set({ ...state, overlay }),
    close: () => set({ ...state, overlay: null }),
    /**
     * The request the session waits on (null when none). A new one arriving
     * while the composer is pulled up drops it back to the dock, which is
     * that request now, so nothing waits unseen under the editor. What was
     * typed stays in the draft.
     */
    followPrompt(requestId: string | null) {
      const fresh = requestId !== null && requestId !== promptId
      promptId = requestId
      if (fresh && state.expanded) set({ expanded: false, overlay: null })
    },
    /**
     * Android's Back: the open sheet or popover first, then the pulled-up
     * composer. False when there was nothing to close.
     */
    back(): boolean {
      if (state.overlay) {
        set({ ...state, overlay: null })
        return true
      }
      if (state.expanded) {
        set({ ...state, expanded: false })
        return true
      }
      return false
    },
  }
}

export type ComposerUi = ReturnType<typeof createComposerUi>

export const ComposerUiContext = createContext<ComposerUi | null>(null)

export function useComposerUi(): ComposerUi {
  const ui = useContext(ComposerUiContext)
  if (!ui) throw new Error('useComposerUi must be used inside a ComposerUiContext')
  return ui
}

/**
 * What a screen reader must not reach for the layers above it: the page and
 * the dock under anything the composer has open, and the pulled-up editor
 * under a sheet, popover or the camera opened from it.
 */
export function coveredLayers(state: ComposerUiState): { page: boolean; editor: boolean } {
  return {
    page: state.expanded || state.overlay !== null,
    editor: state.expanded && state.overlay !== null,
  }
}

/** The composer's on-screen state, re-rendering when it changes. */
export function useComposerUiState(ui: ComposerUi): ComposerUiState {
  return useSyncExternalStore(ui.subscribe, ui.get, ui.get)
}

/**
 * A sample session's composer opened in a given state, from the address
 * (`?composer=expanded|model|mode|effort|settings|plan`): how the fixture
 * build is shot for review without a finger. Mode and effort stand where
 * their picks sit in the dock on a 390-wide screen.
 */
export function fixtureComposerUi(
  param: string | undefined,
  window: { width: number; height: number },
): Partial<ComposerUiState> {
  const pickAt = (x: number): PickAnchor => ({ x, y: window.height - 72, width: 80, height: 26 })
  switch (param) {
    case 'expanded':
      return { expanded: true }
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
