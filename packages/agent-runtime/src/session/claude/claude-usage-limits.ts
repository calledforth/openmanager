import type {
  UsageLimitObservation,
  UsageLimitWindow,
  UsageLimitsReading,
} from '@agentpack/contract'
import { number, object, string } from '../wire.js'

/**
 * Claude Code's plan limits, in the provider-neutral shape.
 *
 * Two sources. A full read is the SDK's `/usage` control request
 * (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`), asked on a
 * probe that never prompts. Measured 2026-11-02 against CLI 2.1.309: it
 * answers with no session, no prompt and no tokens, in 25–80 s, most of it a
 * scan of local transcripts behind the dialog's "what's using your limits"
 * section. Between reads a live session's `rate_limit_event` nudges one window.
 *
 * Only the fields `sdk.d.ts` types are read. The response also carries
 * internal, code-named keys and a `limits[]` array the SDK does not type yet;
 * those are skipped, so a rename there cannot put nonsense on screen.
 */

/** The fixed windows, in display order. `seven_day_oauth_apps` is left out:
 * it is a third-party-apps allowance, not one Claude Code spends. */
const FIXED_WINDOWS: ReadonlyArray<{
  key: string
  label: string
  group: UsageLimitWindow['group']
  /** Which per-model entry makes this one redundant. */
  model?: string
}> = [
  { key: 'five_hour', label: '5-hour', group: 'session' },
  { key: 'seven_day', label: 'Weekly · all models', group: 'weekly' },
  { key: 'seven_day_opus', label: 'Weekly · Opus', group: 'weekly', model: 'opus' },
  { key: 'seven_day_sonnet', label: 'Weekly · Sonnet', group: 'weekly', model: 'sonnet' },
]

/** `rate_limit_info.rateLimitType` → the window a full read calls it. */
const LIVE_WINDOWS: Readonly<
  Record<string, { id: string; label: string; group: UsageLimitWindow['group'] }>
> = {
  five_hour: { id: 'five_hour', label: '5-hour', group: 'session' },
  seven_day: { id: 'seven_day', label: 'Weekly · all models', group: 'weekly' },
  seven_day_opus: { id: 'seven_day_opus', label: 'Weekly · Opus', group: 'weekly' },
  seven_day_sonnet: { id: 'seven_day_sonnet', label: 'Weekly · Sonnet', group: 'weekly' },
}

/** The `/usage` answer, or null when this account has no plan limits
 * (`rate_limits_available: false`: an API key, Bedrock, Vertex). */
export function claudeUsageReading(response: unknown): UsageLimitsReading | null {
  const root = object(response)
  if (root.rate_limits_available !== true) return null
  const limits = object(root.rate_limits)
  const windows: UsageLimitWindow[] = []

  const modelScoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : []
  const scoped: UsageLimitWindow[] = []
  for (const raw of modelScoped) {
    const entry = object(raw)
    const name = string(entry.display_name)?.trim()
    if (!name) continue
    scoped.push(window(`model:${name}`, `Weekly · ${name}`, 'weekly', entry))
  }
  const scopedNames = new Set(scoped.map((entry) => entry.id.slice('model:'.length).toLowerCase()))

  for (const fixed of FIXED_WINDOWS) {
    const raw = limits[fixed.key]
    if (raw === null || raw === undefined || typeof raw !== 'object') continue
    if (fixed.model && scopedNames.has(fixed.model)) continue
    windows.push(window(fixed.key, fixed.label, fixed.group, object(raw)))
  }
  windows.push(...scoped)

  const extra = limits.extra_usage
  const extraUsage =
    extra && typeof extra === 'object'
      ? {
          enabled: object(extra).is_enabled === true,
          usedPercent: percent(object(extra).utilization),
        }
      : null
  return { windows, extraUsage }
}

/** One `rate_limit_event`, or undefined for a window the contract does not
 * name. Never a percent it was not told: `utilization` is left out because
 * its scale is not typed, while `surpassedThreshold` is a fraction (0.8). */
export function claudeUsageObservation(
  info: Record<string, unknown>,
): UsageLimitObservation | undefined {
  const type = string(info.rateLimitType)
  const known = type ? LIVE_WINDOWS[type] : undefined
  if (!known) return undefined
  const rawStatus = string(info.status)
  const status =
    rawStatus === 'rejected'
      ? ('limited' as const)
      : rawStatus === 'allowed_warning'
        ? ('warning' as const)
        : rawStatus === 'allowed'
          ? ('ok' as const)
          : undefined
  const resetsAt = isoFromEpochSeconds(number(info.resetsAt))
  const threshold = number(info.surpassedThreshold)
  const atLeast =
    status === 'limited'
      ? 100
      : threshold !== undefined && threshold > 0 && threshold <= 1
        ? Math.round(threshold * 100)
        : undefined
  return {
    windowId: known.id,
    label: known.label,
    group: known.group,
    ...(status ? { status } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(atLeast !== undefined ? { usedPercentAtLeast: atLeast } : {}),
  }
}

function window(
  id: string,
  label: string,
  group: UsageLimitWindow['group'],
  raw: Record<string, unknown>,
): UsageLimitWindow {
  const usedPercent = percent(raw.utilization)
  return {
    id,
    label,
    group,
    usedPercent,
    resetsAt: isoTimestamp(raw.resets_at),
    // A full read gives no verdict, only the number; 100% is refusal by definition.
    status: usedPercent !== null && usedPercent >= 100 ? 'limited' : null,
  }
}

/** `utilization` on a full read is a percent, 0–100 (typed so in `sdk.d.ts`). */
function percent(value: unknown): number | null {
  const n = number(value)
  if (n === undefined || !Number.isFinite(n)) return null
  return Math.min(100, Math.max(0, n))
}

function isoTimestamp(value: unknown): string | null {
  const text = string(value)
  if (!text) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** `rate_limit_info.resetsAt` is epoch seconds; milliseconds are accepted too,
 * the same tolerance `claude-problems.ts` applies to the same field. */
function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  const date = new Date(value < 1e12 ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
