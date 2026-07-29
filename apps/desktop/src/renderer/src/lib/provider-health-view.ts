import {
  deriveProviderUiStatus,
  type ProviderHealthReport,
  type ProviderUiStatus,
} from '@openmanager/shared/contracts/provider-health'

/** How one provider reads in the settings menu.
 *
 * Kept out of the component so the wording can be tested without React, and
 * so there is exactly one place that decides what each health state says.
 *
 * The rule the copy follows: a provider that is installed and signed in reads
 * as ready whether or not a session is open. "Not running" is a detail line,
 * never a defect — at launch only the last-used provider is started, and the
 * other one used to render as "Unavailable" purely for that reason. */
export type ProviderHealthTone = 'ready' | 'warning' | 'error' | 'muted'

export type ProviderHealthPresentation = {
  status: ProviderUiStatus
  tone: ProviderHealthTone
  /** Second line of the row. Always present. */
  label: string
  /** Third line, when there is something specific worth saying. */
  detail?: string
  /** Whether offering a Retry for this provider makes sense. */
  canRetry: boolean
}

export function describeProviderHealth(
  report: ProviderHealthReport | undefined,
  now: number = Date.now(),
): ProviderHealthPresentation {
  const status = deriveProviderUiStatus(report, now)
  const health = report?.health
  switch (status) {
    case 'probing':
      return {
        status,
        tone: 'muted',
        label: 'Checking…',
        ...detailOf(lastCheckedAt(report, now)),
        canRetry: false,
      }
    case 'ready':
      return {
        status,
        tone: 'ready',
        label: 'Ready',
        ...detailOf(sessionSummary(health?.runtime.liveProcesses ?? 0)),
        canRetry: false,
      }
    case 'degraded':
      return {
        status,
        tone: 'warning',
        label: 'Running with errors',
        ...detailOf(health?.runtime.message),
        canRetry: true,
      }
    case 'auth_required':
      return {
        status,
        tone: 'warning',
        label: 'Sign-in required',
        ...detailOf(health?.auth.loginHint ?? health?.auth.message),
        canRetry: true,
      }
    case 'binary_missing':
      return {
        status,
        tone: 'error',
        label: 'CLI not found',
        ...detailOf(health?.install.message),
        canRetry: true,
      }
    case 'failed':
      return {
        status,
        tone: 'error',
        label: 'Unavailable',
        ...detailOf(health?.install.message ?? health?.runtime.message),
        canRetry: true,
      }
    case 'unknown':
      return {
        status,
        tone: 'muted',
        label: 'Not checked yet',
        ...detailOf(lastCheckedAt(report, now)),
        canRetry: true,
      }
    default:
      return status satisfies never
  }
}

function detailOf(detail: string | undefined): { detail?: string } {
  return detail ? { detail } : {}
}

function sessionSummary(liveProcesses: number): string {
  if (liveProcesses === 0) return 'No session running'
  return liveProcesses === 1 ? '1 session running' : `${liveProcesses} sessions running`
}

/** Boot renders the previous run's snapshot, so it has to say how old it is —
 * otherwise the cache would be indistinguishable from a fresh reading. */
function lastCheckedAt(report: ProviderHealthReport | undefined, now: number): string | undefined {
  const at = report?.health.lastProbe?.at
  if (!at) return undefined
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return undefined
  return `Last checked ${relativeAge(Math.max(0, now - parsed))}`
}

function relativeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
