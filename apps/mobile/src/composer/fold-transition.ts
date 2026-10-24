/**
 * The fold's height animation, decided here and drawn by the dock. Only a
 * fold (rest, running, prompt) or a new request arriving animates: the
 * dock's box eases from its height before the change to its height after.
 * Anything else that changes the height (text wrapping, an image, a notice,
 * a question's next slide, a value the environment pushed) lands at once,
 * and one that lands while a fold is easing ends the ease where it is.
 */

/** The dock box's own padding around its content, above and below. */
export const DOCK_PADDING = { top: 6, bottom: 8 } as const

/**
 * The dock box's height for its content's: the box the fold sizes is the
 * glass around the content, padding included, so the two are measured alike.
 */
export const boxHeightOf = (contentHeight: number) =>
  contentHeight + DOCK_PADDING.top + DOCK_PADDING.bottom

/** How long after a fold its new content may still measure itself and count as the fold. */
export const FOLD_SETTLE_MS = 120

export interface FoldPorts {
  /** Ease the box from `from` to `to` (points), then call `onFinished`. */
  animate(from: number, to: number): void
  /**
   * The box takes this height now, with no ease (an ease under way stops).
   * The box always carries its height explicitly once it has measured
   * itself: an animated height that was merely dropped would stay at
   * whatever value it last had, and clip whatever grew after it.
   */
  set(height: number): void
  /**
   * The dock is about to be `delta` taller (or shorter): say so once, now,
   * and keep the per-frame heights of the ease from being reported.
   */
  hold(delta: number): void
  /** The ease is over: the dock reports its own height again. */
  release(): void
  now(): number
}

export interface FoldDriver {
  /** The fold and the request on screen, on every render. */
  onKey(key: string): void
  /** The content measured itself. */
  onContentHeight(height: number): void
  /** The ease reached its end. */
  onFinished(): void
}

export function createFoldDriver(ports: FoldPorts): FoldDriver {
  let key: string | null = null
  let foldedAt = -Infinity
  let height = 0
  let easing = false
  /** No ease: the box is the content's height, now. */
  const land = (at: number) => {
    ports.set(at)
    if (!easing) return
    easing = false
    ports.release()
  }
  return {
    onKey(next) {
      if (key !== null && next !== key) foldedAt = ports.now()
      key = next
    },
    onContentHeight(next) {
      if (!(next > 0) || !Number.isFinite(next)) return
      const previous = height
      height = next
      if (previous <= 0) {
        // First measured: the box carries its height from here on.
        ports.set(next)
        return
      }
      if (Math.abs(next - previous) < 1) return
      const folding = ports.now() - foldedAt <= FOLD_SETTLE_MS
      foldedAt = -Infinity
      if (!folding) {
        // Not a fold, or a second change while one eases: no animation.
        land(next)
        return
      }
      if (easing) land(previous)
      easing = true
      ports.hold(next - previous)
      ports.animate(previous, next)
    },
    onFinished() {
      if (!easing) return
      easing = false
      ports.release()
    },
  }
}

/** The fold's key: what changes it. */
export const foldKey = (fold: string, requestId: string | null) => `${fold}:${requestId ?? ''}`
