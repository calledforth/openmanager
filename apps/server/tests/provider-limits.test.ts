import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderLimitsReading } from '@openmanager/protocol/node'
import {
  createProviderLimits,
  openProviderLimitsStore,
  type ProviderLimitsStore,
  type UsageLimitsResult,
} from '../src/provider-limits.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const START = Date.parse('2026-11-03T10:00:00.000Z')

const FIVE_HOUR = {
  id: 'five_hour',
  label: '5-hour',
  group: 'session' as const,
  usedPercent: 37,
  resetsAt: '2026-11-03T14:20:00.000Z',
  status: null,
}

const OK: UsageLimitsResult = {
  outcome: 'ok',
  reading: { windows: [FIVE_HOUR], extraUsage: { enabled: false, usedPercent: null } },
}

function memoryStore(): ProviderLimitsStore & { saved: unknown[] } {
  const saved: unknown[] = []
  return {
    saved,
    load: () => new Map(),
    save: (providerId, reading, lastRefresh) => saved.push({ providerId, reading, lastRefresh }),
    close: () => undefined,
  }
}

function harness(
  read: (providerId: string) => Promise<UsageLimitsResult>,
  store: ProviderLimitsStore = memoryStore(),
) {
  let now = START
  const reads: string[] = []
  const service = createProviderLimits({
    providerIds: ['claude-code', 'cursor'],
    supports: (providerId) => providerId === 'claude-code',
    read: (providerId) => {
      reads.push(providerId)
      return read(providerId)
    },
    store,
    clock: () => now,
  })
  const events: unknown[] = []
  service.onChanged((event) => events.push(event.payload))
  return { service, reads, events, store, advance: (ms: number) => (now += ms) }
}

describe('provider limits', () => {
  it('reads once, publishes refreshing then the reading, and keeps it for the floor', async () => {
    const { service, reads, events, advance } = harness(async () => OK)
    expect(service.get('claude-code')).toEqual({
      supported: true,
      reading: null,
      refreshing: false,
      lastRefresh: null,
    })
    expect(service.refresh('claude-code', 0).refreshing).toBe(true)
    // A second ask while the read runs joins it.
    service.refresh('claude-code', 0)
    await service.idle()
    expect(reads).toEqual(['claude-code'])
    expect(service.get('claude-code')).toEqual({
      supported: true,
      reading: { ...OK.reading, at: '2026-11-03T10:00:00.000Z' },
      refreshing: false,
      lastRefresh: { outcome: 'ok', at: '2026-11-03T10:00:00.000Z' },
    })
    expect(events).toHaveLength(2)

    // Younger than a minute: kept, whatever the client asked.
    advance(30_000)
    service.refresh('claude-code', 0)
    expect(reads).toHaveLength(1)
    // Past the floor, an explicit ask reads again.
    advance(31_000)
    service.refresh('claude-code', 0)
    await service.idle()
    expect(reads).toHaveLength(2)
  })

  it('honours a client max age above the floor', async () => {
    const { service, reads, advance } = harness(async () => OK)
    service.refresh('claude-code')
    await service.idle()
    advance(2 * 60_000)
    service.refresh('claude-code', 10 * 60_000)
    expect(reads).toHaveLength(1)
    service.refresh('claude-code', 60_000)
    await service.idle()
    expect(reads).toHaveLength(2)
  })

  it('keeps the last reading when a read fails, and does not retry inside the floor', async () => {
    let fail = false
    const { service, reads, advance } = harness(async () => {
      if (fail) throw new Error('timeout')
      return OK
    })
    service.refresh('claude-code', 0)
    await service.idle()
    fail = true
    advance(61_000)
    service.refresh('claude-code', 0)
    await service.idle()
    const after = service.get('claude-code')
    expect(after.reading?.windows).toEqual([FIVE_HOUR])
    expect(after.lastRefresh).toEqual({ outcome: 'failed', at: '2026-11-03T10:01:01.000Z' })
    advance(10_000)
    service.refresh('claude-code', 0)
    expect(reads).toHaveLength(2)
  })

  it('clears the reading for an account without plan limits', async () => {
    let result: UsageLimitsResult = OK
    const { service, advance } = harness(async () => result)
    service.refresh('claude-code', 0)
    await service.idle()
    result = { outcome: 'unavailable' }
    advance(61_000)
    service.refresh('claude-code', 0)
    await service.idle()
    expect(service.get('claude-code')).toMatchObject({
      reading: null,
      lastRefresh: { outcome: 'unavailable' },
    })
  })

  it('never reads a provider without a limits route', async () => {
    const { service, reads } = harness(async () => OK)
    expect(service.refresh('cursor', 0)).toEqual({
      supported: false,
      reading: null,
      refreshing: false,
      lastRefresh: null,
    })
    await service.idle()
    expect(reads).toEqual([])
  })

  it('folds live observations into the reading and resets a rolled-over window', async () => {
    const { service, events } = harness(async () => OK)
    service.refresh('claude-code', 0)
    await service.idle()
    events.length = 0

    service.observe('claude-code', {
      windowId: 'five_hour',
      label: '5-hour',
      group: 'session',
      status: 'warning',
      resetsAt: FIVE_HOUR.resetsAt,
      usedPercentAtLeast: 80,
    })
    expect(service.get('claude-code').reading?.windows[0]).toMatchObject({
      usedPercent: 80,
      status: 'warning',
      resetsAt: FIVE_HOUR.resetsAt,
    })
    // The same word again changes nothing and publishes nothing.
    service.observe('claude-code', {
      windowId: 'five_hour',
      label: '5-hour',
      group: 'session',
      status: 'warning',
      resetsAt: FIVE_HOUR.resetsAt,
      usedPercentAtLeast: 80,
    })
    expect(events).toHaveLength(1)

    // A later reset is a new window: the old percent no longer applies.
    service.observe('claude-code', {
      windowId: 'five_hour',
      label: '5-hour',
      group: 'session',
      status: 'ok',
      resetsAt: '2026-11-03T19:20:00.000Z',
    })
    expect(service.get('claude-code').reading?.windows[0]).toMatchObject({
      usedPercent: null,
      status: 'ok',
      resetsAt: '2026-11-03T19:20:00.000Z',
    })

    // A window the last read did not list is added.
    service.observe('claude-code', {
      windowId: 'seven_day',
      label: 'Weekly · all models',
      group: 'weekly',
      status: 'limited',
      usedPercentAtLeast: 100,
    })
    expect(service.get('claude-code').reading?.windows.map((window) => window.id)).toEqual([
      'five_hour',
      'seven_day',
    ])
  })

  it('answers the refresh command with the current state and validates it', async () => {
    const { service } = harness(async () => OK)
    const answer = await service.dispatch({
      type: 'command',
      requestId: 'request-1',
      name: 'provider.limits.refresh',
      payload: { providerId: 'claude-code', maxAgeMs: 0 },
    } as never)
    expect(answer).toMatchObject({
      type: 'response',
      requestId: 'request-1',
      payload: { providerId: 'claude-code', limits: { supported: true, refreshing: true } },
    })
    await service.idle()
    expect(
      await service.dispatch({
        type: 'command',
        requestId: 'request-2',
        name: 'provider.limits.refresh',
        payload: { providerId: 'nobody' },
      } as never),
    ).toMatchObject({ type: 'error', error: { code: 'not_found' } })
    expect(
      await service.dispatch({
        type: 'command',
        requestId: 'request-3',
        name: 'provider.limits.refresh',
        payload: { providerId: 'claude-code', maxAgeMs: -1 },
      } as never),
    ).toMatchObject({ type: 'error', error: { code: 'validation' } })
    expect(service.dispatch({ name: 'provider.probe' } as never)).toBeUndefined()
  })

  it('survives a restart through the provider_limits table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-provider-limits-'))
    directories.push(directory)
    const first = openProviderLimitsStore(directory)
    const { service } = harness(async () => OK, first)
    service.refresh('claude-code', 0)
    await service.idle()
    first.close()

    const second = openProviderLimitsStore(directory)
    const restarted = createProviderLimits({
      providerIds: ['claude-code'],
      supports: () => true,
      read: async () => OK,
      store: second,
      clock: () => START,
    })
    const reading: ProviderLimitsReading = { ...OK.reading, at: '2026-11-03T10:00:00.000Z' }
    expect(restarted.get('claude-code')).toEqual({
      supported: true,
      reading,
      refreshing: false,
      lastRefresh: { outcome: 'ok', at: '2026-11-03T10:00:00.000Z' },
    })
    second.close()
  })
})
