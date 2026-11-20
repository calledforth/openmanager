import { afterEach, describe, expect, it, vi } from 'vitest'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import type { BackendEvent } from '../../backends/Backend.js'
import { InteractionBroker } from '../../core/InteractionBroker.js'
import { PermissionBroker } from '../../core/PermissionBroker.js'
import { codex } from '../../providers/codex.js'
import { providers } from '../../providers/index.js'
import { ProviderSessionRuntimeFactory } from '../ProviderRuntimeFactory.js'
import { codexPlanLabel, codexUsageReading, windowName } from './codex-usage-limits.js'
import { CodexProbeRuntime } from './CodexProbeRuntime.js'
import { CodexService } from './CodexService.js'
import { codexBuilders, fakeCodexStarter, type FakeCodexAppServer } from './testing/index.js'

const { buildAccountResponse, buildRateLimits } = codexBuilders

const services: CodexService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()))
})

function rateLimitsRead(
  overrides: Partial<v2.GetAccountRateLimitsResponse> = {},
): v2.GetAccountRateLimitsResponse {
  return {
    ordinaryUsageAllowed: true,
    rateLimits: buildRateLimits(),
    rateLimitsByLimitId: { codex: buildRateLimits() },
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
    ...overrides,
  }
}

/** A service and a probe on fakes; `setup` scripts each fake. */
function onFakes(setup?: (server: FakeCodexAppServer) => void) {
  const fakes = fakeCodexStarter(setup)
  const service = new CodexService({ providerId: 'codex', host: { log: vi.fn() }, start: fakes.start })
  services.push(service)
  const probe = new CodexProbeRuntime(
    { providerId: 'codex', cwd: '/work' },
    { config: codex, host: { log: vi.fn() }, service },
  )
  return { fakes, service, probe }
}

/** `resetsAt` as the fake builds it, back from the ISO the reading carries. */
const epochSeconds = (iso: string | null) => (iso ? Date.parse(iso) / 1000 : null)

describe('Codex usage limits: a full read', () => {
  it('reads the account, then the limits, on the service process, and maps the codex bucket', async () => {
    const credits = { hasCredits: true, unlimited: false, balance: '120' }
    const { fakes, probe } = onFakes((server) =>
      server.respond(
        'account/rateLimits/read',
        rateLimitsRead({ rateLimitsByLimitId: { codex: buildRateLimits({ credits }) } }),
      ),
    )
    const result = await probe.readUsageLimits()

    const methods = fakes.last.requests().map((request) => request.method)
    expect(methods).toEqual(['initialize', 'account/read', 'account/rateLimits/read'])
    expect(result.outcome).toBe('ok')
    if (result.outcome !== 'ok') return
    const snapshot = buildRateLimits()
    expect(result.reading).toEqual({
      windows: [
        {
          id: 'five_hour',
          label: '5-hour',
          group: 'session',
          usedPercent: 1,
          resetsAt: expect.any(String),
          status: null,
        },
        {
          id: 'seven_day',
          label: 'Weekly',
          group: 'weekly',
          usedPercent: 33,
          resetsAt: expect.any(String),
          status: null,
        },
      ],
      extraUsage: null,
      plan: 'Plus',
      credits,
    })
    // `resetsAt` is epoch seconds on the wire.
    expect(epochSeconds(result.reading.windows[0]!.resetsAt)).toBe(snapshot.primary!.resetsAt)
    expect(epochSeconds(result.reading.windows[1]!.resetsAt)).toBe(snapshot.secondary!.resetsAt)
  })

  it('uses only the codex bucket, whichever one the single-bucket view is', async () => {
    const other = buildRateLimits({
      limitId: 'codex_other',
      primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: null },
      secondary: null,
    })
    const { probe } = onFakes((server) =>
      server.respond(
        'account/rateLimits/read',
        rateLimitsRead({ rateLimits: other, rateLimitsByLimitId: { codex_other: other, codex: buildRateLimits() } }),
      ),
    )
    const result = await probe.readUsageLimits()
    expect(result.outcome === 'ok' && result.reading.windows.map((w) => w.usedPercent)).toEqual([1, 33])
  })

  it('names windows by their length, not their slot', async () => {
    // A plan whose only window is the weekly one, in the primary slot.
    const { probe } = onFakes((server) =>
      server.respond(
        'account/rateLimits/read',
        rateLimitsRead({
          rateLimitsByLimitId: {
            codex: buildRateLimits({
              primary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: null },
              secondary: null,
            }),
          },
        }),
      ),
    )
    const result = await probe.readUsageLimits()
    expect(result.outcome === 'ok' && result.reading.windows).toEqual([
      { id: 'seven_day', label: 'Weekly', group: 'weekly', usedPercent: 50, resetsAt: null, status: null },
    ])
  })

  it('marks a used-up window as limited', async () => {
    const { probe } = onFakes((server) =>
      server.respond(
        'account/rateLimits/read',
        rateLimitsRead({
          rateLimitsByLimitId: {
            codex: buildRateLimits({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null } }),
          },
        }),
      ),
    )
    const result = await probe.readUsageLimits()
    expect(result.outcome === 'ok' && result.reading.windows[0]).toMatchObject({
      usedPercent: 100,
      status: 'limited',
    })
  })

  it('has no limits for an API-key account, and does not ask for them', async () => {
    const { fakes, probe } = onFakes((server) =>
      server.respond('account/read', buildAccountResponse({ account: { type: 'apiKey' } })),
    )
    expect(await probe.readUsageLimits()).toEqual({ outcome: 'unavailable' })
    expect(fakes.last.requests('account/rateLimits/read')).toHaveLength(0)
  })

  // Review: a sign-in after "no sign-in needed" went unseen by limits.
  it('names a Codex that needs no sign-in, so signing in reads as another account', async () => {
    const { probe } = onFakes((server) =>
      server.respond('account/read', buildAccountResponse({ account: null, requiresOpenaiAuth: false })),
    )
    expect((await probe.probe()).accountLabel).toBe('No sign-in')
  })

  it('has no limits when no sign-in is needed', async () => {
    const { fakes, probe } = onFakes((server) =>
      server.respond('account/read', buildAccountResponse({ account: null, requiresOpenaiAuth: false })),
    )
    expect(await probe.readUsageLimits()).toEqual({ outcome: 'unavailable' })
    expect(fakes.last.requests('account/rateLimits/read')).toHaveLength(0)
  })

  // Review: a sign-out read as a failure, which keeps the old account's numbers up.
  it('has no limits when signed out, so the last login’s are not kept', async () => {
    const { fakes, probe } = onFakes((server) =>
      server.respond('account/read', buildAccountResponse({ account: null })),
    )
    expect(await probe.readUsageLimits()).toEqual({ outcome: 'unavailable' })
    expect(fakes.last.requests('account/rateLimits/read')).toHaveLength(0)
  })

  // Review: 100% read as "Limit reached" while credits kept turns going.
  it('is not limited at 100% while credits pay for turns', async () => {
    const used = { usedPercent: 100, windowDurationMins: 300, resetsAt: null }
    const read = (credits: v2.CreditsSnapshot | null) =>
      onFakes((server) =>
        server.respond(
          'account/rateLimits/read',
          rateLimitsRead({ rateLimitsByLimitId: { codex: buildRateLimits({ primary: used, credits }) } }),
        ),
      ).probe.readUsageLimits()
    const status = async (credits: v2.CreditsSnapshot | null) => {
      const result = await read(credits)
      return result.outcome === 'ok' ? result.reading.windows[0]?.status : undefined
    }
    expect(await status({ hasCredits: true, unlimited: false, balance: '40' })).toBeNull()
    expect(await status({ hasCredits: false, unlimited: true, balance: null })).toBeNull()
    expect(await status({ hasCredits: false, unlimited: false, balance: '0' })).toBe('limited')
    expect(await status(null)).toBe('limited')
  })

  // Review: two windows of one length shared an id (one React key, one meter updated).
  it('gives two windows of the same length ids of their own', async () => {
    const { probe } = onFakes((server) =>
      server.respond(
        'account/rateLimits/read',
        rateLimitsRead({
          rateLimitsByLimitId: {
            codex: buildRateLimits({
              primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
              secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
            }),
          },
        }),
      ),
    )
    const result = await probe.readUsageLimits()
    expect(result.outcome === 'ok' && result.reading.windows.map((w) => [w.id, w.label])).toEqual([
      ['five_hour', '5-hour'],
      ['five_hour:secondary', '5-hour · second'],
    ])
  })
})

describe('Codex usage limits: a session’s updates', () => {
  /** A Codex session built the way `AgentRuntime` builds one, beside the
   * service its updates are merged into. */
  async function session(service: CodexService) {
    const fakes = fakeCodexStarter((server) => server.serveThreads())
    const factory = new ProviderSessionRuntimeFactory({
      configs: providers,
      host: { log: vi.fn() },
      permissions: new PermissionBroker(),
      interactions: new InteractionBroker(),
      connections: () => {
        throw new Error('no ACP here')
      },
      codexStart: fakes.start,
      codexService: () => service,
    })
    const runtime = factory.create({ threadId: 'thread-1', providerId: 'codex', cwd: '/work' })
    const events: BackendEvent[] = []
    runtime.events((event) => events.push(event))
    await runtime.start()
    const limits = () => events.filter((event) => event.event === 'usage_limits_update').map((e) => e.data)
    return { fakes, runtime, limits }
  }

  it('merges a sparse update into the last full read and announces its windows', async () => {
    const { service, probe } = onFakes((server) =>
      server.respond('account/rateLimits/read', rateLimitsRead()),
    )
    await probe.readUsageLimits()
    const starts = service.status.starts
    const { fakes, runtime, limits } = await session(service)

    // Sparse: the window's length and reset, the plan and the credits are
    // left out. They are kept from the read.
    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({
        primary: { usedPercent: 40, windowDurationMins: null, resetsAt: null },
        secondary: null,
        planType: null,
        spendControlReached: null,
      }),
    })
    await vi.waitFor(() => expect(limits()).toHaveLength(1))
    const resetsAt = new Date(buildRateLimits().primary!.resetsAt! * 1000).toISOString()
    expect(limits()).toEqual([
      { windowId: 'five_hour', label: '5-hour', group: 'session', usedPercent: 40, resetsAt },
    ])
    expect(codexUsageReading(service.state)).toMatchObject({
      windows: [{ id: 'five_hour', usedPercent: 40, resetsAt }, { id: 'seven_day', usedPercent: 33 }],
      plan: 'Plus',
    })
    // Merging asks the service process nothing, so starts none.
    expect(service.status.starts).toBe(starts)
    await runtime.stop({ reason: 'disposed' })
  })

  it('ignores another bucket, which would otherwise overwrite the main one', async () => {
    const { service, probe } = onFakes((server) =>
      server.respond('account/rateLimits/read', rateLimitsRead()),
    )
    await probe.readUsageLimits()
    const { fakes, runtime, limits } = await session(service)

    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({
        limitId: 'codex_other',
        primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null },
      }),
    })
    // Then one for the main bucket, so there is something to wait for.
    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({ secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: null }, primary: null }),
    })
    await vi.waitFor(() => expect(limits()).toHaveLength(1))
    expect(limits()[0]).toMatchObject({ windowId: 'seven_day', usedPercent: 34 })
    expect(service.state.rateLimits?.primary?.usedPercent).toBe(1)
    expect(service.state.rateLimitsByLimitId?.codex_other?.primary?.usedPercent).toBe(99)
    await runtime.stop({ reason: 'disposed' })
  })

  it('announces two windows of the same length under their own ids', async () => {
    const { service } = onFakes()
    const { fakes, runtime, limits } = await session(service)
    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
      }),
    })
    await vi.waitFor(() => expect(limits()).toHaveLength(2))
    expect(limits().map((observation) => (observation as { windowId: string }).windowId)).toEqual([
      'five_hour',
      'five_hour:secondary',
    ])
    await runtime.stop({ reason: 'disposed' })
  })

  // Review: with credits, a used-up window must clear an earlier `limited`.
  it('says a used-up window is still usable while credits pay for turns', async () => {
    const { service } = onFakes()
    const { fakes, runtime, limits } = await session(service)
    const usedUp = { usedPercent: 100, windowDurationMins: 300, resetsAt: null }
    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({ primary: usedUp, secondary: null, credits: null }),
    })
    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({
        primary: usedUp,
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: '25' },
      }),
    })
    await vi.waitFor(() => expect(limits()).toHaveLength(2))
    expect(limits().map((observation) => (observation as { status?: string }).status)).toEqual([
      'limited',
      'ok',
    ])
    await runtime.stop({ reason: 'disposed' })
  })

  it('cannot name a window it never saw the length of, before any read', async () => {
    const { service } = onFakes()
    const { fakes, runtime, limits } = await session(service)
    fakes.last.notify('account/rateLimits/updated', {
      rateLimits: buildRateLimits({
        primary: { usedPercent: 5, windowDurationMins: null, resetsAt: null },
        secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: null },
      }),
    })
    await vi.waitFor(() => expect(limits()).toHaveLength(1))
    expect(limits()[0]).toMatchObject({ windowId: 'seven_day', usedPercent: 20 })
    // Nothing was started to hear it.
    expect(service.status.starts).toBe(0)
    await runtime.stop({ reason: 'disposed' })
  })
})

describe('Codex usage limits: names', () => {
  it('names the known lengths like Claude’s, and others by their length', () => {
    expect(windowName(300, 'primary')).toEqual({ id: 'five_hour', label: '5-hour', group: 'session' })
    expect(windowName(10_080, 'secondary')).toEqual({ id: 'seven_day', label: 'Weekly', group: 'weekly' })
    expect(windowName(60, 'primary')).toEqual({ id: 'window:60', label: '1-hour', group: 'session' })
    expect(windowName(43_200, 'secondary')).toEqual({ id: 'window:43200', label: '30-day', group: 'other' })
    expect(windowName(null, 'secondary')).toMatchObject({ id: 'secondary', group: 'other' })
  })

  it('labels plans, and leaves an unknown one out', () => {
    expect(codexPlanLabel('plus')).toBe('Plus')
    expect(codexPlanLabel('prolite')).toBe('Pro Lite')
    expect(codexPlanLabel('some_new_plan')).toBe('Some New Plan')
    expect(codexPlanLabel('unknown')).toBeUndefined()
    expect(codexPlanLabel(null)).toBeUndefined()
  })
})
