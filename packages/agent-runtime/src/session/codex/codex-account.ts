import type { v2 } from '@openmanager/codex-app-server-protocol'

/** What `account/read` says about signing in, told apart properly: a
 * signed-in account *also* reports `requiresOpenaiAuth: true`, so that flag
 * alone means nothing. A probe that could not ask is a thrown error, never
 * one of these. */
export type CodexAccountState =
  | { state: 'signed_in'; account: v2.Account }
  | { state: 'signed_out' }
  | { state: 'not_required' }

export function codexAccountState(response: v2.GetAccountResponse): CodexAccountState {
  if (response.account) return { state: 'signed_in', account: response.account }
  return response.requiresOpenaiAuth ? { state: 'signed_out' } : { state: 'not_required' }
}

/** Codex is signed in on the machine, never from openmanager
 * (docs/decisions/codex-app-server.md, "Sign-in from the CLI only"). */
export const CODEX_LOGIN_HINT = 'codex login'
export const CODEX_SIGNED_OUT_MESSAGE = 'Codex is signed out. Run `codex login` on this machine.'

/** How provider health names the account: the email of a ChatGPT login, else
 * what kind of credential it is. */
export function codexAccountLabel(state: CodexAccountState): string | undefined {
  if (state.state !== 'signed_in') return undefined
  const account = state.account
  switch (account.type) {
    case 'chatgpt':
      return account.email ?? `ChatGPT ${account.planType}`
    case 'apiKey':
      return 'API key'
    case 'amazonBedrock':
      return 'Amazon Bedrock'
    case 'gcp':
      return 'Google Cloud'
    default:
      return undefined
  }
}

/** Codex's account as one provider-level fact, whichever process said it.
 *
 * `account/updated` and `account/rateLimits/updated` carry no `threadId`:
 * they describe the login, not a thread, so they are merged here rather than
 * into any session. `account/read` and `account/rateLimits/read` answers land
 * here too, as the full value the notifications then patch. */
export type CodexProviderState = {
  /** The last `account/read`, adjusted by `account/updated` since. Absent
   * until something has asked, or after an update that says the login
   * changed in a way only a fresh read can describe. */
  account?: CodexAccountState
  /** From `account/updated`: how Codex is signed in now (`chatgpt`,
   * `apikey`, …), `null` when it is not. */
  authMode?: v2.AccountUpdatedNotification['authMode']
  planType?: v2.AccountUpdatedNotification['planType']
  /** The single-bucket view (`account/rateLimits/read`'s `rateLimits`),
   * with every rolling update merged in. */
  rateLimits?: v2.RateLimitSnapshot
  /** Every bucket by its `limitId`, merged the same way. */
  rateLimitsByLimitId?: Record<string, v2.RateLimitSnapshot>
  /** ISO time of the last change. */
  updatedAt?: string
}

/** `account/updated` applied to what was known. Signing out is told
 * outright (`authMode: null`); a login or a plan change keeps the account
 * only where the update can say what changed, and otherwise forgets it so
 * the next read describes it. */
export function applyAccountUpdated(
  state: CodexProviderState,
  update: v2.AccountUpdatedNotification,
  at: string,
): CodexProviderState {
  const next: CodexProviderState = {
    ...state,
    authMode: update.authMode,
    planType: update.planType,
    updatedAt: at,
  }
  const account = state.account
  if (update.authMode === null) {
    // Signed out, unless nothing ever needed signing in.
    if (account?.state !== 'not_required') next.account = { state: 'signed_out' }
    return next
  }
  if (account?.state === 'signed_in' && account.account.type === 'chatgpt' && update.authMode === 'chatgpt') {
    next.account = {
      state: 'signed_in',
      account: { ...account.account, ...(update.planType ? { planType: update.planType } : {}) },
    }
    return next
  }
  if (account?.state === 'signed_in' && update.authMode !== 'chatgpt' && account.account.type !== 'chatgpt')
    return next
  // A login the update cannot describe on its own (signed in from signed
  // out, or another kind of account): known to exist, details unknown.
  delete next.account
  return next
}

/** A full `account/rateLimits/read` answer, replacing what was known. */
export function applyRateLimitsRead(
  state: CodexProviderState,
  read: v2.GetAccountRateLimitsResponse,
  at: string,
): CodexProviderState {
  const byId: Record<string, v2.RateLimitSnapshot> = {}
  for (const [id, snapshot] of Object.entries(read.rateLimitsByLimitId ?? {}))
    if (snapshot) byId[id] = snapshot
  const primaryId = read.rateLimits.limitId
  if (primaryId && !byId[primaryId]) byId[primaryId] = read.rateLimits
  return { ...state, rateLimits: read.rateLimits, rateLimitsByLimitId: byId, updatedAt: at }
}

/** `account/rateLimits/updated` merged into what was known.
 *
 * The update is sparse: per the protocol, a `null` in it means "not in this
 * update", never "cleared", so only the values it does carry replace the old
 * ones. The bucket is the update's `limitId`, else the single-bucket view's. */
export function applyRateLimitsUpdated(
  state: CodexProviderState,
  update: v2.AccountRateLimitsUpdatedNotification,
  at: string,
): CodexProviderState {
  const incoming = update.rateLimits
  const limitId = incoming.limitId ?? state.rateLimits?.limitId ?? null
  const byId = { ...state.rateLimitsByLimitId }
  const previous = (limitId ? byId[limitId] : undefined) ?? state.rateLimits
  const merged = mergeSnapshot(previous, incoming, limitId)
  if (limitId) byId[limitId] = merged
  const isPrimary =
    state.rateLimits === undefined || limitId === null || state.rateLimits.limitId === limitId
  return {
    ...state,
    ...(isPrimary ? { rateLimits: merged } : {}),
    rateLimitsByLimitId: byId,
    updatedAt: at,
  }
}

function mergeSnapshot(
  previous: v2.RateLimitSnapshot | undefined,
  incoming: v2.RateLimitSnapshot,
  limitId: string | null,
): v2.RateLimitSnapshot {
  if (!previous) return { ...incoming, limitId }
  const merged = { ...previous } as Record<string, unknown>
  for (const [key, value] of Object.entries(incoming)) if (value !== null) merged[key] = value
  merged.limitId = limitId
  return merged as v2.RateLimitSnapshot
}
