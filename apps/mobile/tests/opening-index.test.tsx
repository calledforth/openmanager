// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useOpeningIndex } from '../src/session/useOpeningIndex'

/** What the list was mounted with: its `initialScrollIndex` is read once, at mount. */
const mounts: Array<number | undefined> = []

function List({ initialScrollIndex }: { initialScrollIndex: number | undefined }) {
  // Kept from the first render, as FlatList keeps its initial props.
  const [first] = useState(() => {
    mounts.push(initialScrollIndex)
    return initialScrollIndex
  })
  return <span data-index={String(first)} />
}

/** The page as SessionThread lays it out: an empty state until rows arrive, then the list. */
function Page({ count }: { count: number }) {
  const initialIndex = useOpeningIndex(count)
  return count === 0 ? <p>Opening…</p> : <List initialScrollIndex={initialIndex} />
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  mounts.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('where a live session opens', () => {
  it('mounts the list at its newest row when the snapshot lands after the page', async () => {
    // The live page mounts before its snapshot: no rows yet.
    await act(() => root.render(<Page count={0} />))
    expect(mounts).toEqual([])
    // The snapshot lands with 200 messages: the list mounts at the newest.
    await act(() => root.render(<Page count={200} />))
    expect(mounts).toEqual([199])
    // A new row later moves nothing.
    await act(() => root.render(<Page count={201} />))
    expect(mounts).toEqual([199])
    expect(container.querySelector('span')?.dataset.index).toBe('199')
  })

  it('draws a short thread from the top', async () => {
    await act(() => root.render(<Page count={0} />))
    await act(() => root.render(<Page count={3} />))
    expect(mounts).toEqual([undefined])
  })

  it('reads a transcript that is there from the first render', async () => {
    await act(() => root.render(<Page count={200} />))
    expect(mounts).toEqual([199])
  })
})
