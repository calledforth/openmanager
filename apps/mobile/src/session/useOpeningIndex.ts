import { useState } from 'react'

import { openingIndex } from './scroll-anchor'

/**
 * The row the list starts drawing at, fixed when the transcript first has
 * rows. A live session's page mounts before its snapshot lands (with no
 * rows) and the list mounts with the snapshot, so the index is read then,
 * not when the page mounted; rows arriving later never move it.
 */
export function useOpeningIndex(count: number): number | undefined {
  const [opening, setOpening] = useState<{ index: number | undefined } | null>(null)
  if (opening === null && count > 0) {
    // Set during render, as React allows for state derived from props: the
    // list mounts in this same render with the index already known.
    const next = { index: openingIndex(count) }
    setOpening(next)
    return next.index
  }
  return opening?.index
}
