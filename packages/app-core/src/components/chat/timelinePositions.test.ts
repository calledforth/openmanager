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
    rememberTimelinePosition('env-a', 's1', position('a'))
    rememberTimelinePosition('env-a', 's2', position('b'))
    rememberTimelinePosition('env-a', 's1', position('c'))
    expect(recallTimelinePosition('env-a', 's1')?.anchorKey).toBe('c')
    expect(recallTimelinePosition('env-a', 's2')?.anchorKey).toBe('b')
    expect(recallTimelinePosition('env-a', 's3')).toBeUndefined()
  })

  it('stays bounded, evicting the session left longest ago', () => {
    for (let i = 0; i <= 100; i += 1) rememberTimelinePosition('env-a', `s${i}`, position('a'))
    // Revisiting s1 makes it recent again, so s2 is the next to go.
    rememberTimelinePosition('env-a', 's1', position('a'))
    rememberTimelinePosition('env-a', 's101', position('a'))
    expect(recallTimelinePosition('env-a', 's0')).toBeUndefined()
    expect(recallTimelinePosition('env-a', 's2')).toBeUndefined()
    expect(recallTimelinePosition('env-a', 's1')).toBeDefined()
    expect(recallTimelinePosition('env-a', 's101')).toBeDefined()
  })

  it('keeps a session apart from one with the same id in another environment', () => {
    rememberTimelinePosition('env-a', 's1', position('a'))
    rememberTimelinePosition('env-b', 's1', position('b'))
    expect(recallTimelinePosition('env-a', 's1')?.anchorKey).toBe('a')
    expect(recallTimelinePosition('env-b', 's1')?.anchorKey).toBe('b')
    // A host without environments keeps its own.
    expect(recallTimelinePosition(null, 's1')).toBeUndefined()
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
