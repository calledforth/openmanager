import type {
  DurableTurnNotice,
  TransientTurnNotice,
  TurnFailure,
  TurnFailureReason,
  TurnRecoveryAction,
} from '@openmanager/protocol'

/**
 * Transcript parts for what the provider said about a turn: a notice (quiet,
 * one line) and a failure (a little more present, with what to do about it).
 * Built by the thread projection and rendered by `TurnNoticePart` and
 * `TurnFailurePart`; the wording lives here so it can be tested without React.
 */
export interface NoticePart {
  type: 'notice'
  id: string
  notice: DurableTurnNotice | TransientTurnNotice
  /** A transient notice of a turn still going: it shimmers and goes away. */
  live?: boolean
  [key: string]: unknown
}

export interface FailurePart {
  type: 'failure'
  id: string
  turnId: string
  failure: TurnFailure
  /**
   * Whether its actions apply: only the newest turn's failure offers them,
   * since retrying or compacting after later turns would act on the wrong one.
   */
  actionable: boolean
  [key: string]: unknown
}

const noticeParts = new WeakMap<object, NoticePart>()

/** One part per notice object, so an unchanged notice keeps its row. */
export function noticePart(
  notice: DurableTurnNotice | TransientTurnNotice,
  live = false,
): NoticePart {
  let part = noticeParts.get(notice)
  if (!part) {
    part = {
      type: 'notice',
      id: live ? `live-notice:${notice.turnId}` : `notice:${notice.noticeId}`,
      notice,
      ...(live ? { live: true } : {}),
    }
    noticeParts.set(notice, part)
  }
  return part
}

const failureParts = new WeakMap<TurnFailure, Map<boolean, FailurePart>>()

export function failurePart(
  turnId: string,
  failure: TurnFailure,
  actionable: boolean,
): FailurePart {
  let byActionable = failureParts.get(failure)
  if (!byActionable) {
    byActionable = new Map()
    failureParts.set(failure, byActionable)
  }
  let part = byActionable.get(actionable)
  if (!part) {
    part = { type: 'failure', id: `failure:${turnId}`, turnId, failure, actionable }
    byActionable.set(actionable, part)
  }
  return part
}

export type NoticeTone = 'muted' | 'warning'

export interface NoticeCopy {
  /** The line itself. */
  label: string
  /** Fainter text after the label. */
  detail?: string
  /** Longer text the row discloses on demand, such as a policy explanation. */
  body?: string
  tone: NoticeTone
}

const RETRY_CAUSES: Partial<Record<TurnFailureReason, string>> = {
  overloaded: 'provider overloaded',
  rate_limited: 'rate limited',
  provider_error: 'server error',
}

/** Abbreviated the way the thinking row counts tokens. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`
}

/**
 * When a limit resets, as the reader would say it: a time today, a weekday
 * and time this week, a date otherwise. Undefined for a time that does not parse.
 */
export function formatResetTime(iso: string, now: Date = new Date()): string | undefined {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return undefined
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameDay = at.toDateString() === now.toDateString()
  if (sameDay) return time
  const days = (at.getTime() - now.getTime()) / 86_400_000
  if (days > 0 && days < 6) {
    return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  }
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

const joined = (...parts: (string | undefined)[]) => {
  const text = parts.filter((part): part is string => !!part).join(' · ')
  return text || undefined
}

export function describeNotice(
  notice: DurableTurnNotice | TransientTurnNotice,
  now: Date = new Date(),
): NoticeCopy {
  const body = notice.detail
  switch (notice.kind) {
    case 'retrying': {
      const retry = notice.retry
      if (!retry) return { label: 'Recovering from a temporary error', tone: 'muted' }
      const attempt = retry.maxAttempts
        ? `attempt ${retry.attempt} of ${retry.maxAttempts}`
        : `attempt ${retry.attempt}`
      return {
        label: 'Retrying',
        detail: joined(attempt, retry.cause ? RETRY_CAUSES[retry.cause] : undefined),
        tone: 'muted',
      }
    }
    case 'compacting':
      return { label: 'Compacting conversation', tone: 'muted' }
    case 'compacted': {
      const compaction = notice.compaction
      const saved =
        compaction?.tokensBefore !== undefined && compaction.tokensAfter !== undefined
          ? `${formatTokens(compaction.tokensBefore)} → ${formatTokens(compaction.tokensAfter)} tokens`
          : undefined
      return {
        label: 'Conversation compacted',
        detail: joined(compaction?.trigger === 'auto' ? 'automatically' : undefined, saved),
        tone: 'muted',
      }
    }
    case 'model_fallback':
      return notice.model
        ? {
            label: `Switched to ${notice.model.to}`,
            detail: notice.model.from ? `${notice.model.from} declined` : undefined,
            ...(body ? { body } : {}),
            tone: 'muted',
          }
        : { label: notice.message, ...(body ? { body } : {}), tone: 'muted' }
    case 'refusal':
      return {
        label: 'The model declined this request',
        ...(body ? { body } : {}),
        tone: 'warning',
      }
    case 'usage_warning': {
      const resets = notice.resetsAt ? formatResetTime(notice.resetsAt, now) : undefined
      return {
        label: notice.message,
        detail: resets ? `resets ${resets}` : undefined,
        tone: 'warning',
      }
    }
    case 'info':
      return { label: notice.message, ...(body ? { body } : {}), tone: 'muted' }
    case 'warning':
      return { label: notice.message, ...(body ? { body } : {}), tone: 'warning' }
  }
}

export interface FailureCopy {
  title: string
  /** What to do, when the app has no button for it or it needs saying. */
  guidance?: string
  /** The button the row offers, when the failure names an action. */
  action?: { kind: 'retry' | 'compact'; label: string }
}

/** The button an action becomes. Signing in has no backend: the row says how,
 * and offers the retry that follows it. */
function actionButton(action: TurnRecoveryAction | undefined): FailureCopy['action'] {
  switch (action) {
    case 'retry':
    case 'sign_in':
      return { kind: 'retry', label: 'Retry' }
    case 'compact':
      return { kind: 'compact', label: 'Compact' }
    default:
      return undefined
  }
}

export function describeFailure(
  failure: TurnFailure,
  providerName?: string,
  now: Date = new Date(),
): FailureCopy {
  const action = actionButton(failure.action)
  const base = { title: failure.message, ...(action ? { action } : {}) }
  switch (failure.reason) {
    case 'usage_limit': {
      const resets = failure.resetsAt ? formatResetTime(failure.resetsAt, now) : undefined
      return {
        ...base,
        guidance: resets ? `Resets ${resets}.` : "Check your plan's usage, or switch provider.",
      }
    }
    case 'context_window_exceeded':
      return {
        ...base,
        guidance:
          failure.action === 'compact'
            ? 'Compact the conversation to continue, or start a new chat.'
            : 'Start a new chat to continue.',
      }
    case 'authentication_required':
      return {
        ...base,
        guidance: `Sign in to ${providerName ?? 'the provider'} on the machine running this environment, then retry.`,
      }
    case 'rate_limited':
    case 'overloaded':
      return { ...base, guidance: 'This usually passes in a moment.' }
    case 'refused':
      return { ...base, guidance: 'Try rephrasing the request.' }
    default:
      return base
  }
}
