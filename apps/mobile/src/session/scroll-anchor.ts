/**
 * The transcript's scroll decisions, pure so the tests drive the real thing.
 *
 * The list is in reading order, top-aligned (a short thread starts at the
 * top of the page, as the mockup's transcript does). New words only ever
 * land at the end of the content, below everything already drawn, so a
 * reader who scrolled up is never moved by them: nothing above their offset
 * changed, the list just got longer below them. That holds inside the live
 * reply too: its first lines keep their place while its last line grows.
 *
 * The one reader the list has to help is the one at the end. While they are
 * there, a change of content size (a new line, a new row, a reply settling)
 * is answered with one native scroll to the end, not animated, coalesced to
 * one per frame. That is one call per content-size change, never one per
 * token (most tokens do not change the height at all). The reader's own
 * gesture always wins: while a finger is on the list nothing follows, and
 * the moment they leave the end it stops.
 *
 * The platform's visible-content anchoring (`maintainVisibleContentPosition`)
 * covers the other direction: a row above the reader that measures again
 * (virtualised back in, a fold settling) keeps the row they are reading in
 * place.
 */

/** Within this of the end, the reader is at the end and the list follows it. */
export const FOLLOW_SLOP_PX = 48

/** Rows above the reader that change size do not move what they read. */
export const MAINTAIN_POSITION = { minIndexForVisible: 0 } as const

/** Scrolled this far from the end, the scroll-to-latest button shows… */
export const AWAY_SHOW_PX = 200
/** …and it hides again once back within this, so it does not flicker at the edge. */
export const AWAY_HIDE_PX = 120

/** Whether the scroll-to-latest button shows at `fromEnd`, given whether it showed. */
export function awayFromLatest(fromEnd: number, wasAway: boolean): boolean {
  return wasAway ? fromEnd > AWAY_HIDE_PX : fromEnd > AWAY_SHOW_PX
}

export interface ScrollMetrics {
  /** The scroll offset from the top. */
  offset: number
  contentHeight: number
  viewportHeight: number
}

/** How far the reader is above the end; zero at (or past) it. */
export function distanceFromEnd({ offset, contentHeight, viewportHeight }: ScrollMetrics): number {
  return Math.max(0, contentHeight - viewportHeight - offset)
}

export interface ScrollFollower {
  /** A scroll event: the reader's place, theirs or the list's own. */
  onScroll(metrics: ScrollMetrics): void
  /** A finger went down on the list, or came off it. */
  onDrag(dragging: boolean): void
  /** The content's height changed. */
  onContentHeight(height: number): void
  /** The reader asked for the newest row (the scroll-to-latest button). */
  toLatest(): void
  /** Whether the list is following the end right now. */
  following(): boolean
}

export interface ScrollFollowerPorts {
  /** Scroll natively to the very end. */
  scrollToEnd(animated: boolean): void
  /** Run once before the next frame (requestAnimationFrame on the phone). */
  schedule(run: () => void): void
  /** The reader is away from the end, or back: the scroll-to-latest button. */
  onAway?(away: boolean): void
}

/**
 * The follow-the-end state machine. It starts following (a page opens at its
 * newest row) and only the reader's own scrolling takes it off the end.
 */
export function createScrollFollower(ports: ScrollFollowerPorts): ScrollFollower {
  let atEnd = true
  let dragging = false
  let away = false
  let lastHeight = -1
  let lastOffset = 0
  let scheduled = false

  const setAway = (next: boolean) => {
    if (next === away) return
    away = next
    ports.onAway?.(next)
  }

  const follow = () => {
    if (scheduled) return
    scheduled = true
    ports.schedule(() => {
      scheduled = false
      // The reader may have taken hold, or left, in the meantime.
      if (atEnd && !dragging) ports.scrollToEnd(false)
    })
  }

  return {
    onScroll(metrics) {
      const fromEnd = distanceFromEnd(metrics)
      const movedUp = metrics.offset < lastOffset - 1
      lastOffset = metrics.offset
      // Growth below the reader makes the end farther without moving them,
      // and the list's own scroll to the end only moves down: the reader
      // leaves the end only by moving up (a drag or its fling). Coming back
      // within the slop, by any means, is being at the end again.
      if (fromEnd <= FOLLOW_SLOP_PX) atEnd = true
      else if (movedUp) atEnd = false
      setAway(awayFromLatest(fromEnd, away))
    },
    onDrag(next) {
      dragging = next
    },
    onContentHeight(height) {
      if (height === lastHeight) return
      lastHeight = height
      if (atEnd && !dragging) follow()
    },
    toLatest() {
      atEnd = true
      setAway(false)
      ports.scrollToEnd(true)
    },
    following: () => atEnd && !dragging,
  }
}
