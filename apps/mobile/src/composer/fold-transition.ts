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
  /** Drop the ease: the box takes its content's height now. */
  snap(): void
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
  const stop = () => {
    if (!easing) return
    easing = false
    ports.snap()
    ports.release()
  }
  return {
    onKey(next) {
      if (key !== null && next !== key) foldedAt = ports.now()
      key = next
    },
    onContentHeight(next) {
      const previous = height
      height = next
      if (previous <= 0 || Math.abs(next - previous) < 1) return
      const folding = ports.now() - foldedAt <= FOLD_SETTLE_MS
      foldedAt = -Infinity
      if (!folding) {
        // Not a fold, or a second change while one eases: no animation.
        stop()
        return
      }
      if (easing) stop()
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
