import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * What a floating notice keeps clear of: the chat composer (and what floats
 * above it), and the sidebar's foot. Each registers itself as it mounts, so a
 * notice already on screen moves the moment one appears, however late.
 */
export type NoticeAnchor = 'composer' | 'sidebar-foot'

// Every mounted element of each kind, in the order they registered; the last
// is the one in use. Two can be mounted at once (the phone's sheet keeps its
// own sidebar footer beside the wide screen's), and when the newer goes the
// older takes over again rather than leaving none.
const anchors = new Map<NoticeAnchor, readonly HTMLElement[]>()
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of [...listeners]) listener()
}

const refs = new Map<NoticeAnchor, (element: HTMLElement | null) => () => void>()

/** A ref callback that registers its element as `name`, for as long as it is mounted. */
export function noticeAnchorRef(name: NoticeAnchor) {
  let ref = refs.get(name)
  if (!ref) {
    ref = (element) => {
      if (!element) return () => undefined
      anchors.set(name, [...(anchors.get(name) ?? []).filter((held) => held !== element), element])
      notify()
      return () => {
        const held = anchors.get(name) ?? []
        if (!held.includes(element)) return
        anchors.set(
          name,
          held.filter((other) => other !== element),
        )
        notify()
      }
    }
    refs.set(name, ref)
  }
  return ref
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The element registered as `name` now, or null; for reads outside render. */
export function noticeAnchor(name: NoticeAnchor): HTMLElement | null {
  return anchors.get(name)?.at(-1) ?? null
}

/** The element registered as `name`, or null while none is mounted. */
export function useNoticeAnchor(name: NoticeAnchor): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => anchors.get(name)?.at(-1) ?? null,
    () => null,
  )
}

export interface AnchorBox {
  left: number
  width: number
  top: number
}

/**
 * Where `element` is on screen, kept current while `active`: through its own
 * resizes, its positioned ancestor's (a sidebar folding moves a centred
 * composer without resizing it), and the window's.
 */
export function useAnchorBox(element: HTMLElement | null, active: boolean): AnchorBox | null {
  const [box, setBox] = useState<AnchorBox | null>(null)
  useEffect(() => {
    if (!active || !element) {
      setBox(null)
      return
    }
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setBox((previous) =>
        previous &&
        previous.left === rect.left &&
        previous.width === rect.width &&
        previous.top === rect.top
          ? previous
          : { left: rect.left, width: rect.width, top: rect.top },
      )
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    if (element.offsetParent instanceof HTMLElement) observer?.observe(element.offsetParent)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [active, element])
  return box
}
