import type { ModelListing, ProviderId } from '@agentpack/contract'
import {
  UNPROBED_PROVIDER_HEALTH,
  type ProviderAuthHealth,
  type ProviderExitInfo,
  type ProviderHealth,
  type ProviderHealthReport,
  type ProviderInstallHealth,
  type ProviderModelSummary,
  type ProviderProbe,
  type ProviderRuntimeHealth,
  type ProviderRuntimeState,
} from '@openmanager/shared/contracts/provider-health'
import type {
  AcpProbeResult,
  AcpProbeRuntime,
  AcpProbeRuntimeFactory,
} from '../session/AcpProbeRuntime.js'
import type { SessionRuntimeExit } from '../session/lifecycle.js'
import { withTimeout } from '../session/timeout.js'
import { AuthRequiredError } from './errors.js'
import type { HostDeps } from '../host.js'

/** Re-probe cadence. Matches the reference architecture's 5 minutes: long
 * enough that the ~141 MB of a throwaway CLI process is not a standing cost,
 * short enough that a snapshot is never more than one interval behind. */
export const PROVIDER_HEALTH_REFRESH_INTERVAL_MS = 5 * 60 * 1000

/** Whole-probe budget: spawn + `initialize` + `authenticate`. Cursor's
 * measured cold path is 2.2s + 2.2s + 4.5s ≈ 9s, so 30s is roughly 3x
 * headroom. A probe that blows this is reported as `'timeout'` and its
 * process is killed; the loop is never wedged by one hung CLI. */
export const PROVIDER_HEALTH_PROBE_TIMEOUT_MS = 30_000

/** What the monitor needs to know about live session runtimes. Counted from
 * the registry at read time, never cached: the registry drops an entry in the
 * same tick its process dies, so these numbers cannot describe a dead
 * process. This is the read side of the latch bug's fix. */
export type ProviderRuntimeCensus = {
  /** Child processes alive right now, in any phase before `'exited'`. */
  liveProcesses: number
  /** Of those, ones that completed `start()` and hold an ACP session. */
  readyProcesses: number
  /** Runtimes with a prompt in flight. */
  activeTurns: number
}

export type ProviderHealthMonitorDeps = {
  providerIds: readonly ProviderId[]
  probes: AcpProbeRuntimeFactory
  /** Live-runtime rollup for one provider, read fresh on every use. */
  census: (providerId: ProviderId) => ProviderRuntimeCensus
  /** Where a throwaway probe should be spawned. `undefined` means we have no
   * real directory yet, and the monitor declines to probe rather than guess —
   * the axes stay `'unknown'`, which is the honest reading. */
  probeCwd: (providerId: ProviderId) => string | undefined
  host: Pick<HostDeps, 'log'>
  refreshIntervalMs?: number
  probeTimeoutMs?: number
  /** Injected in tests so probe timestamps and staleness are deterministic. */
  now?: () => number
  /** Injected in tests to avoid a real interval timer. */
  schedule?: (run: () => void, ms: number) => { cancel: () => void }
}

/** Handle for a probe the monitor did not run itself. Exactly one of the two
 * methods must be called; the second call is ignored. */
export type ProviderProbeRecorder = {
  ok: (result: AcpProbeResult) => void
  failed: (error: unknown) => void
}

export type ProviderHealthRefreshReason =
  | 'boot'
  | 'interval'
  /** The user pressed Retry, or `agent:ensure` ran. Always probes. */
  | 'user'

type ProviderRecord = {
  install: ProviderInstallHealth
  auth: ProviderAuthHealth
  models: { models: readonly ProviderModelSummary[]; refreshedAt: string | null }
  lastProbe: ProviderProbe | null
  /** Sequence number of the newest observation saying this provider works: a
   * successful probe, or a session runtime that reached `ready`. Deliberately
   * a counter and not a timestamp — `Date.now()` has millisecond resolution,
   * and a process that crashes in the same millisecond it started would
   * otherwise compare as "no failure since the last success". */
  healthySeq: number
  /** Sequence number of the newest observation saying it does not: an
   * unexpected process exit, a start failure, or a failed probe. */
  unhealthySeq: number
  lastUnexpectedExit: ProviderExitInfo | undefined
  runtimeMessage: string | undefined
  startedEver: boolean
}

function emptyRecord(): ProviderRecord {
  return {
    install: { ...UNPROBED_PROVIDER_HEALTH.install },
    auth: { ...UNPROBED_PROVIDER_HEALTH.auth },
    models: { models: [], refreshedAt: null },
    lastProbe: null,
    healthySeq: 0,
    unhealthySeq: 0,
    lastUnexpectedExit: undefined,
    runtimeMessage: undefined,
    startedEver: false,
  }
}

/** Provider health as a continuously-refreshed snapshot with an age.
 *
 * Three sources feed it, in decreasing order of cost:
 *
 *  1. **Live runtimes, for free.** Every wire response a session runtime gets
 *     is an observation of the same CLI a probe would spawn. A runtime that
 *     reached `ready` proves the binary exists, runs, and authenticated; its
 *     `session/new` response carries the model catalog. `observeInitialized`,
 *     `observeAuthenticated` and friends record those.
 *  2. **The registry census, for free.** Live process and active turn counts,
 *     read at snapshot time.
 *  3. **A throwaway probe, at ~141 MB and several seconds.** Only when 1 and 2
 *     cannot answer, or when the user explicitly asked.
 *
 * Probes are serialised globally by a one-slot queue: two providers never
 * spawn CLIs at the same time, and a second request for a provider already
 * being probed joins the in-flight probe instead of stacking another. */
export class ProviderHealthMonitor {
  private readonly records = new Map<ProviderId, ProviderRecord>()
  private readonly inFlight = new Map<ProviderId, Promise<ProviderHealth>>()
  /** Adopted probes still open, per provider (see `beginProbe`).
   *
   * A set of *providers* was not enough: with two adopted probes open at once
   * — concurrent startup and a Retry, which is not rare — the first to settle
   * removed the provider's marker and the second found nothing to remove and
   * discarded its own result. A failure arriving after a success therefore
   * vanished and health went on reporting the older, better answer. Identity
   * per recorder makes every observation count exactly once. */
  private readonly external = new Map<ProviderId, Set<object>>()
  private readonly listeners = new Set<
    (providerId: ProviderId, report: ProviderHealthReport) => void
  >()
  private readonly refreshIntervalMs: number
  private readonly probeTimeoutMs: number
  private readonly now: () => number
  private readonly schedule: (run: () => void, ms: number) => { cancel: () => void }
  private timer: { cancel: () => void } | undefined
  /** The one-slot probe queue. Never two CLI processes at once. */
  private queue: Promise<void> = Promise.resolve()
  /** Strictly increasing, so two observations are always ordered. */
  private sequence = 0
  private stopped = false

  constructor(private readonly deps: ProviderHealthMonitorDeps) {
    this.refreshIntervalMs = deps.refreshIntervalMs ?? PROVIDER_HEALTH_REFRESH_INTERVAL_MS
    this.probeTimeoutMs = deps.probeTimeoutMs ?? PROVIDER_HEALTH_PROBE_TIMEOUT_MS
    this.now = deps.now ?? (() => Date.now())
    this.schedule =
      deps.schedule ??
      ((run, ms) => {
        const timer = setInterval(run, ms)
        timer.unref?.()
        return { cancel: () => clearInterval(timer) }
      })
    for (const providerId of deps.providerIds) this.records.set(providerId, emptyRecord())
  }

  // ------------------------------------------------------------------ reading

  health(providerId: ProviderId): ProviderHealth {
    const record = this.records.get(providerId)
    if (!record) return UNPROBED_PROVIDER_HEALTH
    return {
      install: record.install,
      auth: record.auth,
      runtime: this.runtimeHealth(providerId, record),
      models: record.models,
      lastProbe: record.lastProbe,
      // No version registry is consulted anywhere in this app, so there is
      // nothing to compare an installed version against. `'unknown'` is the
      // only honest value; inventing `'current'` would be a guess.
      update: { state: 'unknown' },
    }
  }

  report(providerId: ProviderId): ProviderHealthReport {
    return {
      health: this.health(providerId),
      refreshing: this.inFlight.has(providerId) || this.external.has(providerId),
    }
  }

  reports(): Partial<Record<ProviderId, ProviderHealthReport>> {
    const all: Partial<Record<ProviderId, ProviderHealthReport>> = {}
    for (const providerId of this.records.keys()) all[providerId] = this.report(providerId)
    return all
  }

  onChange(listener: (providerId: ProviderId, report: ProviderHealthReport) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private runtimeHealth(providerId: ProviderId, record: ProviderRecord): ProviderRuntimeHealth {
    const census = this.deps.census(providerId)
    return {
      state: runtimeState(census, record),
      liveProcesses: census.liveProcesses,
      activeTurns: census.activeTurns,
      ...(record.lastUnexpectedExit ? { lastUnexpectedExit: record.lastUnexpectedExit } : {}),
      ...(record.runtimeMessage ? { message: record.runtimeMessage } : {}),
    }
  }

  // ------------------------------------------------------------- observations

  /** Restore the previous run's snapshot so boot renders known state instead
   * of "unavailable" for the ~10s the first probe takes. Everything restored
   * is past tense — the runtime axis is rebuilt from the live census, which
   * at boot is empty — so a cached snapshot can never claim a live process. */
  hydrate(cached: Partial<Record<ProviderId, ProviderHealth>>): void {
    for (const [providerId, health] of Object.entries(cached)) {
      const record = this.records.get(providerId as ProviderId)
      if (!record || !health) continue
      record.install = health.install
      record.auth = health.auth
      record.models = health.models
      record.lastProbe = health.lastProbe
      // A restored probe does not count as a live observation: it cannot
      // clear an exit this process has not seen, and it must not suppress the
      // boot refresh. Staleness is judged from `lastProbe.at` alone.
    }
  }

  /** The `initialize` response of any process for this provider, live session
   * or probe. It proves the binary exists and speaks ACP. */
  observeInitialized(providerId: ProviderId, agentVersion: string | undefined): void {
    const record = this.records.get(providerId)
    if (!record) return
    record.install = {
      state: 'installed',
      ...(record.install.command ? { command: record.install.command } : {}),
      ...(agentVersion ? { version: agentVersion } : {}),
    }
    this.publish(providerId)
  }

  observeAuthenticated(providerId: ProviderId, methodId: string | undefined): void {
    const record = this.records.get(providerId)
    if (!record) return
    record.auth = { state: 'authenticated', ...(methodId ? { methodId } : {}) }
    this.publish(providerId)
  }

  observeAuthRequired(providerId: ProviderId, message: string, loginHint?: string): void {
    const record = this.records.get(providerId)
    if (!record) return
    record.auth = {
      state: 'unauthenticated',
      message,
      ...(loginHint ? { loginHint } : {}),
    }
    record.unhealthySeq = this.tick()
    this.publish(providerId)
  }

  /** A `session/new` or `session/load` response carries the whole catalog for
   * free. That is why the monitor never spends a `session/new` (~3.5s on
   * Cursor) of its own on model discovery. */
  observeModels(providerId: ProviderId, models: ModelListing | undefined): void {
    const record = this.records.get(providerId)
    if (!record) return
    const available = models?.availableModels
    if (!available || available.length === 0) return
    record.models = {
      models: available.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        ...(model.description ? { description: model.description } : {}),
      })),
      refreshedAt: new Date(this.now()).toISOString(),
    }
    this.publish(providerId)
  }

  /** A session runtime completed `start()`: spawn, handshake, auth and
   * `session/new` all succeeded just now. Strong enough to clear an earlier
   * crash — this is a fresh observation, not an assumption. */
  observeRuntimeStarted(providerId: ProviderId): void {
    const record = this.records.get(providerId)
    if (!record) return
    record.startedEver = true
    record.healthySeq = this.tick()
    record.runtimeMessage = undefined
    this.publish(providerId)
  }

  observeRuntimeStartFailed(providerId: ProviderId, message: string): void {
    const record = this.records.get(providerId)
    if (!record) return
    record.startedEver = true
    record.unhealthySeq = this.tick()
    record.runtimeMessage = message
    this.publish(providerId)
  }

  /** One session's process died. It moves the *provider* to `'failed'` only
   * when no other runtime survives — the regression this replaces marked the
   * whole provider stopped whenever any single session exited. */
  observeRuntimeExit(providerId: ProviderId, threadId: string, exit: SessionRuntimeExit): void {
    const record = this.records.get(providerId)
    if (!record) return
    record.startedEver = true
    if (exit.expected) {
      record.runtimeMessage = undefined
      this.publish(providerId)
      return
    }
    record.unhealthySeq = this.tick()
    record.lastUnexpectedExit = {
      at: exit.at,
      exitCode: exit.exitCode,
      signal: exit.signal,
      threadId,
    }
    record.runtimeMessage = `Session process exited unexpectedly (code ${exit.exitCode ?? 'null'}, signal ${exit.signal ?? 'none'})`
    this.publish(providerId)
  }

  /** Adopt a probe somebody else is running in a throwaway process.
   *
   * `AgentHost.ensureProvider` runs one, because it also needs the lifecycle
   * events the monitor's silent probe deliberately does not emit. Without
   * this the two would spawn a CLI each, and the monitor's snapshot would
   * still read "never probed" straight after a successful bootstrap. While an
   * adopted probe is open the provider reads as `refreshing`, and the monitor
   * declines to start a second one. */
  beginProbe(providerId: ProviderId): ProviderProbeRecorder {
    const record = this.records.get(providerId)
    const startedAt = this.now()
    if (!record) return { ok: () => undefined, failed: () => undefined }
    // Identity, so this recorder settles once and no other recorder's
    // settlement can silence it. The provider reads as `refreshing` until the
    // last adopted probe closes.
    const token = {}
    const open = this.external.get(providerId) ?? new Set<object>()
    open.add(token)
    this.external.set(providerId, open)
    this.publish(providerId)
    const settle = (apply: () => void): void => {
      const current = this.external.get(providerId)
      // Only this recorder's own second call is ignored; a *different*
      // recorder's result is always applied, whichever order they land in.
      // Later observations win because `apply` stamps a fresh sequence number.
      if (!current?.delete(token)) return
      if (current.size === 0) this.external.delete(providerId)
      apply()
      this.publish(providerId)
    }
    return {
      ok: (result) => settle(() => this.applyProbeResult(record, result, startedAt)),
      failed: (error) => settle(() => this.applyProbeFailure(record, error, startedAt)),
    }
  }

  // ---------------------------------------------------------------- refreshing

  /** Start the boot refresh and the interval. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = this.schedule(() => {
      for (const providerId of this.records.keys()) void this.refresh(providerId, 'interval')
    }, this.refreshIntervalMs)
    for (const providerId of this.records.keys()) void this.refresh(providerId, 'boot')
  }

  stop(): void {
    this.stopped = true
    this.timer?.cancel()
    this.timer = undefined
    this.listeners.clear()
  }

  /** Bring one provider's snapshot up to date.
   *
   * `'user'` always spends a probe: the user asked, and the answer they want
   * is a fresh one. `'boot'` and `'interval'` skip the spawn when a live
   * runtime already proves the same facts — spawning ~141 MB every 5 minutes
   * to re-learn what an active session demonstrates is pure waste. */
  refresh(providerId: ProviderId, reason: ProviderHealthRefreshReason): Promise<ProviderHealth> {
    const record = this.records.get(providerId)
    if (!record) return Promise.resolve(UNPROBED_PROVIDER_HEALTH)
    // Joining an in-flight probe is what stops concurrent triggers stacking.
    const active = this.inFlight.get(providerId)
    if (active) return active
    // Somebody else already has a CLI up for this provider; a second one would
    // answer the same question at another ~141 MB.
    if (this.external.has(providerId)) return Promise.resolve(this.health(providerId))

    if (reason !== 'user' && this.derivableFromLiveRuntime(providerId, record)) {
      record.lastProbe = {
        outcome: 'ok',
        at: new Date(this.now()).toISOString(),
        durationMs: 0,
        message: 'Derived from a live session process; no probe was spawned.',
      }
      record.healthySeq = this.tick()
      this.publish(providerId)
      return Promise.resolve(this.health(providerId))
    }

    const cwd = this.deps.probeCwd(providerId)
    if (cwd === undefined) {
      // No real directory to spawn in. Report nothing rather than guess.
      this.deps.host.log({
        scope: 'agent-runtime',
        level: 'info',
        message: 'Skipped health probe: no workspace directory is known yet',
        data: { providerId, reason },
      })
      return Promise.resolve(this.health(providerId))
    }

    const run = this.enqueue(() => this.probe(providerId, record, cwd)).finally(() => {
      if (this.inFlight.get(providerId) === run) this.inFlight.delete(providerId)
      this.publish(providerId)
    })
    this.inFlight.set(providerId, run)
    this.publish(providerId)
    return run
  }

  /** A runtime in `ready` has already done everything a probe would do, in
   * this same CLI, more recently than any snapshot — and it is alive right
   * now. Deriving from it is an observation, not an optimistic assumption.
   * A runtime that is merely `starting` proves nothing yet. */
  private derivableFromLiveRuntime(providerId: ProviderId, record: ProviderRecord): boolean {
    if (this.deps.census(providerId).readyProcesses === 0) return false
    return record.install.state === 'installed' && record.auth.state === 'authenticated'
  }

  /** One slot, so two providers never hold CLI processes at the same time. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async probe(
    providerId: ProviderId,
    record: ProviderRecord,
    cwd: string,
  ): Promise<ProviderHealth> {
    if (this.stopped) return this.health(providerId)
    const startedAt = this.now()
    let runtime: AcpProbeRuntime | undefined
    try {
      runtime = this.deps.probes.create(providerId, cwd)
    } catch (error) {
      // No such provider config. Not a health fact about a binary.
      this.settleProbe(record, 'failed', startedAt, message(error))
      this.publish(providerId)
      return this.health(providerId)
    }

    try {
      const result = await withTimeout(
        runtime.probe(),
        this.probeTimeoutMs,
        () => new ProbeTimeoutError(providerId, this.probeTimeoutMs),
      )
      this.applyProbeResult(record, result, startedAt)
    } catch (error) {
      this.applyProbeFailure(record, error, startedAt)
    } finally {
      await runtime.dispose().catch((error: unknown) => {
        this.deps.host.log({
          scope: 'agent-runtime',
          level: 'warn',
          message: 'Health probe process did not shut down cleanly',
          data: { providerId, error: message(error) },
        })
      })
    }
    this.publish(providerId)
    return this.health(providerId)
  }

  /** A completed handshake. `authenticated: false` only reaches here for
   * providers whose config tolerates an auth failure; it is a real answer
   * ("the CLI works, the credentials do not"), so it is `'degraded'`, not a
   * probe failure. */
  private applyProbeResult(
    record: ProviderRecord,
    result: AcpProbeResult,
    startedAt: number,
  ): void {
    record.install = { state: 'installed', ...versionFields(result.agentInfo?.version) }
    record.auth = result.authenticated
      ? { state: 'authenticated' }
      : {
          state: 'unauthenticated',
          ...(result.authError ? { message: result.authError } : {}),
        }
    if (result.authenticated) {
      record.healthySeq = this.tick()
      this.settleProbe(record, 'ok', startedAt)
      return
    }
    record.unhealthySeq = this.tick()
    this.settleProbe(record, 'degraded', startedAt, result.authError)
  }

  /** Every failure lands on exactly one of these, and an axis the failure does
   * not speak to stays `'unknown'`. A timeout says nothing about auth; a
   * missing binary says nothing about auth either. */
  private applyProbeFailure(record: ProviderRecord, error: unknown, startedAt: number): void {
    record.unhealthySeq = this.tick()
    if (error instanceof ProbeTimeoutError) {
      record.install = { state: 'unknown', message: error.message }
      record.auth = { state: 'unknown' }
      this.settleProbe(record, 'timeout', startedAt, error.message)
      return
    }
    if (error instanceof AuthRequiredError) {
      // The CLI ran and answered; it just refused the credentials.
      record.install = { state: 'installed' }
      record.auth = {
        state: 'unauthenticated',
        message: error.message,
        ...(error.loginHint ? { loginHint: error.loginHint } : {}),
      }
      this.settleProbe(record, 'degraded', startedAt, error.message)
      return
    }
    if (isSpawnFailure(error)) {
      record.install = { state: 'missing', message: message(error) }
      record.auth = { state: 'unknown' }
      this.settleProbe(record, 'failed', startedAt, message(error))
      return
    }
    // Spawned but could not complete the handshake: the binary is there and
    // does not work. Auth was never reached, so it stays unknown.
    record.install = { state: 'unusable', message: message(error) }
    record.auth = { state: 'unknown' }
    this.settleProbe(record, 'failed', startedAt, message(error))
  }

  private settleProbe(
    record: ProviderRecord,
    outcome: ProviderProbe['outcome'],
    startedAt: number,
    detail?: string,
  ): void {
    record.lastProbe = {
      outcome,
      at: new Date(this.now()).toISOString(),
      durationMs: Math.max(0, this.now() - startedAt),
      ...(detail ? { message: detail } : {}),
    }
  }

  private tick(): number {
    return ++this.sequence
  }

  private publish(providerId: ProviderId): void {
    if (this.listeners.size === 0) return
    const report = this.report(providerId)
    for (const listener of this.listeners) listener(providerId, report)
  }
}

function runtimeState(census: ProviderRuntimeCensus, record: ProviderRecord): ProviderRuntimeState {
  const failing = record.unhealthySeq > record.healthySeq
  if (census.liveProcesses > 0) {
    if (failing) return 'degraded'
    return census.readyProcesses > 0 ? 'running' : 'starting'
  }
  if (!record.startedEver) return 'never_started'
  return failing ? 'failed' : 'stopped'
}

function versionFields(version: string | undefined): { version?: string } {
  return version ? { version } : {}
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A spawn that never produced a process, as opposed to one that produced a
 * process which then misbehaved. `ChildProcessConnectionFactory` rejects with
 * Node's own spawn error, so the code is the evidence. */
function isSpawnFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code: unknown = Reflect.get(error, 'code')
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return true
  return /\bENOENT\b|did not start within/.test(error.message)
}

export class ProbeTimeoutError extends Error {
  readonly name = 'ProbeTimeoutError'
  constructor(
    readonly providerId: ProviderId,
    readonly timeoutMs: number,
  ) {
    super(`${providerId} health probe did not answer within ${timeoutMs}ms`)
  }
}
