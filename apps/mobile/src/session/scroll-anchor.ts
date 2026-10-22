/**
 * The transcript's scroll decisions, pure so the tests read them.
 *
 * The list is inverted: offset 0 is the newest row, at the bottom. The
 * platform's visible-content anchoring (`maintainVisibleContentPosition`)
 * keeps whatever row starts past the reader's offset where it is while rows
 * below it grow, settle or arrive, so a reader who scrolled up stays put
 * while the session streams; a reader within the follow threshold of the
 * end is carried to it. The phone never scrolls on its own for a token.
 */

/** Within this of the newest row, a change below the reader keeps them at the end. */
export const FOLLOW_THRESHOLD_PX = 48

export const MAINTAIN_POSITION = {
  minIndexForVisible: 0,
  autoscrollToTopThreshold: FOLLOW_THRESHOLD_PX,
} as const

/** Scrolled this far from the end, the scroll-to-latest button shows… */
export const AWAY_SHOW_PX = 200
/** …and it hides again once back within this, so it does not flicker at the edge. */
export const AWAY_HIDE_PX = 120

/** Whether the scroll-to-latest button shows at `offset`, given whether it showed. */
export function awayFromLatest(offset: number, wasAway: boolean): boolean {
  return wasAway ? offset > AWAY_HIDE_PX : offset > AWAY_SHOW_PX
}
