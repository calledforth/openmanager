import { isProviderId, type ProviderId } from '@agentpack/contract'
import {
  UNPROBED_PROVIDER_HEALTH,
  type ProviderAuthHealth,
  type ProviderAuthState,
  type ProviderHealth,
  type ProviderHealthReport,
  type ProviderInstallHealth,
  type ProviderInstallState,
  type ProviderModelCatalog,
  type ProviderModelSummary,
  type ProviderProbe,
  type ProviderProbeOutcome,
} from '@openmanager/shared/contracts/provider-health'

/** The last health snapshot, persisted between runs.
 *
 * Its only job is to give the sidebar something true-as-of-a-timestamp to
 * render during the ~10s the first probe of a cold Cursor takes, instead of
 * the "Unavailable" a never-probed provider used to show. It is explicitly
 * *not* a source of current truth: `isProviderHealthStale` ages it out, and
 * the runtime axis is never persisted at all — process liveness cannot
 * survive the process that had it. */
export type ProviderHealthCache = Partial<Record<ProviderId, ProviderHealth>>

const INSTALL_STATES: readonly ProviderInstallState[] = [
  'unknown',
  'installed',
  'missing',
  'unusable',
]
const AUTH_STATES: readonly ProviderAuthState[] = [
  'unknown',
  'authenticated',
  'unauthenticated',
  'error',
]
const PROBE_OUTCOMES: readonly ProviderProbeOutcome[] = ['ok', 'degraded', 'failed', 'timeout']

/** What to write to disk: everything except the axes that describe *this*
 * run. `runtime` is reset to its unprobed value so a restored snapshot can
 * never claim a live process, and `refreshing` is monitor state that is not
 * part of `ProviderHealth` at all. */
export function toProviderHealthCache(
  reports: Partial<Record<ProviderId, ProviderHealthReport>>,
): ProviderHealthCache {
  const cache: ProviderHealthCache = {}
  for (const [providerId, report] of Object.entries(reports)) {
    if (!isProviderId(providerId) || !report) continue
    // Nothing worth remembering about a provider we never learned anything about.
    if (report.health.lastProbe === null && report.health.install.state === 'unknown') continue
    cache[providerId] = { ...report.health, runtime: UNPROBED_PROVIDER_HEALTH.runtime }
  }
  return cache
}

/** Parse whatever electron-store hands back. The settings file is
 * user-writable and survives app upgrades, so every field is checked;
 * anything unrecognised is dropped rather than trusted. */
export function sanitizeProviderHealthCache(value: unknown): ProviderHealthCache {
  const cache: ProviderHealthCache = {}
  for (const [providerId, entry] of Object.entries(asRecord(value))) {
    if (!isProviderId(providerId)) continue
    const health = sanitizeHealth(entry)
    if (health) cache[providerId] = health
  }
  return cache
}

function sanitizeHealth(value: unknown): ProviderHealth | undefined {
  const source = asRecord(value)
  const lastProbe = sanitizeProbe(source.lastProbe)
  const install = sanitizeInstall(source.install)
  // A snapshot with neither a probe nor an install reading tells the UI
  // nothing it does not already assume.
  if (!lastProbe && install.state === 'unknown') return undefined
  return {
    install,
    auth: sanitizeAuth(source.auth),
    runtime: UNPROBED_PROVIDER_HEALTH.runtime,
    models: sanitizeModels(source.models),
    lastProbe,
    update: { state: 'unknown' },
  }
}

function sanitizeInstall(value: unknown): ProviderInstallHealth {
  const source = asRecord(value)
  const command = asText(source.command)
  const version = asText(source.version)
  const message = asText(source.message)
  return {
    state: asOneOf(source.state, INSTALL_STATES) ?? 'unknown',
    ...(command ? { command } : {}),
    ...(version ? { version } : {}),
    ...(message ? { message } : {}),
  }
}

function sanitizeAuth(value: unknown): ProviderAuthHealth {
  const source = asRecord(value)
  const methodId = asText(source.methodId)
  const accountLabel = asText(source.accountLabel)
  const message = asText(source.message)
  const loginHint = asText(source.loginHint)
  return {
    state: asOneOf(source.state, AUTH_STATES) ?? 'unknown',
    ...(methodId ? { methodId } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(message ? { message } : {}),
    ...(loginHint ? { loginHint } : {}),
  }
}

function sanitizeModels(value: unknown): ProviderModelCatalog {
  const source = asRecord(value)
  const refreshedAt = asText(source.refreshedAt)
  const raw = Array.isArray(source.models) ? source.models : []
  const models: ProviderModelSummary[] = []
  for (const entry of raw) {
    const model = asRecord(entry)
    const id = asText(model.id)
    const displayName = asText(model.displayName)
    if (!id || !displayName) continue
    const description = asText(model.description)
    models.push({ id, displayName, ...(description ? { description } : {}) })
  }
  return { models, refreshedAt: refreshedAt ?? null }
}

function sanitizeProbe(value: unknown): ProviderProbe | null {
  const source = asRecord(value)
  const outcome = asOneOf(source.outcome, PROBE_OUTCOMES)
  const at = asText(source.at)
  // An unparseable timestamp would make the snapshot look infinitely fresh.
  if (!outcome || !at || Number.isNaN(Date.parse(at))) return null
  const durationMs = typeof source.durationMs === 'number' ? source.durationMs : 0
  const message = asText(source.message)
  return {
    outcome,
    at,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
    ...(message ? { message } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asOneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined
  return allowed.find((candidate) => candidate === value)
}
