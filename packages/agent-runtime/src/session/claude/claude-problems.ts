import type { ProviderNotice, ProviderProblem, ProviderProblemCode } from '@agentpack/contract'
import { number, object, string } from '../wire.js'

/** How Claude Code says what went wrong and what it is doing about it.
 *
 * Every mapping here keys on a structured field the SDK types declare
 * (`SDKAssistantMessage.error`, `SDKAPIRetryMessage`, `terminal_reason`,
 * `api_error_status`, `SDKRateLimitEvent`, the refusal and compaction
 * frames). Text is consulted only as a last resort, for the result of a turn
 * whose structured fields said nothing, and only for phrasings Claude Code
 * itself exports. Nothing here throws: an unknown value maps to `unknown`. */

/** `SDKAssistantMessageError`, as a string so a new member maps to `unknown`
 * instead of failing to compile against an older or newer SDK. */
type ClaudeApiError = string

/** Claude Code's own list of what a spent usage allowance reads like
 * (`USAGE_LIMIT_ERROR_PREFIXES`, an `@alpha` export of the SDK). Copied rather
 * than imported: the translator only imports SDK types, and a runtime import
 * would load the SDK into every process that maps a message. */
const USAGE_LIMIT_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage',
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'requires usage credits',
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
  'Claude AI usage limit reached',
]

const CONTEXT_PATTERN =
  /prompt is too long|context (?:window|length|limit)|too many (?:input )?tokens/i
const AUTH_PATTERN = /invalid api key|authentication|not logged in|please run \/login|oauth token/i

/** The last `rate_limit_info` the CLI reported, which is the only place a
 * reset time is structured. */
export type ClaudeRateLimit = Record<string, unknown>

function codeOfApiError(error: ClaudeApiError | undefined): ProviderProblemCode | undefined {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'unauthorized'
    case 'billing_error':
      return 'usage_limit'
    case 'rate_limit':
      return 'rate_limited'
    case 'overloaded':
      return 'overloaded'
    case 'server_error':
      return 'server_error'
    case undefined:
      return undefined
    default:
      // invalid_request, model_not_found, max_output_tokens, unknown and
      // anything newer: nothing the user can act on by kind alone.
      return 'unknown'
  }
}

function codeOfStatus(status: number | undefined): ProviderProblemCode | undefined {
  if (status === undefined) return undefined
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 413) return 'context_window_exceeded'
  if (status === 429) return 'rate_limited'
  if (status === 529) return 'overloaded'
  if (status >= 500) return 'server_error'
  return undefined
}

/** Epoch seconds or milliseconds to ISO; the CLI has sent both over time. */
function isoFromEpoch(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  const ms = value < 1e12 ? value * 1000 : value
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** When the allowance a rejected request ran into comes back. */
function resetsAtOf(rateLimit: ClaudeRateLimit | undefined, text: string): string | undefined {
  const info = object(rateLimit)
  const overage = string(info.overageStatus) === 'rejected' && info.isUsingOverage === true
  const structured = isoFromEpoch(
    number(overage ? info.overageResetsAt : info.resetsAt) ?? number(info.resetsAt),
  )
  if (structured) return structured
  // The legacy wording carried the reset as `...limit reached|<epoch>`.
  const legacy = /\|(\d{10,13})\b/.exec(text)
  return legacy ? isoFromEpoch(Number(legacy[1])) : undefined
}

/** Did the allowance run out, as opposed to a burst of requests being throttled? */
function isUsageLimit(rateLimit: ClaudeRateLimit | undefined, text: string): boolean {
  const info = object(rateLimit)
  if (string(info.status) === 'rejected' && info.isUsingOverage !== true) return true
  return USAGE_LIMIT_PREFIXES.some((prefix) => text.includes(prefix))
}

/** `SDKAPIRetryMessage`: the CLI is retrying a request and the turn lives on. */
export function retryProblem(raw: Record<string, unknown>): ProviderProblem {
  const status = number(raw.error_status)
  const error = string(raw.error)
  // `error_status` is null for a connection error that never got a response.
  const code =
    raw.error_status === null && (error === undefined || error === 'unknown')
      ? 'network'
      : (codeOfStatus(status) ?? codeOfApiError(error) ?? 'unknown')
  const attempt = number(raw.attempt)
  const maxAttempts = number(raw.max_retries)
  const delayMs = number(raw.retry_delay_ms)
  return {
    code,
    ...(attempt !== undefined && attempt > 0
      ? {
          retry: {
            attempt,
            ...(maxAttempts !== undefined && maxAttempts > 0 ? { maxAttempts } : {}),
            ...(delayMs !== undefined && delayMs >= 0 ? { delayMs } : {}),
          },
        }
      : {}),
  }
}

export type ClaudeFailureInput = {
  /** The `error` and text of a top-level assistant message the CLI flagged. */
  apiError?: { error: ClaudeApiError; text: string }
  terminalReason?: string
  stopReason?: string
  apiErrorStatus?: number
  /** `SDKResultError.errors`, or a successful-but-failed result's `result`. */
  text: string
  rateLimit?: ClaudeRateLimit
  /** A `model_refusal_no_fallback` was seen this turn. */
  refused: boolean
}

/** Why a Claude turn failed, typed, with what the user can do about it. */
export function classifyClaudeFailure(input: ClaudeFailureInput): ProviderProblem {
  const text = [input.apiError?.text, input.text].filter(Boolean).join('\n')
  if (input.refused || input.stopReason === 'refusal') return { code: 'refused' }
  if (
    input.terminalReason === 'prompt_too_long' ||
    input.terminalReason === 'blocking_limit' ||
    CONTEXT_PATTERN.test(text)
  ) {
    // Claude Code can always compact its own conversation.
    return { code: 'context_window_exceeded', action: 'compact' }
  }
  // The most specific signal that actually says something wins: a flag of
  // `unknown` must not hide a 529 status or a recognisable result text.
  const code =
    [
      codeOfApiError(input.apiError?.error),
      codeOfStatus(input.apiErrorStatus),
      input.terminalReason === 'rapid_refill_breaker' ? ('rate_limited' as const) : undefined,
      codeOfText(text),
    ].find((candidate) => candidate !== undefined && candidate !== 'unknown') ?? 'unknown'
  if (code === 'usage_limit' || (code === 'rate_limited' && isUsageLimit(input.rateLimit, text))) {
    const resetsAt = resetsAtOf(input.rateLimit, text)
    return { code: 'usage_limit', ...(resetsAt ? { resetsAt } : {}) }
  }
  return { code }
}

/** Last resort, for a result that said nothing structured. */
function codeOfText(text: string): ProviderProblemCode {
  if (!text) return 'unknown'
  if (USAGE_LIMIT_PREFIXES.some((prefix) => text.includes(prefix))) return 'usage_limit'
  if (/credit balance is too low/i.test(text)) return 'usage_limit'
  const status = /API Error:\s*(\d{3})/.exec(text)
  const byStatus = codeOfStatus(status ? Number(status[1]) : undefined)
  if (byStatus) return byStatus
  if (/overloaded/i.test(text)) return 'overloaded'
  if (/rate.?limit/i.test(text)) return 'rate_limited'
  if (AUTH_PATTERN.test(text)) return 'unauthorized'
  return 'unknown'
}

/** A flagged assistant message on a turn that went on to succeed: worth a
 * line in the transcript, since its text is not shown. */
export function recoveredErrorNotice(error: ClaudeApiError): ProviderNotice {
  if (error === 'max_output_tokens') {
    return {
      kind: 'warning',
      message: "Part of the reply was cut off at the model's output limit.",
    }
  }
  return { kind: 'warning', message: 'The provider reported an error during this turn.' }
}

/** `compact_boundary`: the conversation was compacted, by request or by itself. */
export function compactionNotice(raw: Record<string, unknown>): ProviderNotice {
  const metadata = object(raw.compact_metadata)
  const trigger = string(metadata.trigger) === 'manual' ? 'manual' : 'auto'
  const tokensBefore = number(metadata.pre_tokens)
  const tokensAfter = number(metadata.post_tokens)
  return {
    kind: 'compacted',
    message: trigger === 'auto' ? 'Conversation compacted automatically' : 'Conversation compacted',
    compaction: {
      trigger,
      ...(tokensBefore !== undefined && tokensBefore >= 0 ? { tokensBefore } : {}),
      ...(tokensAfter !== undefined && tokensAfter >= 0 ? { tokensAfter } : {}),
    },
  }
}

/** `model_refusal_fallback`: the model declined and the turn moved to another one. */
export function refusalFallbackNotice(raw: Record<string, unknown>): ProviderNotice {
  const from = string(raw.original_model)
  const to = string(raw.fallback_model) ?? 'another model'
  const detail = string(raw.api_refusal_explanation)
  return {
    kind: 'model_fallback',
    message: from ? `Switched to ${to} after ${from} declined` : `Switched to ${to}`,
    model: { ...(from ? { from } : {}), to },
    ...(detail ? { detail } : {}),
  }
}

/** `model_refusal_no_fallback`: the model declined and nothing retried it. */
export function refusalNotice(raw: Record<string, unknown>): ProviderNotice {
  const detail = string(raw.api_refusal_explanation)
  return {
    kind: 'refusal',
    message: 'The model declined this request',
    ...(detail ? { detail } : {}),
  }
}

/** Terminal colour codes have no business in a transcript line. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim()
}

/** `informational`. `info` is the CLI's transcript-mode chatter and tool
 * progress dedupes against a tool row; neither belongs in the transcript. */
export function informationalNotice(raw: Record<string, unknown>): ProviderNotice | undefined {
  const level = string(raw.level)
  if (level !== 'warning' && level !== 'suggestion' && level !== 'notice') return undefined
  if (string(raw.tool_use_id)) return undefined
  const content = plain(string(raw.content) ?? '')
  if (!content) return undefined
  return { kind: level === 'warning' ? 'warning' : 'info', message: content }
}

/** `notification`: the CLI's toast queue. Only what it ranks above low. */
export function notificationNotice(raw: Record<string, unknown>): ProviderNotice | undefined {
  const priority = string(raw.priority)
  if (priority !== 'medium' && priority !== 'high' && priority !== 'immediate') return undefined
  const text = plain(string(raw.text) ?? '')
  return text ? { kind: 'info', message: text } : undefined
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'extra usage',
}

/** `rate_limit_event` crossing into `allowed_warning`: a limit is close. */
export function usageWarningNotice(info: Record<string, unknown>): ProviderNotice {
  const type = string(info.rateLimitType)
  const label = type ? LIMIT_LABELS[type] : undefined
  const resetsAt = isoFromEpoch(number(info.resetsAt))
  return {
    kind: 'usage_warning',
    message: label ? `Approaching your ${label} usage limit` : 'Approaching your usage limit',
    ...(resetsAt ? { resetsAt } : {}),
  }
}
