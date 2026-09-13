/**
 * Fixed-window rate limits on the surfaces an attacker or a runaway client can
 * flood (threat model T14). Every policy is documented in the server README;
 * change the table there when changing a number here.
 */
export const RATE_LIMITS = Object.freeze({
  /** Failed credential checks per remote address, on WebSocket upgrade and HTTP. */
  auth_failure: { limit: 10, windowMs: 60_000 },
  /** Pairing-link exchange attempts per remote address; the pairing endpoint (CAL-102) consumes it. */
  pairing: { limit: 5, windowMs: 60_000 },
  /** Local-owner issuance attempts per remote address (`GET /local-owner`). */
  local_owner: { limit: 10, windowMs: 60_000 },
  /** `turn.send` per client. */
  prompt: { limit: 30, windowMs: 60_000 },
  /** Every other mutating command (`operate`, `agent`, `terminal`, `admin`) per client. */
  mutation: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>)

export type RateLimitPolicy = keyof typeof RATE_LIMITS
/** Keys tracked per policy before the entry closest to expiry is evicted. */
export const RATE_LIMIT_MAX_KEYS = 4096

export type RateLimitDecision =
  { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number }

type Window = { count: number; resetAt: number }

export function createRateLimiter(clock: () => number = Date.now) {
  const windows = new Map<RateLimitPolicy, Map<string, Window>>()
  const table = (policy: RateLimitPolicy) => {
    let entries = windows.get(policy)
    if (!entries) {
      entries = new Map()
      windows.set(policy, entries)
    }
    return entries
  }
  const live = (entries: Map<string, Window>, key: string, now: number) => {
    const entry = entries.get(key)
    if (entry && entry.resetAt > now) return entry
    if (entry) entries.delete(key)
    return undefined
  }
  const evict = (entries: Map<string, Window>, now: number) => {
    let soonest: string | undefined
    let soonestAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) {
        entries.delete(key)
        continue
      }
      if (entry.resetAt < soonestAt) {
        soonestAt = entry.resetAt
        soonest = key
      }
    }
    if (entries.size >= RATE_LIMIT_MAX_KEYS && soonest !== undefined) entries.delete(soonest)
  }

  return {
    /** Whether `key` is already over `policy`, without counting a new attempt. */
    blocked(policy: RateLimitPolicy, key: string): RateLimitDecision {
      const now = clock()
      const entry = live(table(policy), key, now)
      const { limit } = RATE_LIMITS[policy]
      if (entry && entry.count >= limit)
        return { allowed: false, retryAfterMs: entry.resetAt - now }
      return { allowed: true, remaining: limit - (entry?.count ?? 0) }
    },

    /** Count one attempt for `key` under `policy` and report whether it fit in the window. */
    consume(policy: RateLimitPolicy, key: string): RateLimitDecision {
      const now = clock()
      const entries = table(policy)
      const { limit, windowMs } = RATE_LIMITS[policy]
      let entry = live(entries, key, now)
      if (!entry) {
        if (entries.size >= RATE_LIMIT_MAX_KEYS) evict(entries, now)
        entry = { count: 0, resetAt: now + windowMs }
        entries.set(key, entry)
      }
      if (entry.count >= limit) return { allowed: false, retryAfterMs: entry.resetAt - now }
      entry.count += 1
      return { allowed: true, remaining: limit - entry.count }
    },

    /** Forget every window. */
    reset(): void {
      windows.clear()
    },
  }
}

export type RateLimiter = ReturnType<typeof createRateLimiter>
