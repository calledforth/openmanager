import { describe, expect, it } from 'vitest'
import type { ProviderLimits, ProviderLimitWindow } from '@openmanager/protocol'
import {
  formatResetsAt,
  formatUpdated,
  headlineWindow,
  limitsStatusLine,
  usageLevel,
} from '../src/lib/usage-limits-view'

const window = (patch: Partial<ProviderLimitWindow>): ProviderLimitWindow => ({
  id: 'five_hour',
  label: '5-hour',
  group: 'session',
  usedPercent: 37,
  resetsAt: null,
  status: null,
  ...patch,
})

const limits = (patch: Partial<ProviderLimits>): ProviderLimits => ({
  supported: true,
  reading: null,
  refreshing: false,
  lastRefresh: null,
  ...patch,
})

const NOW = Date.parse('2026-11-03T10:00:00.000Z')

describe('usage limits view', () => {
  it('grades a window by its percent, and by the provider’s own verdict', () => {
    expect(usageLevel(null)).toBe('unknown')
    expect(usageLevel(window({ usedPercent: null }))).toBe('unknown')
    expect(usageLevel(window({ usedPercent: 74 }))).toBe('normal')
    expect(usageLevel(window({ usedPercent: 75 }))).toBe('warning')
    expect(usageLevel(window({ usedPercent: 90 }))).toBe('critical')
    expect(usageLevel(window({ usedPercent: 20, status: 'warning' }))).toBe('warning')
    expect(usageLevel(window({ usedPercent: null, status: 'limited' }))).toBe('critical')
  })

  it('heads with the session window, else the fullest one', () => {
    const weekly = window({ id: 'seven_day', group: 'weekly', usedPercent: 80 })
    const fable = window({ id: 'model:Fable', group: 'weekly', usedPercent: 10 })
    const session = window({ usedPercent: 5 })
    expect(
      headlineWindow(
        limits({
          reading: { windows: [weekly, session], extraUsage: null, at: '2026-11-03T09:00:00Z' },
        }),
      ),
    ).toBe(session)
    expect(
      headlineWindow(
        limits({
          reading: { windows: [fable, weekly], extraUsage: null, at: '2026-11-03T09:00:00Z' },
        }),
      ),
    ).toBe(weekly)
    expect(headlineWindow(limits({}))).toBeNull()
    expect(headlineWindow(undefined)).toBeNull()
  })

  it('says when a window resets, in hours within a day', () => {
    expect(formatResetsAt(null, NOW)).toBeNull()
    expect(formatResetsAt('2026-11-03T09:59:00.000Z', NOW)).toBe('Resetting now')
    expect(formatResetsAt('2026-11-03T10:00:30.000Z', NOW)).toBe('Resets in under a minute')
    expect(formatResetsAt('2026-11-03T10:42:10.000Z', NOW)).toBe('Resets in 43m')
    expect(formatResetsAt('2026-11-03T12:14:00.000Z', NOW)).toBe('Resets in 2h 14m')
    expect(formatResetsAt('2026-11-03T13:00:00.000Z', NOW)).toBe('Resets in 3h')
    expect(formatResetsAt('2026-11-08T15:30:00.000Z', NOW)).toMatch(/^Resets \S+ /)
  })

  it('ages a reading', () => {
    expect(formatUpdated(undefined, NOW)).toBeNull()
    expect(formatUpdated('2026-11-03T09:59:30.000Z', NOW)).toBe('Updated just now')
    expect(formatUpdated('2026-11-03T09:56:00.000Z', NOW)).toBe('Updated 4m ago')
    expect(formatUpdated('2026-11-03T07:00:00.000Z', NOW)).toBe('Updated 3h ago')
  })

  it('explains a missing or stale reading', () => {
    const reading = { windows: [window({})], extraUsage: null, at: '2026-11-03T09:00:00Z' }
    expect(limitsStatusLine(limits({ refreshing: true }))).toBe('Reading usage…')
    expect(limitsStatusLine(limits({}))).toBe('Not read yet.')
    expect(
      limitsStatusLine(
        limits({ lastRefresh: { outcome: 'unavailable', at: '2026-11-03T09:00:00Z' } }),
      ),
    ).toBe('This account has no plan usage limits.')
    expect(
      limitsStatusLine(
        limits({ reading, lastRefresh: { outcome: 'failed', at: '2026-11-03T09:00:00Z' } }),
      ),
    ).toBe('Couldn’t refresh. Showing the last reading.')
    expect(
      limitsStatusLine(limits({ reading, lastRefresh: { outcome: 'ok', at: reading.at } })),
    ).toBeNull()
  })
})
