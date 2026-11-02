/**
 * Which rows of the transcript are in the list at all.
 *
 * A list that has never drawn a row can only guess its height, and a chat's
 * rows differ by hundreds of times: from one line to a whole essay. Handed a
 * long thread, the list's guess for the rows it has not drawn swung by
 * hundreds of thousands of pixels, the end moved with every batch, and the
 * page chased it while mounting rows nobody was looking at.
 *
 * So the list holds the newest rows only, and older ones join it as the
 * reader nears the top of what it holds. Everything in it has been measured,
 * so its height is the truth and its end is the real end, and a page costs
 * the same to open at 20 rows as at 2000. What it costs is the text it holds,
 * not its rows (three long replies mount more than a hundred short lines), so
 * the window is measured in text. Joining rows keep the reader's place through
 * the list's visible-content anchoring.
 *
 * Rows never leave a mounted list: taking them off the top moves the scroll
 * offset twice over on Android (the view clamps it, then the anchoring applies
 * the same change again). A burst of new rows under a reader at the end opens
 * the list afresh at its tail instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ScrollMetrics } from './scroll-anchor'

/** The most rows a page opens with. */
export const TAIL_ROWS = 14
/** A page opens with this much text, about four screens: at least a prompt and its reply. */
export const TAIL_TEXT = 6000
const TAIL_MIN_ROWS = 2
/** The most rows that join at a time as the reader scrolls up. */
export const GROW_ROWS = 10
/** This much text joins at a time, at least one row. */
export const GROW_TEXT = 4000
/** Older rows join with this many screens still left above the reader. */
export const GROW_WITHIN_SCREENS = 2
/** This many rows arriving at once under a reader at the end open the list afresh. */
export const BURST_ROWS = 20

/** How much text the row at an index holds. */
type TextAt = (index: number) => number

/** Walks up from `from` until the rows passed hold `text`, or there are `maxRows` of them. */
function walkUp(from: number, textAt: TextAt, maxRows: number, text: number, minRows: number) {
  let start = from
  let held = 0
  while (start > 0 && from - start < maxRows && (held < text || from - start < minRows)) {
    start -= 1
    held += textAt(start)
  }
  return start
}

/** Where the window opening on `count` rows starts. */
export function tailStart(count: number, textAt: TextAt): number {
  return walkUp(count, textAt, TAIL_ROWS, TAIL_TEXT, TAIL_MIN_ROWS)
}

/** Where the list starts once the next rows join it. */
export function grownStart(start: number, textAt: TextAt): number {
  return walkUp(start, textAt, GROW_ROWS, GROW_TEXT, 1)
}

/**
 * Whether older rows should join. A reader who has left the end needs them
 * before they reach the top of the list. One at the end needs them only until
 * the page holds enough to scroll: rows short enough to fit it never produce a
 * scroll event, and with nothing to drag the older ones could not be reached.
 */
export function shouldGrow(
  start: number,
  { offset, contentHeight, viewportHeight }: ScrollMetrics,
  following: boolean,
): boolean {
  if (start === 0 || viewportHeight <= 0) return false
  const within = viewportHeight * GROW_WITHIN_SCREENS
  return following ? contentHeight < within : offset < within
}

/**
 * The transcript's window for the list. It is held by the key of its first
 * row, not an index: rows arriving, a row changing id, a snapshot replacing a
 * cached copy all leave it on the same row. `textOf` says how much text a row
 * holds, and `following` whether the reader is at the end.
 */
export function useTailWindow<T>(
  rows: T[],
  keyOf: (row: T) => string,
  textOf: (row: T) => number,
  following: () => boolean,
): {
  rows: T[]
  /** How many rows are above the window. */
  start: number
  /** Changes when the list should mount afresh, at the tail. */
  opening: number
  /** Where the reader is now: older rows join if they are near. */
  onReaderAt: (metrics: ScrollMetrics) => void
} {
  const [{ firstKey, opening }, setPlace] = useState<{ firstKey: string | null; opening: number }>({
    firstKey: null,
    opening: 0,
  })
  const lastStart = useRef(0)
  const lastCount = useRef(0)
  const held = useMemo(
    () => (firstKey === null ? -1 : rows.findIndex((row) => keyOf(row) === firstKey)),
    [firstKey, keyOf, rows],
  )

  let start = held
  if (rows.length > 0) {
    const tail = tailStart(rows.length, (index) => textOf(rows[index]!))
    // First rows, or the first row of the window is gone: the tail, or where
    // the window was if that holds more. Set during render, as React allows
    // for state derived from props: the list never mounts with the wrong rows.
    const lost = held === -1
    const burst = !lost && rows.length - lastCount.current >= BURST_ROWS && following()
    if (lost) start = firstKey === null ? tail : Math.min(lastStart.current, tail)
    else if (burst) start = tail
    if (start !== held) {
      setPlace({ firstKey: keyOf(rows[start]!), opening: burst ? opening + 1 : opening })
    }
  } else {
    start = 0
    // The list is gone (the page went behind another): it opens at the tail again.
    if (firstKey !== null) setPlace({ firstKey: null, opening })
  }

  useEffect(() => {
    lastStart.current = start
    lastCount.current = rows.length
  }, [rows.length, start])

  // One join per commit: the rows of the last one are not in the list yet.
  const joining = useRef(false)
  useEffect(() => {
    joining.current = false
  }, [start])
  const onReaderAt = useCallback(
    (metrics: ScrollMetrics) => {
      if (joining.current || !shouldGrow(start, metrics, following())) return
      joining.current = true
      const next = grownStart(start, (index) => textOf(rows[index]!))
      setPlace({ firstKey: keyOf(rows[next]!), opening })
    },
    [following, keyOf, opening, rows, start, textOf],
  )

  const windowed = useMemo(() => (start === 0 ? rows : rows.slice(start)), [rows, start])
  return { rows: windowed, start, opening, onReaderAt }
}
