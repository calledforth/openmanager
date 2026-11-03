import type { ProviderLimits, ProviderLimitWindow } from '@openmanager/protocol'

/**
 * How a usage-limit reading reads on screen (CAL-242). Pure, so the sidebar
 * ring, its hover card and the Usage page all say the same thing.
 */

export type UsageLevel = 'unknown' | 'normal' | 'warning' | 'critical'

/** From here a window reads "running low"; from `CRITICAL_AT`, "almost out". */
export const WARNING_AT = 75
export const CRITICAL_AT = 90

export function usageLevel(
  window: Pick<ProviderLimitWindow, 'usedPercent' | 'status'> | null,
): UsageLevel {
  if (!window) return 'unknown'
  if (window.status === 'limited') return 'critical'
  const used = window.usedPercent
  if (used === null) return window.status === 'warning' ? 'warning' : 'unknown'
  if (used >= CRITICAL_AT) return 'critical'
  if (used >= WARNING_AT || window.status === 'warning') return 'warning'
  return 'normal'
}

/** The window the sidebar ring shows: the short session window, which is the
 * one people hit first, else whichever is closest to its limit. */
export function headlineWindow(limits: ProviderLimits | undefined): ProviderLimitWindow | null {
  const windows = limits?.reading?.windows ?? []
  const session = windows.find((window) => window.group === 'session')
  if (session) return session
  let best: ProviderLimitWindow | null = null
  for (const window of windows) {
    if ((window.usedPercent ?? -1) > (best?.usedPercent ?? -1)) best = window
  }
  return best ?? windows[0] ?? null
}

/** Whole percent for display; null reads as an em dash. */
export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "Resets in 2h 14m" within a day, "Resets Sun 3:30 PM" after that. */
export function formatResetsAt(iso: string | null, now: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  const left = at - now
  if (left <= 0) return 'Resetting now'
  if (left < MINUTE) return 'Resets in under a minute'
  if (left < HOUR) return `Resets in ${Math.ceil(left / MINUTE)}m`
  if (left < DAY) {
    const hours = Math.floor(left / HOUR)
    const minutes = Math.floor((left % HOUR) / MINUTE)
    return minutes > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${hours}h`
  }
  const date = new Date(at)
  const day = date.toLocaleDateString(undefined, { weekday: 'short' })
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `Resets ${day} ${time}`
}

/** "Updated just now", "Updated 4m ago", "Updated 2h ago". */
export function formatUpdated(iso: string | null | undefined, now: number): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(at)) return null
  const age = Math.max(0, now - at)
  if (age < MINUTE) return 'Updated just now'
  if (age < HOUR) return `Updated ${Math.floor(age / MINUTE)}m ago`
  if (age < DAY) return `Updated ${Math.floor(age / HOUR)}h ago`
  return `Updated ${Math.floor(age / DAY)}d ago`
}

/** One line for a provider whose numbers are missing or behind, or null when
 * the reading speaks for itself. */
export function limitsStatusLine(limits: ProviderLimits): string | null {
  if (limits.refreshing && !limits.reading) return 'Reading usage…'
  const last = limits.lastRefresh
  if (last?.outcome === 'unavailable') return 'This account has no plan usage limits.'
  if (!limits.reading) {
    return last?.outcome === 'failed' ? 'Couldn’t read usage. Try again.' : 'Not read yet.'
  }
  if (last?.outcome === 'failed') return 'Couldn’t refresh. Showing the last reading.'
  return null
}

/** The ring's accessible name, which is also its hover title. */
export function ringLabel(window: ProviderLimitWindow | null, now: number): string {
  if (!window) return 'Usage'
  const parts = [`Usage: ${window.label} ${formatPercent(window.usedPercent)} used`]
  const reset = formatResetsAt(window.resetsAt, now)
  if (reset) parts.push(reset.toLowerCase())
  return parts.join(', ')
}
