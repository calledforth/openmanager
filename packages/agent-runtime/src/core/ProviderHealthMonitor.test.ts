import type { ModelListing, ProviderId, ProviderSessionInfo } from '@agentpack/contract'
import {
  deriveProviderUiStatus,
  summarizeProviderHealth,
  type ProviderHealth,
} from '@openmanager/shared/contracts/provider-health'
import { describe, expect, it, vi } from 'vitest'
import type { ProbeResult, ProbeRuntime, ProbeRuntimeFactory } from '../session/ProbeRuntime.js'
import type { SessionRuntimeExit } from '../session/lifecycle.js'
import { AuthRequiredError } from './errors.js'
import { ProviderHealthMonitor, type ProviderRuntimeCensus } from './ProviderHealthMonitor.js'

const HEALTHY: ProbeResult = {
  agentInfo: { name: 'cursor-agent', version: '2026.07.23' },
  authMethods: [],
  authenticated: true,
  sessionListAdvertised: true,
  loadSessionAdvertised: true,
}

class FakeProbe implements ProbeRuntime {
  disposed = 0
  constructor(
    readonly providerId: ProviderId,
    readonly cwd: string,
    private readonly answer: () => Promise<ProbeResult>,
  ) {}
  probe(): Promise<ProbeResult> {
    return this.answer()
  }
  listSessions(): Promise<ProviderSessionInfo[]> {
    throw new Error('a health probe never lists sessions')
  }
  listModels(): Promise<ModelListing> {
    throw new Error('a health probe never spends a session/new on the catalog')
  }
  async dispose(): Promise<void> {
    this.disposed += 1
  }
}

class FakeProbeFactory implements ProbeRuntimeFactory {
  readonly created: FakeProbe[] = []
  /** Per-provider answer; defaults to a healthy Cursor handshake. */
  readonly answers = new Map<ProviderId, () => Promise<ProbeResult>>()

  create(providerId: ProviderId, cwd: string): ProbeRuntime {
    const answer = this.answers.get(providerId) ?? (async () => HEALTHY)
    const probe = new FakeProbe(providerId, cwd, answer)
    this.created.push(probe)
    return probe
  }
  countFor(providerId: ProviderId): number {
    return this.created.filter((probe) => probe.providerId === providerId).length
  }
}

const NOTHING_RUNNING: ProviderRuntimeCensus = {
  liveProcesses: 0,
  readyProcesses: 0,
  activeTurns: 0,
}

function build(
  options: {
    census?: Partial<Record<ProviderId, ProviderRuntimeCensus>>
    probeTimeoutMs?: number
    /** Present-but-undefined means "no workspace is known yet". */
    cwd?: string | undefined
  } = {},
) {
  const probes = new FakeProbeFactory()
  const census: Partial<Record<ProviderId, ProviderRuntimeCensus>> = options.census ?? {}
  const scheduled: Array<{ run: () => void; ms: number }> = []
  // Advances a second per read, so ordering between observations is
  // well-defined without depending on the wall clock.
  const clock = { value: 1_000_000_000 }
  const now = (): number => (clock.value += 1_000)
  const monitor = new ProviderHealthMonitor({
    providerIds: ['cursor', 'opencode'],
    probes,
    census: (providerId) => census[providerId] ?? NOTHING_RUNNING,
    probeCwd: () => ('cwd' in options ? options.cwd : 'C:/workspace'),
    host: { log: vi.fn() },
    now,
    schedule: (run, ms) => {
      scheduled.push({ run, ms })
      return { cancel: () => undefined }
    },
    ...(options.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
  })
  /** UI status read against the same clock the monitor stamps with. */
  const ui = (providerId: ProviderId): string =>
    deriveProviderUiStatus(monitor.report(providerId), clock.value)
  return { monitor, probes, census, scheduled, ui }
}

function unexpectedExit(): SessionRuntimeExit {
  return {
    expected: false,
    exitCode: 1,
    signal: null,
    forced: false,
    at: new Date().toISOString(),
  }
}

describe('ProviderHealthMonitor axes', () => {
  it('starts with nothing known rather than nothing wrong', () => {
    const { monitor, ui } = build()
    const health = monitor.health('cursor')
    expect(health.install.state).toBe('unknown')
    expect(health.auth.state).toBe('unknown')
    expect(health.runtime.state).toBe('never_started')
    expect(health.lastProbe).toBeNull()
    expect(ui('cursor')).toBe('unknown')
  })

  it('records install, auth and probe axes from one successful probe', async () => {
    const { monitor, ui } = build()
    await monitor.refresh('cursor', 'user')
    const health = monitor.health('cursor')
    expect(health.install).toMatchObject({ state: 'installed', version: '2026.07.23' })
    expect(health.auth.state).toBe('authenticated')
    expect(health.lastProbe?.outcome).toBe('ok')
    // Installed and signed in with no session open is ready, not "stopped" —
    // this is the launch-time case that used to render as "Unavailable".
    expect(health.runtime.state).toBe('never_started')
    expect(summarizeProviderHealth(health)).toBe('ready')
    expect(ui('cursor')).toBe('ready')
  })

  it('reports a missing binary without claiming anything about auth', async () => {
    const { monitor, probes, ui } = build()
    probes.answers.set('cursor', async () => {
      throw Object.assign(new Error('spawn cursor-agent ENOENT'), { code: 'ENOENT' })
    })
    await monitor.refresh('cursor', 'user')
    const health = monitor.health('cursor')
    expect(health.install.state).toBe('missing')
    // A binary that never ran cannot have told us anything about credentials.
    expect(health.auth.state).toBe('unknown')
    expect(ui('cursor')).toBe('binary_missing')
  })

  it('separates "the CLI is broken" from "the CLI is not installed"', async () => {
    const { monitor, probes, ui } = build()
    probes.answers.set('cursor', async () => {
      throw new Error('cursor exited during startup (code 1, signal none)')
    })
    await monitor.refresh('cursor', 'user')
    expect(monitor.health('cursor').install.state).toBe('unusable')
    expect(ui('cursor')).toBe('failed')
  })

  it('reports an auth refusal as installed-but-unauthenticated, with the login hint', async () => {
    const { monitor, probes, ui } = build()
    probes.answers.set('cursor', async () => {
      throw new AuthRequiredError('cursor', 'not signed in', 'Sign in to Cursor and retry.')
    })
    await monitor.refresh('cursor', 'user')
    const health = monitor.health('cursor')
    expect(health.install.state).toBe('installed')
    expect(health.auth).toMatchObject({
      state: 'unauthenticated',
      loginHint: 'Sign in to Cursor and retry.',
    })
    expect(ui('cursor')).toBe('auth_required')
  })

  it('leaves every axis unknown when a probe times out, and kills its process', async () => {
    const { monitor, probes } = build({ probeTimeoutMs: 10 })
    probes.answers.set('cursor', () => new Promise<ProbeResult>(() => undefined))
    await monitor.refresh('cursor', 'user')
    const health = monitor.health('cursor')
    expect(health.lastProbe?.outcome).toBe('timeout')
    expect(health.install.state).toBe('unknown')
    expect(health.auth.state).toBe('unknown')
    expect(probes.created[0]?.disposed).toBe(1)
    // A hung CLI must not wedge the loop: the next provider still gets probed.
    await monitor.refresh('opencode', 'user')
    expect(monitor.health('opencode').lastProbe?.outcome).toBe('ok')
  })

  it('takes the model catalog from a session response instead of spending a probe on it', () => {
    const { monitor, probes } = build()
    monitor.observeModels('cursor', {
      availableModels: [{ id: 'composer-2.5', displayName: 'Composer 2.5' }],
    })
    expect(monitor.health('cursor').models.models).toEqual([
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
    ])
    expect(monitor.health('cursor').models.refreshedAt).not.toBeNull()
    expect(probes.created).toHaveLength(0)
  })

  it('never claims a version advisory it has no registry for', async () => {
    const { monitor } = build()
    await monitor.refresh('cursor', 'user')
    expect(monitor.health('cursor').update.state).toBe('unknown')
  })
})

describe('ProviderHealthMonitor runtime rollup', () => {
  it('stops reading healthy once the process is gone', async () => {
    const { monitor, census, ui } = build()
    census.cursor = { liveProcesses: 1, readyProcesses: 1, activeTurns: 0 }
    await monitor.refresh('cursor', 'user')
    monitor.observeRuntimeStarted('cursor')
    expect(monitor.health('cursor').runtime.state).toBe('running')
    expect(ui('cursor')).toBe('ready')

    // The registry drops the entry in the same tick the child dies.
    census.cursor = NOTHING_RUNNING
    monitor.observeRuntimeExit('cursor', 'thread-1', unexpectedExit())

    const health = monitor.health('cursor')
    expect(health.runtime.state).toBe('failed')
    expect(health.runtime.liveProcesses).toBe(0)
    expect(health.runtime.lastUnexpectedExit).toMatchObject({ threadId: 'thread-1', exitCode: 1 })
    expect(summarizeProviderHealth(health)).toBe('error')
    expect(ui('cursor')).toBe('failed')
  })

  it('does not mark the whole provider dead when one of several sessions exits', async () => {
    const { monitor, census, ui } = build()
    census.cursor = { liveProcesses: 3, readyProcesses: 3, activeTurns: 1 }
    await monitor.refresh('cursor', 'user')
    monitor.observeRuntimeStarted('cursor')

    census.cursor = { liveProcesses: 2, readyProcesses: 2, activeTurns: 1 }
    monitor.observeRuntimeExit('cursor', 'thread-3', unexpectedExit())

    const health = monitor.health('cursor')
    expect(health.runtime.state).toBe('degraded')
    expect(health.runtime.liveProcesses).toBe(2)
    expect(health.runtime.activeTurns).toBe(1)
    expect(ui('cursor')).toBe('degraded')
  })

  it('tells "never started" apart from "failed to start"', () => {
    const { monitor } = build()
    expect(monitor.health('cursor').runtime.state).toBe('never_started')
    monitor.observeRuntimeStartFailed('cursor', 'spawn cursor-agent ENOENT')
    expect(monitor.health('cursor').runtime.state).toBe('failed')
  })

  it('treats an exit somebody asked for as stopped, not failed', () => {
    const { monitor } = build()
    monitor.observeRuntimeStarted('cursor')
    monitor.observeRuntimeExit('cursor', 'thread-1', {
      expected: true,
      reason: 'disposed',
      exitCode: 0,
      signal: 'SIGTERM',
      forced: false,
      at: new Date().toISOString(),
    })
    expect(monitor.health('cursor').runtime.state).toBe('stopped')
  })

  it('lets a later successful start clear an earlier crash', () => {
    const { monitor, census } = build()
    monitor.observeRuntimeStarted('cursor')
    monitor.observeRuntimeExit('cursor', 'thread-1', unexpectedExit())
    expect(monitor.health('cursor').runtime.state).toBe('failed')

    census.cursor = { liveProcesses: 1, readyProcesses: 1, activeTurns: 0 }
    monitor.observeRuntimeStarted('cursor')
    expect(monitor.health('cursor').runtime.state).toBe('running')
  })
})

describe('ProviderHealthMonitor refresh policy', () => {
  it('joins concurrent triggers instead of stacking probes', async () => {
    const { monitor, probes } = build()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    probes.answers.set('cursor', async () => {
      await gate
      return HEALTHY
    })

    const first = monitor.refresh('cursor', 'user')
    const second = monitor.refresh('cursor', 'user')
    const third = monitor.refresh('cursor', 'interval')
    expect(monitor.report('cursor').refreshing).toBe(true)
    release?.()
    await Promise.all([first, second, third])
    expect(probes.countFor('cursor')).toBe(1)
  })

  it('never holds two CLI processes at once', async () => {
    const { monitor, probes } = build()
    let live = 0
    let peak = 0
    const slow = async (): Promise<ProbeResult> => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      live -= 1
      return HEALTHY
    }
    probes.answers.set('cursor', slow)
    probes.answers.set('opencode', slow)

    await Promise.all([monitor.refresh('cursor', 'user'), monitor.refresh('opencode', 'user')])
    expect(peak).toBe(1)
    expect(probes.created).toHaveLength(2)
  })

  it('derives from a live session instead of spawning a probe on the timer', async () => {
    const { monitor, probes, census } = build()
    census.cursor = { liveProcesses: 1, readyProcesses: 1, activeTurns: 0 }
    await monitor.refresh('cursor', 'user')
    monitor.observeRuntimeStarted('cursor')
    expect(probes.countFor('cursor')).toBe(1)

    const before = monitor.health('cursor').lastProbe
    await monitor.refresh('cursor', 'interval')
    const after = monitor.health('cursor').lastProbe
    expect(probes.countFor('cursor')).toBe(1)
    expect(after?.message).toMatch(/no probe was spawned/)
    expect(after?.at).not.toBe(before?.at)
  })

  it('still probes on an explicit user retry, even with a live session', async () => {
    const { monitor, probes, census } = build()
    census.cursor = { liveProcesses: 1, readyProcesses: 1, activeTurns: 0 }
    await monitor.refresh('cursor', 'user')
    expect(probes.countFor('cursor')).toBe(1)
    await monitor.refresh('cursor', 'user')
    expect(probes.countFor('cursor')).toBe(2)
  })

  it('declines to probe rather than guess a directory', async () => {
    const { monitor, probes } = build({ cwd: undefined })
    await monitor.refresh('cursor', 'user')
    expect(probes.created).toHaveLength(0)
    expect(monitor.health('cursor').install.state).toBe('unknown')
  })

  it('probes every provider on boot and re-probes on the interval', async () => {
    const { monitor, probes, scheduled } = build()
    monitor.start()
    await vi.waitFor(() => {
      expect(probes.created).toHaveLength(2)
      expect(monitor.report('cursor').refreshing).toBe(false)
      expect(monitor.report('opencode').refreshing).toBe(false)
    })
    expect(scheduled[0]?.ms).toBe(5 * 60 * 1000)

    scheduled[0]?.run()
    await vi.waitFor(() => expect(probes.created).toHaveLength(4))
    monitor.stop()
  })

  it('does not spawn its own probe while the bootstrap is running one', async () => {
    const { monitor, probes } = build()
    const recorder = monitor.beginProbe('cursor')
    expect(monitor.report('cursor').refreshing).toBe(true)
    await monitor.refresh('cursor', 'interval')
    expect(probes.created).toHaveLength(0)

    recorder.ok(HEALTHY)
    expect(monitor.report('cursor').refreshing).toBe(false)
    expect(monitor.health('cursor').install.state).toBe('installed')
    expect(monitor.health('cursor').lastProbe?.outcome).toBe('ok')
  })

  it('publishes every change to subscribers', async () => {
    const { monitor } = build()
    const seen: string[] = []
    monitor.onChange((providerId, report) =>
      seen.push(`${providerId}:${report.health.install.state}:${report.refreshing}`),
    )
    await monitor.refresh('cursor', 'user')
    expect(seen[0]).toBe('cursor:unknown:true')
    expect(seen.at(-1)).toBe('cursor:installed:false')
  })
})

describe('ProviderHealthMonitor boot cache', () => {
  const CACHED: ProviderHealth = {
    install: { state: 'installed', version: '2026.07.01' },
    auth: { state: 'authenticated' },
    // The cache writer strips liveness; assert the monitor rebuilds the
    // runtime axis from the live census whatever it is handed.
    runtime: { state: 'running', liveProcesses: 4, activeTurns: 2 },
    models: { models: [{ id: 'composer-2.5', displayName: 'Composer 2.5' }], refreshedAt: null },
    lastProbe: { outcome: 'ok', at: new Date(0).toISOString(), durationMs: 800 },
    update: { state: 'unknown' },
  }

  it('renders the previous run without claiming a live process', () => {
    const { monitor } = build()
    monitor.hydrate({ cursor: CACHED })
    const health = monitor.health('cursor')
    expect(health.install.version).toBe('2026.07.01')
    expect(health.models.models).toHaveLength(1)
    expect(health.runtime.state).toBe('never_started')
    expect(health.runtime.liveProcesses).toBe(0)
  })

  it('shows a restored snapshot as being checked, not as current truth', () => {
    const { monitor, ui } = build()
    monitor.hydrate({ cursor: CACHED })
    // The 1970 probe is far outside the staleness window.
    expect(ui('cursor')).toBe('unknown')
    monitor.beginProbe('cursor')
    expect(ui('cursor')).toBe('probing')
  })

  it('is superseded by the first fresh probe', async () => {
    const { monitor, ui } = build()
    monitor.hydrate({ cursor: CACHED })
    await monitor.refresh('cursor', 'boot')
    expect(monitor.health('cursor').install.version).toBe('2026.07.23')
    expect(ui('cursor')).toBe('ready')
  })
})
