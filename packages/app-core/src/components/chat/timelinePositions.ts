import type { VirtualItem } from '@tanstack/react-virtual'

/**
 * Where the reader left a session's timeline, kept for the lifetime of the page.
 *
 * The position is stored as "this row, this many pixels into it" together with
 * every row height measured so far. Replaying the heights lets the next visit
 * lay the timeline out exactly as it was before any row re-renders, so the
 * anchor lands on the same pixel instead of on estimated row positions.
 */
export interface TimelinePosition {
  /** The reader was at (or following) the bottom. */
  atEnd: boolean
  anchorKey?: string
  /** Pixels between the top of the anchor row and the top of the viewport. */
  offsetWithinAnchor: number
  rowHeights: ReadonlyMap<string, number>
}

const MAX_REMEMBERED_SESSIONS = 100
const positions = new Map<string, TimelinePosition>()

/**
 * By environment as well as session: a server restored from a copy of
 * another's database holds the same session ids. Null on a host without
 * environments.
 */
const positionKey = (environmentId: string | null, sessionId: string) =>
  JSON.stringify([environmentId, sessionId])

export function rememberTimelinePosition(
  environmentId: string | null,
  sessionId: string,
  position: TimelinePosition,
): void {
  const key = positionKey(environmentId, sessionId)
  positions.delete(key)
  positions.set(key, position)
  if (positions.size > MAX_REMEMBERED_SESSIONS) {
    const oldest = positions.keys().next().value
    if (oldest !== undefined) positions.delete(oldest)
  }
}

export function recallTimelinePosition(
  environmentId: string | null,
  sessionId: string,
): TimelinePosition | undefined {
  return positions.get(positionKey(environmentId, sessionId))
}

export function forgetTimelinePositions(): void {
  positions.clear()
}

/**
 * Remembered heights in the shape the virtualizer takes as
 * `initialMeasurementsCache`. It seeds its size cache from each entry's `key`
 * and `size` and lays rows out itself, so the other fields are placeholders.
 * Only measured rows are included: a row listed here counts as measured, and
 * rows never measured must keep their first-measurement treatment.
 */
export function measurementsFromRememberedHeights(
  rowHeights: ReadonlyMap<string, number>,
): VirtualItem[] {
  return [...rowHeights].map(([key, size], index) => ({
    key,
    index,
    start: 0,
    end: size,
    size,
    lane: 0,
  }))
}
