import type {
  UsageLimitObservation,
  UsageLimitWindow,
  UsageLimitsReading,
} from '@agentpack/contract'
import type { PlanType, v2 } from '@openmanager/codex-app-server-protocol'
import { isCodexMainBucket, type CodexProviderState } from './codex-account.js'

/**
 * Codex's plan limits, in the provider-neutral shape (CAL-266).
 *
 * Two sources, both through `CodexProviderState`. A full read is
 * `account/rateLimits/read` on the service process. Between reads, every
 * session's process sends `account/rateLimits/updated` as its turns use the
 * plan; those are sparse and are merged into the last full read first
 * (`applyRateLimitsUpdated`), then announced window by window.
 *
 * Only the main `codex` bucket is shown. A window is named by its length,
 * `windowDurationMins` (300 and 10,080 on every plan seen so far), never by
 * its slot: which slot holds which window is the plan's business.
 */

type Slot = 'primary' | 'secondary'
const SLOTS: readonly Slot[] = ['primary', 'secondary']

const FIVE_HOURS = 300
const ONE_DAY = 24 * 60
const ONE_WEEK = 7 * ONE_DAY

/** The main bucket as a reading, or null when there is nothing to show (no
 * main bucket, or one with neither windows nor credits). */
export function codexUsageReading(state: CodexProviderState): UsageLimitsReading | null {
  const snapshot = state.rateLimits
  if (!snapshot || !isCodexMainBucket(snapshot.limitId)) return null
  const names = slotNames(snapshot)
  const windows: UsageLimitWindow[] = []
  for (const slot of SLOTS) {
    const window = snapshot[slot]
    if (window) windows.push(usageWindow(window, names[slot], snapshot.credits))
  }
  const credits = snapshot.credits
  if (windows.length === 0 && !credits) return null
  const plan = codexPlanLabel(snapshot.planType ?? state.planType ?? accountPlan(state))
  return {
    windows,
    extraUsage: null,
    ...(plan ? { plan } : {}),
    ...(credits
      ? {
          credits: {
            hasCredits: credits.hasCredits,
            unlimited: credits.unlimited,
            balance: credits.balance,
          },
        }
      : {}),
  }
}

/** What a session's `account/rateLimits/updated` says, window by window,
 * once merged into `state` (the provider's limits after the update). Only
 * the windows the update carried, and none for another bucket. A window
 * whose length was never stated cannot be named, and is left out. */
export function codexUsageObservations(
  state: CodexProviderState,
  update: v2.RateLimitSnapshot,
): UsageLimitObservation[] {
  if (!isCodexMainBucket(update.limitId)) return []
  const merged = state.rateLimits
  if (!merged) return []
  const names = slotNames(merged)
  const observations: UsageLimitObservation[] = []
  for (const slot of SLOTS) {
    const window = update[slot] ? merged[slot] : null
    if (!window || window.windowDurationMins === null) continue
    const { id, label, group, usedPercent, resetsAt, status } = usageWindow(
      window,
      names[slot],
      merged.credits,
    )
    observations.push({
      windowId: id,
      label,
      group,
      ...(usedPercent !== null ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(status ? { status } : {}),
    })
  }
  return observations
}

type WindowName = Pick<UsageLimitWindow, 'id' | 'label' | 'group'>

function usageWindow(
  window: v2.RateLimitWindow,
  name: WindowName,
  credits: v2.CreditsSnapshot | null,
): UsageLimitWindow {
  const usedPercent = percent(window.usedPercent)
  // Codex gives a number, not a verdict. A used-up window refuses turns
  // unless credits pay for them.
  const creditsUsable = credits !== null && (credits.unlimited || credits.hasCredits)
  return {
    ...name,
    usedPercent,
    resetsAt: isoFromEpochSeconds(window.resetsAt),
    status: usedPercent !== null && usedPercent >= 100 && !creditsUsable ? 'limited' : null,
  }
}

/** Both slots' names. Two windows of the same length would share an id
 * (one meter, one key, an update landing on the wrong one), so the
 * secondary's then says it is the second. */
function slotNames(snapshot: v2.RateLimitSnapshot): Record<Slot, WindowName> {
  const primary = windowName(snapshot.primary?.windowDurationMins ?? null, 'primary')
  const secondary = windowName(snapshot.secondary?.windowDurationMins ?? null, 'secondary')
  if (snapshot.primary && snapshot.secondary && primary.id === secondary.id)
    return {
      primary,
      secondary: { ...secondary, id: `${secondary.id}:secondary`, label: `${secondary.label} · second` },
    }
  return { primary, secondary }
}

/** The ids are Claude's for the same lengths, so a window means the same
 * thing whichever provider it is. */
export function windowName(minutes: number | null, slot: Slot): WindowName {
  if (minutes === FIVE_HOURS) return { id: 'five_hour', label: '5-hour', group: 'session' }
  if (minutes === ONE_WEEK) return { id: 'seven_day', label: 'Weekly', group: 'weekly' }
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0)
    return { id: slot, label: slot === 'primary' ? 'Usage' : 'Usage · secondary', group: 'other' }
  const label =
    minutes % ONE_DAY === 0
      ? `${minutes / ONE_DAY}-day`
      : minutes % 60 === 0
        ? `${minutes / 60}-hour`
        : `${minutes}-minute`
  return { id: `window:${minutes}`, label, group: minutes < ONE_DAY ? 'session' : 'other' }
}

const PLAN_LABELS: Partial<Record<PlanType, string>> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  enterprise: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  ent26: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu Plus',
  edu_pro: 'Edu Pro',
}

/** "Plus", "Pro". A plan this build does not know is shown as Codex names
 * it, title-cased; `unknown` is not shown. */
export function codexPlanLabel(plan: string | null | undefined): string | undefined {
  if (!plan || plan === 'unknown') return undefined
  const known = PLAN_LABELS[plan as PlanType]
  if (known) return known
  const words = plan.split(/[_\s]+/).filter(Boolean)
  const label = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ')
  return label.slice(0, 64) || undefined
}

function accountPlan(state: CodexProviderState): string | undefined {
  const account = state.account
  return account?.state === 'signed_in' && account.account.type === 'chatgpt'
    ? account.account.planType
    : undefined
}

function percent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

/** `resetsAt` is epoch seconds (_probed_ on 0.170); milliseconds are
 * accepted too, as for Claude's. */
function isoFromEpochSeconds(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null
  const date = new Date(value < 1e12 ? value * 1000 : value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
