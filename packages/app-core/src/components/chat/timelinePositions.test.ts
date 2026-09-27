import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetTimelinePositions,
  measurementsFromRememberedHeights,
  recallTimelinePosition,
  rememberTimelinePosition,
  type TimelinePosition,
} from './timelinePositions'

const position = (anchorKey: string): TimelinePosition => ({
  atEnd: false,
  anchorKey,
  offsetWithinAnchor: 12,
  rowHeights: new Map(),
})

afterEach(() => forgetTimelinePositions())

describe('remembered timeline positions', () => {
  it('keeps the latest position per session', () => {
    rememberTimelinePosition('s1', position('a'))
    rememberTimelinePosition('s2', position('b'))
    rememberTimelinePosition('s1', position('c'))
    expect(recallTimelinePosition('s1')?.anchorKey).toBe('c')
    expect(recallTimelinePosition('s2')?.anchorKey).toBe('b')
    expect(recallTimelinePosition('s3')).toBeUndefined()
  })

  it('stays bounded, evicting the session left longest ago', () => {
    for (let i = 0; i <= 100; i += 1) rememberTimelinePosition(`s${i}`, position('a'))
    // Revisiting s1 makes it recent again, so s2 is the next to go.
    rememberTimelinePosition('s1', position('a'))
    rememberTimelinePosition('s101', position('a'))
    expect(recallTimelinePosition('s0')).toBeUndefined()
    expect(recallTimelinePosition('s2')).toBeUndefined()
    expect(recallTimelinePosition('s1')).toBeDefined()
    expect(recallTimelinePosition('s101')).toBeDefined()
  })
})

describe('measurementsFromRememberedHeights', () => {
  it('hands the virtualizer exactly the measured rows, keyed with their heights', () => {
    const measurements = measurementsFromRememberedHeights(
      new Map([
        ['a', 300],
        ['c', 50],
      ]),
    )
    expect(measurements.map(({ key, size }) => ({ key, size }))).toEqual([
      { key: 'a', size: 300 },
      { key: 'c', size: 50 },
    ])
  })
})
