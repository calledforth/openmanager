import type { ProviderNotice, ProviderProblem, ProviderProblemCode } from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'

/** How Codex says what went wrong and what it is doing about it, in
 * openmanager's terms (docs/decisions/codex-app-server.md, "Errors and
 * notices").
 *
 * A failure is typed from `TurnError.codexErrorInfo`, never from prose: every
 * variant 0.170 declares has a row in `codexProblem`, and one added later maps
 * to `unknown` instead of failing. An upstream HTTP status, when a variant
 * carries one, wins over the variant's own default. Nothing here throws. */

/** The name of a `CodexErrorInfo` variant: a plain one as it is, a tagged one
 * (`{ httpConnectionFailed: {…} }`) by its key. */
export function codexErrorName(info: v2.CodexErrorInfo | null | undefined): string | undefined {
  if (typeof info === 'string') return info
  if (info && typeof info === 'object') return Object.keys(info)[0]
  return undefined
}

/** The upstream HTTP status a tagged variant forwards, if any. */
function httpStatusOf(info: v2.CodexErrorInfo | null | undefined): number | undefined {
  if (!info || typeof info !== 'object') return undefined
  const body = Object.values(info)[0] as { httpStatusCode?: unknown } | undefined
  const status = body?.httpStatusCode
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

function codeOfStatus(status: number | undefined): ProviderProblemCode | undefined {
  if (status === undefined) return undefined
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 413) return 'context_window_exceeded'
  if (status === 429) return 'rate_limited'
  if (status === 503 || status === 529) return 'overloaded'
  if (status >= 500) return 'server_error'
  return undefined
}

/** Each variant's kind of trouble, when no HTTP status says otherwise. */
function codeOfName(name: string | undefined): ProviderProblemCode {
  switch (name) {
    case 'contextWindowExceeded':
      return 'context_window_exceeded'
    case 'usageLimitExceeded':
    // A spending cap on the thread: the same "you have used your allowance".
    case 'sessionBudgetExceeded':
      return 'usage_limit'
    case 'rateLimitExceeded':
      return 'rate_limited'
    case 'serverOverloaded':
    // No capacity on the flex tier, or for the account's policy: a passing
    // shortage on OpenAI's side, as an overload is.
    case 'flexUnavailable':
    case 'policyCapacityUnavailable':
      return 'overloaded'
    case 'internalServerError':
      return 'server_error'
    case 'unauthorized':
      return 'unauthorized'
    // The request never got an answer, or its stream broke off.
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      return 'network'
    // A policy declined the request: the model, a cyber or misalignment
    // check, or the user's own inference hook.
    case 'cyberPolicy':
    case 'misalignmentPolicyViolation':
    case 'inferenceHookDenied':
      return 'refused'
    // Nothing the user acts on by kind alone; the detail says what happened.
    case 'modelNotFound':
    case 'badRequest':
    case 'sandboxError':
    case 'tooManyDenials':
    case 'threadRollbackFailed':
    case 'activeTurnNotSteerable':
    case 'other':
    default:
      return 'unknown'
  }
}

/** Codex's own explanation, for the user to read under the typed headline. A
 * policy block's `detailedExplanation` is the explanation when there is one;
 * `additionalDetails` follows. */
function detailOf(error: v2.TurnError): string | undefined {
  const explanation = error.misalignment?.detailedExplanation?.trim() || error.message.trim()
  const extra = error.additionalDetails?.trim()
  const parts = [explanation, extra && extra !== explanation ? extra : undefined].filter(
    (part): part is string => !!part,
  )
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

/** Why a Codex turn failed, typed, with Codex's explanation as the detail. */
export function codexProblem(error: v2.TurnError): ProviderProblem {
  const name = codexErrorName(error.codexErrorInfo)
  const status = httpStatusOf(error.codexErrorInfo)
  // A status the request was answered with is not a connection that failed:
  // an unmapped 4xx (400, 404, 422, …) is the request's own fault, and
  // retrying it as a network error would only fail again.
  const code =
    codeOfStatus(status) ??
    (status !== undefined && status >= 400 && status < 500 ? 'unknown' : codeOfName(name))
  const detail = detailOf(error)
  // No `action`: the host's default for the code is right (try again, sign
  // in), and openmanager cannot compact a Codex thread yet, so a full context
  // offers nothing in the app.
  return { code, ...(detail ? { detail } : {}) }
}

/** The typed problem a refused request carries in its error data, if Codex
 * put a `codexErrorInfo` there. */
export function codexRpcProblem(data: unknown, message: string): ProviderProblem | undefined {
  if (!data || typeof data !== 'object') return undefined
  const info = (data as { codexErrorInfo?: unknown }).codexErrorInfo
  if (info === undefined || info === null) return undefined
  return codexProblem({
    message,
    codexErrorInfo: info as v2.CodexErrorInfo,
    additionalDetails: null,
    misalignment: null,
  })
}

/** "Reconnecting... 2/5": how far through its retries Codex is. Codex says it
 * only in the message, so this is the one place prose is read. */
export function codexRetryOf(message: string): ProviderProblem['retry'] {
  const match = /\b(?:reconnecting|retrying)\b\D*?(\d+)\s*\/\s*(\d+)/i.exec(message)
  if (!match) return undefined
  const attempt = Number(match[1])
  const maxAttempts = Number(match[2])
  if (!(attempt > 0)) return undefined
  return { attempt, ...(maxAttempts > 0 ? { maxAttempts } : {}) }
}

/** An `error` notification with `willRetry`: Codex is retrying and the turn
 * lives on. */
export function codexRetryProblem(notice: v2.ErrorNotification): ProviderProblem {
  const { detail: _detail, ...problem } = codexProblem(notice.error)
  const retry = codexRetryOf(notice.error.message)
  return { ...problem, ...(retry ? { retry } : {}) }
}

// ---------------------------------------------------------------------------
// Notices

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function joined(...parts: Array<string | null | undefined>): string | undefined {
  const kept = parts.map(text).filter((part): part is string => part !== undefined)
  return kept.length > 0 ? kept.join('\n\n') : undefined
}

const REROUTE_REASONS: Record<string, string> = {
  highRiskCyberActivity: 'The request looked like high-risk cyber activity.',
}

const VERIFICATIONS: Record<string, string> = {
  trustedAccessForCyber: 'trusted access for cyber',
}

/** What a Codex notification has to say to the user, as a notice, or nothing.
 * Covers the warnings Codex sends for the user (`warning`, `guardianWarning`,
 * `configWarning`, `deprecationNotice`), a model switch (`model/rerouted`) and
 * verification (`model/verification`), and an MCP server that failed to
 * start. */
export function codexNotice(method: string, params: unknown): ProviderNotice | undefined {
  switch (method) {
    case 'warning':
    case 'guardianWarning': {
      const message = text((params as v2.WarningNotification).message)
      return message ? { kind: 'warning', message } : undefined
    }
    case 'configWarning': {
      const warning = params as v2.ConfigWarningNotification
      const message = text(warning.summary)
      if (!message) return undefined
      const detail = joined(warning.details, warning.path ? `In ${warning.path}` : undefined)
      return { kind: 'warning', message, ...(detail ? { detail } : {}) }
    }
    case 'deprecationNotice': {
      const notice = params as v2.DeprecationNoticeNotification
      const message = text(notice.summary)
      if (!message) return undefined
      const detail = text(notice.details)
      return { kind: 'warning', message, ...(detail ? { detail } : {}) }
    }
    case 'model/rerouted': {
      const rerouted = params as v2.ModelReroutedNotification
      const detail = REROUTE_REASONS[rerouted.reason]
      return {
        kind: 'model_fallback',
        message: `Codex moved this turn from ${rerouted.fromModel} to ${rerouted.toModel}`,
        model: { from: rerouted.fromModel, to: rerouted.toModel },
        ...(detail ? { detail } : {}),
      }
    }
    case 'model/verification': {
      const { verifications } = params as v2.ModelVerificationNotification
      if (!verifications?.length) return undefined
      const names = verifications.map((name) => VERIFICATIONS[name] ?? name).join(', ')
      return { kind: 'info', message: `Codex verified this turn for ${names}` }
    }
    case 'mcpServer/startupStatus/updated': {
      const status = params as v2.McpServerStatusUpdatedNotification
      if (status.status !== 'failed') return undefined
      const detail = joined(
        status.failureReason === 'reauthenticationRequired'
          ? `Sign in to ${status.name} again (\`codex mcp login ${status.name}\`).`
          : undefined,
        status.error,
      )
      return {
        kind: 'warning',
        message: `The MCP server ${status.name} did not start`,
        ...(detail ? { detail } : {}),
      }
    }
    default:
      return undefined
  }
}

/** How the thread changed outside openmanager. */
export type CodexThreadChange = 'closed' | 'archived' | 'deleted' | 'unarchived' | 'reverted' | 'systemError'

/** The notice an outside change to the thread shows in the session. */
export function codexThreadChangeNotice(change: CodexThreadChange): ProviderNotice {
  switch (change) {
    case 'closed':
      return {
        kind: 'warning',
        message: 'Codex closed this conversation outside OpenManager. It reopens with the next message.',
      }
    case 'archived':
      return {
        kind: 'warning',
        message: 'This conversation was archived in Codex. It is unarchived with the next message.',
      }
    case 'deleted':
      return {
        kind: 'warning',
        message:
          'This conversation was deleted in Codex. The next message starts a new Codex thread.',
      }
    case 'unarchived':
      return { kind: 'info', message: 'This conversation was unarchived in Codex.' }
    case 'reverted':
      return {
        kind: 'warning',
        message:
          'This conversation was rewound in Codex outside OpenManager. The history shown here is unchanged.',
      }
    case 'systemError':
      return {
        kind: 'warning',
        message: 'Codex reported a system error on this conversation. It is reopened with the next message.',
      }
  }
}

/** The thread Codex had for the session was gone, so a fresh one took its
 * place. `handedOver`: whether the earlier conversation was passed on. */
export function codexFreshThreadNotice(handedOver: boolean): ProviderNotice {
  return {
    kind: 'warning',
    message: handedOver
      ? 'Codex no longer had this conversation, so it continues in a new Codex thread. The earlier messages were passed on to it.'
      : 'Codex no longer had this conversation, so it continues in a new Codex thread without the earlier context.',
  }
}
