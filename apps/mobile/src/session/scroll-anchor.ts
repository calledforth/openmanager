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
 * Only that gesture takes the list off the end, or back to it. The list moves
 * itself all the time (the visible-content anchoring below, a clamp when the
 * content gets shorter), and scroll events can carry a content height a layout
 * behind: a move nobody's finger made must never read as a reader leaving (a
 * page would stop following by itself) or arriving (older rows joining above
 * a reader would throw them to the bottom).
 *
 * The platform's visible-content anchoring (`maintainVisibleContentPosition`)
 * covers the other direction: older rows joining the list (`tail-window.ts`)
 * and a row above the reader that measures again (virtualised back in, a fold
 * settling) keep the row they are reading in place.
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
  /** A scroll event: the reader's place, theirs or the list's own. Throttled by the platform. */
  onScroll(metrics: ScrollMetrics): void
  /** A finger went down on the list. */
  onDragStart(): void
  /**
   * The finger came off: where the list was at that moment (the drag-end
   * event's own metrics, which no throttled scroll event may have reported
   * yet), and whether it was thrown upward or downward (see `flingsUp`).
   */
  onDragEnd(metrics: ScrollMetrics, flungUp: boolean, flungDown?: boolean): void
  /** The fling after a drag came to rest. */
  onMomentumEnd(metrics: ScrollMetrics): void
  /** The content's height changed. */
  onContentHeight(height: number): void
  /**
   * The list's own height changed: the keyboard rose or fell under a page
   * the window resizes for. A reader at the end stays at it; one scrolled up
   * keeps their offset.
   */
  onViewportHeight(height: number): void
  /** The reader asked for the newest row (the scroll-to-latest button). */
  toLatest(): void
  /** Whether the list is following the end right now. */
  following(): boolean
  /** Whether the page has reached the end it opens at. */
  landed(): boolean
  /** The list's place as the follower last heard it. */
  reading(): ScrollMetrics
  /** A new list mounted: nothing it heard about the last one holds, and it opens at the end. */
  reset(): void
}

export interface ScrollFollowerPorts {
  /** Scroll natively to the very end. */
  scrollToEnd(animated: boolean): void
  /** Run once before the next frame (requestAnimationFrame on the phone). */
  schedule(run: () => void): void
  /** The reader is away from the end, or back: the scroll-to-latest button. */
  onAway?(away: boolean): void
  /** The page reached the end it opens at: once, so it can show. */
  onLanded?(): void
}

/** Further than this many screens from the end, the button jumps rather than animates. */
export const ANIMATE_WITHIN_SCREENS = 3

/** Below this speed (px/ms) a release is a release, not a throw. */
export const FLING_MIN_VELOCITY = 0.05

/**
 * Whether a drag-end's vertical velocity throws the list upward (toward
 * older rows). Android reports the finger's own velocity (positive while it
 * moves down, which scrolls toward the top); iOS reports the content
 * offset's (negative toward the top). Web reports none.
 */
export function flingsUp(velocityY: number | undefined, platform: string): boolean {
  if (!velocityY) return false
  return platform === 'android'
    ? velocityY > FLING_MIN_VELOCITY
    : platform === 'ios'
      ? velocityY < -FLING_MIN_VELOCITY
      : false
}

/** Whether a drag-end's vertical velocity throws the list downward, toward the newest rows. */
export function flingsDown(velocityY: number | undefined, platform: string): boolean {
  return velocityY === undefined ? false : flingsUp(-velocityY, platform)
}

/**
 * The follow-the-end state machine. It starts following (a page opens at its
 * newest row) and only the reader's own scrolling takes it off the end. A
 * gesture is the reader's from the finger going down until its fling comes
 * to rest: thrown upward, it has left the end for all of that time, whatever
 * a late scroll event says, so growth can neither snap the reader back nor
 * cut the fling short (a native scroll to the end would stop it).
 */
export function createScrollFollower(ports: ScrollFollowerPorts): ScrollFollower {
  let atEnd = true
  let dragging = false
  /** Thrown upward and still moving: the reader's, until the fling rests. */
  let flingingUp = false
  /** Thrown downward and still moving: it may carry the reader back to the end. */
  let gliding = false
  let away = false
  let lastHeight = -1
  let lastViewport = -1
  let lastOffset = 0
  let lastFromEnd = 0
  let dragStartOffset = 0
  let scheduled = false
  let landed = false

  const setAway = (next: boolean) => {
    if (next === away) return
    away = next
    ports.onAway?.(next)
  }
  const held = () => dragging || flingingUp
  const land = () => {
    if (landed) return
    landed = true
    ports.onLanded?.()
  }
  /** Content that fits the page never scrolls: it is at its end from the start. */
  const landIfItFits = () => {
    if (lastHeight >= 0 && lastViewport >= 0 && lastHeight <= lastViewport) land()
  }

  const follow = () => {
    if (scheduled) return
    scheduled = true
    ports.schedule(() => {
      scheduled = false
      // The reader may have taken hold, or left, in the meantime.
      if (atEnd && !held()) ports.scrollToEnd(false)
    })
  }

  /** Where the list is now, from any event that says so. */
  const read = (metrics: ScrollMetrics) => {
    const fromEnd = distanceFromEnd(metrics)
    const movedUp = metrics.offset < lastOffset - 1
    lastOffset = metrics.offset
    lastFromEnd = fromEnd
    // Growth below the reader makes the end farther without moving them, and
    // the list moves itself as it anchors and clamps: the reader leaves the
    // end only by moving up with their own gesture (a drag or its fling), and
    // comes back to it only with one, unless an upward fling is still
    // carrying them away.
    if (fromEnd <= FOLLOW_SLOP_PX && !flingingUp) {
      if (dragging || gliding) atEnd = true
      if (atEnd) land()
    } else if (movedUp && held()) atEnd = false
    setAway(awayFromLatest(fromEnd, away))
    return fromEnd
  }

  return {
    onScroll(metrics) {
      read(metrics)
    },
    onDragStart() {
      dragging = true
      flingingUp = false
      gliding = false
      dragStartOffset = lastOffset
    },
    onDragEnd(metrics, flungUp, flungDown = false) {
      const fromEnd = read(metrics)
      dragging = false
      gliding = flungDown
      if (flungUp) {
        // Thrown toward older rows: away from the end until the fling rests.
        flingingUp = true
        atEnd = false
      } else if (metrics.offset < dragStartOffset - 1 && fromEnd > FOLLOW_SLOP_PX) {
        // Dragged up past the slop and let go: whatever the last throttled
        // scroll event said, the reader is no longer at the end.
        atEnd = false
      }
    },
    onMomentumEnd(metrics) {
      // The fling was the reader's, whichever way it went: where it rests is theirs.
      flingingUp = false
      gliding = true
      read(metrics)
      gliding = false
    },
    onContentHeight(height) {
      if (height === lastHeight) return
      lastHeight = height
      landIfItFits()
      if (atEnd && !held()) follow()
    },
    onViewportHeight(height) {
      if (height === lastViewport) return
      const first = lastViewport === -1
      lastViewport = height
      landIfItFits()
      if (!first && atEnd && !held()) follow()
    },
    toLatest() {
      flingingUp = false
      gliding = false
      atEnd = true
      setAway(false)
      // A long way back is a jump: animating it would mount every row between.
      ports.scrollToEnd(lastFromEnd <= lastViewport * ANIMATE_WITHIN_SCREENS)
    },
    following: () => atEnd && !held(),
    landed: () => landed,
    reading: () => ({
      offset: lastOffset,
      contentHeight: lastHeight,
      viewportHeight: lastViewport,
    }),
    reset() {
      atEnd = true
      dragging = false
      flingingUp = false
      gliding = false
      lastHeight = -1
      lastViewport = -1
      lastOffset = 0
      lastFromEnd = 0
      landed = false
      setAway(false)
    },
  }
}
