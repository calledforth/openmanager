import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'

/**
 * The pickers the command palette can open. A picker registers while it is
 * mounted and usable; the palette lists an entry only for registered ones,
 * so "Switch project…" shows on the draft page and nowhere else.
 */
export type PickerId = 'model' | 'project'

const openers = new Map<PickerId, () => void>()
const listeners = new Set<() => void>()
let snapshot: ReadonlySet<PickerId> = new Set()

function publish() {
  snapshot = new Set(openers.keys())
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => snapshot

/** Opens a registered picker; false when none is mounted. */
export function requestPicker(id: PickerId): boolean {
  const open = openers.get(id)
  if (!open) return false
  open()
  return true
}

/** Which pickers can be opened right now. */
export function useAvailablePickers(): ReadonlySet<PickerId> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Registers `open` under `id` while `enabled`. The latest `open` is always
 *  the one called, so it may close over fresh state. */
export function useRegisterPicker(id: PickerId, open: () => void, enabled = true) {
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (!enabled) return
    const opener = () => openRef.current()
    openers.set(id, opener)
    publish()
    return () => {
      if (openers.get(id) === opener) {
        openers.delete(id)
        publish()
      }
    }
  }, [id, enabled])
}

/**
 * While a picker is open, focus that leaves its panel without a pointer press
 * goes back to its field. A dialog closing behind it (the palette that opened
 * it) hands focus back to where it came from a moment later; without this the
 * picker would be open with the composer holding the keys.
 */
export function useHoldFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  fieldRef: RefObject<HTMLElement | null>,
): () => void {
  // Cleared by the returned release(), so a picker that closes and hands
  // focus back on purpose is not pulled back before its effect cleans up.
  const holdingRef = useRef(false)
  useEffect(() => {
    if (!open) return
    holdingRef.current = true
    let pointerDown = false
    const onPointerDown = () => {
      pointerDown = true
    }
    const onPointerUp = () => {
      pointerDown = false
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!holdingRef.current || pointerDown) return
      const panel = panelRef.current
      const target = event.target as Node | null
      if (!panel || (target && panel.contains(target))) return
      fieldRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      holdingRef.current = false
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [open, panelRef, fieldRef])
  return useCallback(() => {
    holdingRef.current = false
  }, [])
}
