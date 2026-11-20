import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderLimitsReading } from '@openmanager/protocol/node'
import {
  createProviderLimits,
  openProviderLimitsStore,
  UNAVAILABLE_REFRESH_MS,
  type LimitsHealth,
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

/** Provider health as the runtime reports it (`ProviderHealth`), cut to what
 * limits read; the extra fields are there to keep the shape honest. */
function health(
  options: {
    install?: LimitsHealth['install']['state']
    auth?: LimitsHealth['auth']['state']
    accountLabel?: string
    methodId?: string
  } = {},
): LimitsHealth {
  const install = options.install ?? 'installed'
  const auth =
    options.auth ?? (options.accountLabel || options.methodId ? 'authenticated' : 'unknown')
  return {
    install: {
      state: install,
      ...(install === 'installed' ? { command: 'claude', version: '2.1.309' } : {}),
    },
    auth: {
      state: auth,
      ...(options.methodId ? { methodId: options.methodId } : {}),
      ...(options.accountLabel ? { accountLabel: options.accountLabel } : {}),
    },
  } as LimitsHealth
}
const INSTALLED = health()

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
  service.observeHealth('claude-code', INSTALLED)
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

  // Codex (CAL-266): a full read names the plan and credits, and a live
  // update states the exact percent, which replaces the number.
  it('keeps a reading’s plan and credits, and takes an exact percent as it is', async () => {
    const codex: UsageLimitsResult = {
      outcome: 'ok',
      reading: {
        windows: [{ ...FIVE_HOUR, usedPercent: 100, status: 'limited' }],
        extraUsage: null,
        plan: 'Plus',
        credits: { hasCredits: true, unlimited: false, balance: '120' },
      },
    }
    const { service } = harness(async () => codex)
    service.refresh('claude-code', 0)
    await service.idle()
    expect(service.get('claude-code').reading).toMatchObject({
      plan: 'Plus',
      credits: { hasCredits: true, unlimited: false, balance: '120' },
    })

    // Lower than before in the same window (a reset credit spent, say): the
    // number is the number, and the refusal is over.
    service.observe('claude-code', {
      windowId: 'five_hour',
      label: '5-hour',
      group: 'session',
      resetsAt: FIVE_HOUR.resetsAt,
      usedPercent: 12,
    })
    const reading = service.get('claude-code').reading
    expect(reading?.windows[0]).toMatchObject({ usedPercent: 12, status: null })
    expect(reading).toMatchObject({ plan: 'Plus', credits: { balance: '120' } })
  })

  // Review: a missing CLI showed a card that could only fail, retried on every ask.
  it('shows no limits for a CLI confirmed missing, and reads none', async () => {
    const reads: string[] = []
    const service = createProviderLimits({
      providerIds: ['codex'],
      supports: () => true,
      read: async (providerId) => {
        reads.push(providerId)
        return OK
      },
      store: memoryStore(),
      clock: () => START,
    })
    // Health has not looked (or has no project to look in): shown, as before.
    expect(service.get('codex').supported).toBe(true)
    service.observeHealth('codex', health({ install: 'unknown' }))
    expect(service.get('codex').supported).toBe(true)

    service.observeHealth('codex', health({ install: 'missing' }))
    expect(service.get('codex').supported).toBe(false)
    service.refresh('codex', 0)
    // A probe that ran out of time says nothing: still hidden.
    service.observeHealth('codex', health({ install: 'unknown' }))
    expect(service.get('codex').supported).toBe(false)
    expect(reads).toEqual([])

    service.observeHealth('codex', health({ install: 'installed' }))
    expect(service.get('codex').supported).toBe(true)
    service.refresh('codex', 0)
    await service.idle()
    expect(reads).toEqual(['codex'])
  })

  it('hides a never-read provider whose CLI is unusable', () => {
    const service = createProviderLimits({
      providerIds: ['codex'],
      supports: () => true,
      read: async () => OK,
      store: memoryStore(),
      clock: () => START,
    })
    service.observeHealth('codex', health({ install: 'unusable' }))
    expect(service.get('codex').supported).toBe(false)
  })

  // Review: a handshake timeout, a slow probe or a CLI mid-update hid Claude's card.
  it('keeps the card of a provider that has been read through passing trouble', async () => {
    const { service, reads, advance } = harness(async () => OK)
    service.refresh('claude-code', 0)
    await service.idle()
    for (const install of ['unusable', 'unknown'] as const) {
      service.observeHealth('claude-code', health({ install }))
      expect(service.get('claude-code').supported).toBe(true)
    }
    advance(2 * 60_000)
    service.refresh('claude-code', 0)
    await service.idle()
    expect(reads).toHaveLength(2)
    // Gone for real: hidden.
    service.observeHealth('claude-code', health({ install: 'missing' }))
    expect(service.get('claude-code').supported).toBe(false)
  })

  it('drops the reading and reads again when the account changes', async () => {
    let result: UsageLimitsResult = OK
    const { service, reads, advance } = harness(async () => result)
    service.refresh('claude-code', 0)
    await service.idle()
    // What a Claude probe reports: the handshake's email as the account.
    service.observeHealth('claude-code', health({ accountLabel: 'ada@example.com' }))
    // A live session's sign-in names no account: the known one stands.
    service.observeHealth('claude-code', health({ methodId: 'claude-ai' }))
    service.observeHealth('claude-code', health({ accountLabel: 'ada@example.com' }))
    expect(reads).toHaveLength(1)
    expect(service.get('claude-code').reading).not.toBeNull()

    // Another account, seconds later: read at once, floor or not.
    advance(5_000)
    result = {
      outcome: 'ok',
      reading: { ...OK.reading, windows: [{ ...FIVE_HOUR, usedPercent: 3 }] },
    }
    service.observeHealth('claude-code', health({ accountLabel: 'grace@example.com' }))
    expect(service.get('claude-code')).toMatchObject({ reading: null, refreshing: true })
    await service.idle()
    expect(reads).toHaveLength(2)
    expect(service.get('claude-code').reading?.windows[0]?.usedPercent).toBe(3)

    // Signed out: the old account's numbers go, and the read says why.
    advance(5_000)
    result = { outcome: 'unavailable' }
    service.observeHealth('claude-code', health({ auth: 'unauthenticated' }))
    await service.idle()
    expect(reads).toHaveLength(3)
    expect(service.get('claude-code')).toMatchObject({
      reading: null,
      lastRefresh: { outcome: 'unavailable' },
    })
  })

  it('throws away a read the account changed under, and reads again', async () => {
    let release: (value: UsageLimitsResult) => void = () => undefined
    const { service, reads } = harness(
      () => new Promise<UsageLimitsResult>((resolve) => (release = resolve)),
    )
    service.observeHealth('claude-code', health({ accountLabel: 'ada@example.com' }))
    service.refresh('claude-code', 0)
    const first = release
    service.observeHealth('claude-code', health({ accountLabel: 'grace@example.com' }))
    first(OK)
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    // Still the old account's read until the new one answers.
    expect(service.get('claude-code').reading).toBeNull()
    release({
      outcome: 'ok',
      reading: { ...OK.reading, windows: [{ ...FIVE_HOUR, usedPercent: 9 }] },
    })
    await service.idle()
    expect(service.get('claude-code').reading?.windows[0]?.usedPercent).toBe(9)
  })

  // Review: an API-key account started a CLI on every ask more than a minute
  // apart; then, the hold that fixed it blocked the Refresh button.
  it('holds passive asks to their age, "no limits" for longer, and a deliberate refresh to a minute', async () => {
    const { service, reads, advance } = harness(async () => ({ outcome: 'unavailable' }))
    service.refresh('claude-code', 0)
    await service.idle()
    advance(2 * 60_000)
    // The sidebar and the Usage page: "no limits" stands for half an hour.
    service.refresh('claude-code', 10 * 60_000)
    service.refresh('claude-code', 60_000)
    service.refresh('claude-code')
    expect(reads).toHaveLength(1)
    // The Refresh button: once the minute is up, it reads.
    service.refresh('claude-code', 0)
    await service.idle()
    expect(reads).toHaveLength(2)
    advance(UNAVAILABLE_REFRESH_MS)
    service.refresh('claude-code', 10 * 60_000)
    await service.idle()
    expect(reads).toHaveLength(3)

    const failing = harness(async () => {
      throw new Error('no answer')
    })
    failing.service.refresh('claude-code', 0)
    await failing.service.idle()
    failing.advance(2 * 60_000)
    // The sidebar asks for ten minutes: a failure two minutes old stands.
    failing.service.refresh('claude-code', 10 * 60_000)
    expect(failing.reads).toHaveLength(1)
    // An explicit refresh still tries once the minute is up.
    failing.service.refresh('claude-code', 0)
    await failing.service.idle()
    expect(failing.reads).toHaveLength(2)
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
