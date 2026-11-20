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
  // Named too, so a sign-in after it reads as another account.
  if (state.state === 'not_required') return 'No sign-in'
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
  /** The main bucket (`CODEX_MAIN_LIMIT_ID`), with every rolling update
   * merged in: the limits openmanager shows. */
  rateLimits?: v2.RateLimitSnapshot
  /** Every bucket by its `limitId`, merged the same way. */
  rateLimitsByLimitId?: Record<string, v2.RateLimitSnapshot>
  /** ISO time of the last change. */
  updatedAt?: string
}

/** `account/updated` applied to what was known.
 *
 * Signing out is told outright (`authMode: null`), and takes the account's
 * limits with it. Otherwise the update says how Codex is signed in but not
 * as whom: a ChatGPT login that stays a ChatGPT login keeps its details with
 * the new plan; anything else forgets the account until it is read again
 * (the service re-reads it on every such update). Either way `authMode`
 * says a login exists. */
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
    return withoutLimits(next)
  }
  if (account?.state === 'signed_in' && account.account.type === 'chatgpt' && update.authMode === 'chatgpt') {
    next.account = {
      state: 'signed_in',
      account: { ...account.account, ...(update.planType ? { planType: update.planType } : {}) },
    }
    // The same login says so on every start; a new plan means new limits.
    const samePlan = update.planType === null || update.planType === account.account.planType
    return samePlan ? next : withoutLimits(next)
  }
  // Another kind of login, or one nothing was known about: whose limits
  // these were cannot be told.
  delete next.account
  return withoutLimits(next)
}

/** A full `account/read` answer. A different account (another kind of
 * login, another email) takes the limits known so far with it: they were
 * the previous account's. */
export function applyAccountRead(
  state: CodexProviderState,
  account: CodexAccountState,
  at: string,
): CodexProviderState {
  const next: CodexProviderState = { ...state, account, updatedAt: at }
  return sameAccount(state.account, account) ? next : withoutLimits(next)
}

function sameAccount(before: CodexAccountState | undefined, after: CodexAccountState): boolean {
  // Nothing known yet: limits read before the first account read are this one's.
  if (!before) return true
  if (before.state !== after.state) return false
  if (before.state !== 'signed_in' || after.state !== 'signed_in') return true
  const a = before.account
  const b = after.account
  if (a.type !== b.type) return false
  return a.type === 'chatgpt' && b.type === 'chatgpt' ? a.email === b.email : true
}

function withoutLimits(state: CodexProviderState): CodexProviderState {
  const next = { ...state }
  delete next.rateLimits
  delete next.rateLimitsByLimitId
  return next
}

/** Signed in, signed out or no sign-in needed, as far as anything has said:
 * the account read, else what the last `account/updated` implied. */
export function codexSignInState(state: CodexProviderState): CodexAccountState['state'] | undefined {
  if (state.account) return state.account.state
  if (state.authMode === undefined) return undefined
  return state.authMode === null ? 'signed_out' : 'signed_in'
}

/** The metered bucket that is Codex's own plan limits. Other buckets (a
 * model with an allowance of its own) arrive through the same
 * `account/rateLimits/updated`, and taken as the main one they overwrite it
 * (T3 Code hit this), so they are kept by id and never shown. */
export const CODEX_MAIN_LIMIT_ID = 'codex'

/** A bucket with no id is the main one: older CLIs name none. */
export function isCodexMainBucket(limitId: string | null | undefined): boolean {
  return limitId === null || limitId === undefined || limitId === CODEX_MAIN_LIMIT_ID
}

/** A full `account/rateLimits/read` answer, replacing what was known. The
 * main bucket is the one by its id, else the single-bucket view when that
 * one is it. */
export function applyRateLimitsRead(
  state: CodexProviderState,
  read: v2.GetAccountRateLimitsResponse,
  at: string,
): CodexProviderState {
  const byId: Record<string, v2.RateLimitSnapshot> = {}
  for (const [id, snapshot] of Object.entries(read.rateLimitsByLimitId ?? {}))
    if (snapshot) byId[id] = snapshot
  const single = read.rateLimits
  const singleId = single.limitId ?? CODEX_MAIN_LIMIT_ID
  if (!byId[singleId]) byId[singleId] = single
  const main = byId[CODEX_MAIN_LIMIT_ID]
  const next: CodexProviderState = { ...state, rateLimitsByLimitId: byId, updatedAt: at }
  if (main) next.rateLimits = main
  else delete next.rateLimits
  return next
}

/** `account/rateLimits/updated` merged into what was known.
 *
 * The update is sparse: per the protocol, a `null` in it means "not in this
 * update", never "cleared", so only the values it does carry replace the old
 * ones, inside a window too. It goes to its own bucket; only the main
 * bucket's is the provider's `rateLimits`. */
export function applyRateLimitsUpdated(
  state: CodexProviderState,
  update: v2.AccountRateLimitsUpdatedNotification,
  at: string,
): CodexProviderState {
  const incoming = update.rateLimits
  const main = isCodexMainBucket(incoming.limitId)
  const limitId = incoming.limitId ?? CODEX_MAIN_LIMIT_ID
  const byId = { ...state.rateLimitsByLimitId }
  const previous = byId[limitId] ?? (main ? state.rateLimits : undefined)
  const merged = mergeSnapshot(previous, incoming, limitId)
  byId[limitId] = merged
  return {
    ...state,
    ...(main ? { rateLimits: merged } : {}),
    rateLimitsByLimitId: byId,
    updatedAt: at,
  }
}

function mergeSnapshot(
  previous: v2.RateLimitSnapshot | undefined,
  incoming: v2.RateLimitSnapshot,
  limitId: string,
): v2.RateLimitSnapshot {
  if (!previous) return { ...incoming, limitId }
  const merged = { ...previous } as Record<string, unknown>
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) continue
    const before = merged[key]
    // A window, the credits: a field the update left null keeps its value
    // (a window's length, its reset time).
    merged[key] = isRecord(value) && isRecord(before) ? overlay(before, value) : value
  }
  merged.limitId = limitId
  return merged as v2.RateLimitSnapshot
}

function overlay(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out = { ...before }
  for (const [key, value] of Object.entries(after)) if (value !== null) out[key] = value
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
