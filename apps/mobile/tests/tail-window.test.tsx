// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BURST_ROWS,
  GROW_ROWS,
  GROW_TEXT,
  grownStart,
  shouldGrow,
  TAIL_ROWS,
  TAIL_TEXT,
  tailStart,
  useTailWindow,
} from '../src/session/tail-window'

const row = (index: number) => `row-${index}`
const rowsOf = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => row(from + index))
const keyOf = (key: string) => key
/** Rows with next to no text: the row limits are what hold. */
const short = () => 1
/** A reader `offset` down a long list on an 800 pt screen. */
const at = (offset: number, contentHeight = 40000) => ({
  offset,
  contentHeight,
  viewportHeight: 800,
})

type View = ReturnType<typeof useTailWindow<string>>

let view: View
function Page({
  rows,
  following,
  textOf,
}: {
  rows: string[]
  following: boolean
  textOf: (row: string) => number
}) {
  view = useTailWindow(rows, keyOf, textOf, () => following)
  return null
}

let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

const show = (rows: string[], following = true, textOf: (row: string) => number = short) =>
  act(() => root.render(<Page rows={rows} following={following} textOf={textOf} />))

describe('the window arithmetic', () => {
  it('starts at the newest rows, and at the top of a short thread', () => {
    expect(tailStart(3, short)).toBe(0)
    expect(tailStart(TAIL_ROWS, short)).toBe(0)
    expect(tailStart(300, short)).toBe(300 - TAIL_ROWS)
  })

  it('stops at the text it can hold, keeping at least a prompt and its reply', () => {
    expect(tailStart(300, () => TAIL_TEXT / 3)).toBe(297)
    expect(tailStart(300, () => TAIL_TEXT * 4)).toBe(298)
  })

  it('grows toward the top and stops there', () => {
    expect(grownStart(GROW_ROWS + 5, short)).toBe(5)
    expect(grownStart(3, short)).toBe(0)
  })

  it('grows by the text it can hold, at least one row', () => {
    expect(grownStart(100, () => GROW_TEXT / 2)).toBe(98)
    expect(grownStart(100, () => GROW_TEXT * 4)).toBe(99)
  })

  it('grows only near the top of the list, and only with rows above it', () => {
    expect(shouldGrow(50, at(100), false)).toBe(true)
    expect(shouldGrow(50, at(5000), false)).toBe(false)
    expect(shouldGrow(0, at(100), false)).toBe(false)
  })

  it('leaves a reader at the end alone once the page holds enough to scroll', () => {
    expect(shouldGrow(50, at(1000, 1800), true)).toBe(false)
  })

  it('grows a page too short to scroll, where no scroll event will ever ask', () => {
    expect(shouldGrow(50, at(0, 300), true)).toBe(true)
    expect(shouldGrow(0, at(0, 300), true)).toBe(false)
  })

  it('waits for a measured viewport', () => {
    expect(shouldGrow(50, { offset: 0, contentHeight: -1, viewportHeight: -1 }, true)).toBe(false)
  })
})

describe('the transcript window', () => {
  it('holds a short thread whole, as the same list', () => {
    const rows = rowsOf(5)
    show(rows)
    expect(view.rows).toBe(rows)
    expect(view.start).toBe(0)
  })

  it('opens a long thread with its newest rows only, from the first render with rows', () => {
    show([])
    expect(view.rows).toEqual([])
    show(rowsOf(300))
    expect(view.rows).toHaveLength(TAIL_ROWS)
    expect(view.rows.at(-1)).toBe(row(299))
  })

  it('opens a chat of long replies with less of it', () => {
    show(rowsOf(300), true, () => TAIL_TEXT)
    expect(view.rows).toHaveLength(2)
  })

  it('takes new rows at the end without moving its first row', () => {
    show(rowsOf(300))
    const first = view.rows[0]
    show(rowsOf(303))
    expect(view.rows[0]).toBe(first)
    expect(view.rows.at(-1)).toBe(row(302))
  })

  it('takes older rows when the reader nears them, one join per commit', () => {
    const rows = rowsOf(300)
    show(rows, false)
    act(() => {
      view.onReaderAt(at(100))
      view.onReaderAt(at(100))
    })
    expect(view.rows).toHaveLength(TAIL_ROWS + GROW_ROWS)
    act(() => view.onReaderAt(at(100)))
    expect(view.rows).toHaveLength(TAIL_ROWS + 2 * GROW_ROWS)
  })

  it('takes nothing while the reader is far from the top of the list', () => {
    show(rowsOf(300), false)
    act(() => view.onReaderAt(at(5000)))
    expect(view.rows).toHaveLength(TAIL_ROWS)
  })

  it('reaches the first row of the thread and stops', () => {
    show(rowsOf(TAIL_ROWS + 3), false)
    act(() => view.onReaderAt(at(0)))
    expect(view.start).toBe(0)
    act(() => view.onReaderAt(at(0)))
    expect(view.start).toBe(0)
  })

  it('never takes rows off a mounted list as new ones arrive', () => {
    show(rowsOf(300), false)
    for (let join = 0; join < 5; join += 1) act(() => view.onReaderAt(at(0)))
    const read = view.rows.length
    show(rowsOf(301), true)
    expect(view.rows.length).toBe(read + 1)
    expect(view.opening).toBe(0)
  })

  it('opens afresh at the tail for a burst under a reader at the end', () => {
    show(rowsOf(50))
    show(rowsOf(50 + BURST_ROWS))
    expect(view.rows).toHaveLength(TAIL_ROWS)
    expect(view.rows.at(-1)).toBe(row(69))
    expect(view.opening).toBe(1)
  })

  it('leaves a reader who scrolled up where they are through a burst', () => {
    show(rowsOf(50), false)
    const first = view.rows[0]
    show(rowsOf(50 + BURST_ROWS), false)
    expect(view.rows[0]).toBe(first)
    expect(view.opening).toBe(0)
  })

  it('opens at the tail again after the rows went away', () => {
    show(rowsOf(300), false)
    for (let join = 0; join < 3; join += 1) act(() => view.onReaderAt(at(0)))
    show([])
    expect(view.rows).toEqual([])
    show(rowsOf(300))
    expect(view.rows).toHaveLength(TAIL_ROWS)
  })

  it('finds its place again when the rows are replaced', () => {
    show(rowsOf(300))
    show(rowsOf(40, 1000))
    expect(view.rows.at(-1)).toBe(row(1039))
    expect(view.rows).toHaveLength(TAIL_ROWS)
  })
})
