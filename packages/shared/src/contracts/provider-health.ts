/** Provider health as independent axes.
 *
 * Replaced `SidecarStatus`, which Phase 3 deleted. The single enum could not
 * express "never started" versus "start failed" — both collapsed to a
 * non-`'healthy'` value, so a provider nobody had started yet rendered as
 * broken — and its `'unhealthy'` member was never assigned anywhere.
 *
 * Two rules this shape encodes:
 *  - Health is a snapshot with an age (`lastProbe.at`), not a latch. A provider
 *    that answered an hour ago and has not been probed since is `'unknown'`,
 *    not `'ready'`.
 *  - Health ("does this CLI work at all?") is separate from liveness ("is this
 *    thread's child process still running?"). Liveness is owned by a session
 *    runtime and rolls up into `runtime`; the rest is probed in throwaway
 *    processes so a probe can never perturb a live turn.
 *
 * `ProviderHealth` carries no provider id: it is always held in a map keyed by
 * one, and this package intentionally has no dependency on the agent contract
 * package where `ProviderId` lives.
 */

export type ProviderInstallState = 'unknown' | 'installed' | 'missing' | 'unusable'

export interface ProviderInstallHealth {
  state: ProviderInstallState
  /** The command that was probed, after env-override resolution. */
  command?: string
  version?: string
  /** Why the binary is `'missing'` or `'unusable'`. */
  message?: string
}

export type ProviderAuthState = 'unknown' | 'authenticated' | 'unauthenticated' | 'error'

export interface ProviderAuthHealth {
  state: ProviderAuthState
  /** ACP auth method that succeeded, or the one that was attempted. */
  methodId?: string
  /** Account label the CLI reported, if any (e.g. an email). */
  accountLabel?: string
  message?: string
  /** Actionable instruction, e.g. "Run `opencode auth login` and retry." */
  loginHint?: string
}

/** Rollup over every session runtime this provider currently owns.
 * `'never_started'` is the state the old union could not name. */
export type ProviderRuntimeState =
  | 'never_started'
  | 'starting'
  | 'running'
  /** Some runtimes are alive, but at least one died unexpectedly. */
  | 'degraded'
  /** Every runtime exited, all of them on request. */
  | 'stopped'
  /** The last start attempt failed, or every runtime died unexpectedly. */
  | 'failed'

export interface ProviderExitInfo {
  /** ISO timestamp. */
  at: string
  exitCode: number | null
  signal: string | null
  /** Thread whose runtime exited. */
  threadId?: string
}

export interface ProviderRuntimeHealth {
  state: ProviderRuntimeState
  /** Child processes alive right now. One per session, not per provider. */
  liveProcesses: number
  /** Runtimes with a prompt in flight; the idle reaper must skip these. */
  activeTurns: number
  lastUnexpectedExit?: ProviderExitInfo
  message?: string
}

export interface ProviderModelSummary {
  id: string
  displayName: string
  description?: string
}

export interface ProviderModelCatalog {
  models: readonly ProviderModelSummary[]
  /** null until a catalog probe has ever succeeded. */
  refreshedAt: string | null
}

export type ProviderProbeOutcome = 'ok' | 'degraded' | 'failed' | 'timeout'

export interface ProviderProbe {
  outcome: ProviderProbeOutcome
  /** ISO timestamp. Consumers decide when a snapshot is too old to trust. */
  at: string
  durationMs: number
  message?: string
}

export type ProviderUpdateState = 'unknown' | 'current' | 'behind' | 'unsupported'

export interface ProviderUpdateAdvisory {
  state: ProviderUpdateState
  latestVersion?: string
  /** Lowest CLI version this app supports, when one is enforced. */
  minimumVersion?: string
  message?: string
}

export interface ProviderHealth {
  install: ProviderInstallHealth
  auth: ProviderAuthHealth
  runtime: ProviderRuntimeHealth
  models: ProviderModelCatalog
  /** null until the first probe completes — distinct from a failed probe. */
  lastProbe: ProviderProbe | null
  update: ProviderUpdateAdvisory
}

/** One-word rollup for badges. Always derived from `ProviderHealth`, never
 * stored: storing it is how the current one-shot latch went stale. */
export type ProviderHealthSummary = 'unknown' | 'ready' | 'warning' | 'error' | 'stopped'

/** Honest starting value: nothing probed, nothing started, nothing known. */
export const UNPROBED_PROVIDER_HEALTH: ProviderHealth = {
  install: { state: 'unknown' },
  auth: { state: 'unknown' },
  runtime: { state: 'never_started', liveProcesses: 0, activeTurns: 0 },
  models: { models: [], refreshedAt: null },
  lastProbe: null,
  update: { state: 'unknown' },
}

/** How long a probe result stays evidence. The monitor re-probes every 5
 * minutes, so anything older than two intervals means the loop did not run —
 * the app was closed, or the machine slept — and the snapshot describes the
 * past. Past-tense facts are reported as `'unknown'`, never as current. */
export const PROVIDER_HEALTH_STALE_MS = 10 * 60 * 1000

/** What the main process pushes over IPC.
 *
 * `refreshing` is monitor state, not health: it says a probe is in flight
 * right now. It is deliberately outside `ProviderHealth` so it can never be
 * persisted in the boot cache and can never be inferred from a snapshot. */
export interface ProviderHealthReport {
  health: ProviderHealth
  refreshing: boolean
}

/** True when nothing in the snapshot is present-tense evidence.
 *
 * A live child process is present-tense evidence on its own: the registry
 * drops an entry the moment its process dies, so a non-zero `liveProcesses`
 * is observed now, not remembered. */
export function isProviderHealthStale(health: ProviderHealth, now: number = Date.now()): boolean {
  if (health.runtime.liveProcesses > 0) return false
  if (health.lastProbe === null) return true
  const at = Date.parse(health.lastProbe.at)
  if (Number.isNaN(at)) return true
  return now - at > PROVIDER_HEALTH_STALE_MS
}

/** Policy, not contract (see docs/session-runtime-design.md §9).
 *
 * Two deliberate changes from the Phase 0 mapping:
 *  - Runtime idleness no longer outranks a good install/auth reading. A CLI
 *    that is installed and authenticated with no session open is `'ready'`;
 *    "not running" is detail, not a defect. Reporting `'stopped'` there is
 *    what made a correctly-installed provider look broken at app launch.
 *  - `'stopped'` therefore only survives when we have no positive
 *    install/auth reading to report instead. */
export function summarizeProviderHealth(health: ProviderHealth): ProviderHealthSummary {
  if (health.install.state === 'missing' || health.install.state === 'unusable') return 'error'
  if (health.auth.state === 'unauthenticated' || health.auth.state === 'error') return 'error'
  if (health.runtime.state === 'failed') return 'error'
  if (health.update.state === 'unsupported') return 'error'
  if (health.lastProbe === null && health.runtime.state === 'never_started') return 'unknown'
  if (health.runtime.state === 'degraded') return 'warning'
  if (health.lastProbe?.outcome === 'degraded' || health.lastProbe?.outcome === 'timeout')
    return 'warning'
  if (health.update.state === 'behind') return 'warning'
  if (health.install.state === 'installed' && health.auth.state === 'authenticated') return 'ready'
  if (health.runtime.state === 'stopped') return 'stopped'
  return 'unknown'
}

/** The states the UI must be able to tell apart. `ProviderHealthSummary`
 * answers "how bad is it"; this answers "what is the user looking at", which
 * is what decides the wording and whether a retry affordance makes sense.
 *
 * `'unknown'` is not a failure mode — it is "we have not checked yet", and it
 * is the honest reading for a provider that has simply never been started. */
export type ProviderUiStatus =
  'unknown' | 'probing' | 'ready' | 'degraded' | 'auth_required' | 'binary_missing' | 'failed'

export function deriveProviderUiStatus(
  report: ProviderHealthReport | undefined,
  now: number = Date.now(),
): ProviderUiStatus {
  if (!report) return 'unknown'
  const settled = settledProviderUiStatus(report.health, now)
  // A refresh only becomes the headline when there is no good news to keep
  // showing. Re-checking a working provider in the background must not make
  // its badge flicker every five minutes; re-checking a broken one is exactly
  // what the user wants to see after pressing Retry.
  if (report.refreshing && settled !== 'ready' && settled !== 'degraded') return 'probing'
  return settled
}

/** The reading the snapshot alone supports, ignoring any probe in flight. */
function settledProviderUiStatus(health: ProviderHealth, now: number): ProviderUiStatus {
  // Nothing here is current. Say so rather than replaying an old verdict —
  // a binary that was missing an hour ago may have been installed since.
  if (isProviderHealthStale(health, now)) return 'unknown'
  if (health.install.state === 'missing') return 'binary_missing'
  if (health.install.state === 'unusable') return 'failed'
  if (health.auth.state === 'unauthenticated' || health.auth.state === 'error')
    return 'auth_required'
  if (health.runtime.state === 'failed') return 'failed'
  if (health.runtime.state === 'degraded') return 'degraded'
  if (health.runtime.liveProcesses > 0) return 'ready'
  if (health.install.state === 'installed' && health.auth.state === 'authenticated') return 'ready'
  return 'unknown'
}
