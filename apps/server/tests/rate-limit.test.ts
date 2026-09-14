import { describe, expect, it } from 'vitest'
import { createRateLimiter, RATE_LIMIT_MAX_KEYS, RATE_LIMITS } from '../src/rate-limit.js'

describe('rate limiter', () => {
  it('documents one policy per flooded surface', () => {
    // The README table mirrors these numbers; a change here must change it too.
    expect(RATE_LIMITS).toEqual({
      auth_failure: { limit: 10, windowMs: 60_000 },
      pairing: { limit: 5, windowMs: 60_000 },
      local_owner: { limit: 10, windowMs: 60_000 },
      prompt: { limit: 30, windowMs: 60_000 },
      mutation: { limit: 120, windowMs: 60_000 },
    })
  })

  it('admits up to the limit per key and window, then refuses with the time to wait', () => {
    let now = 1_000
    const limiter = createRateLimiter(() => now)
    const { limit, windowMs } = RATE_LIMITS.pairing
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      expect(limiter.consume('pairing', '203.0.113.7')).toEqual({
        allowed: true,
        remaining: limit - attempt,
      })
    }
    now += 10_000
    expect(limiter.consume('pairing', '203.0.113.7')).toEqual({
      allowed: false,
      retryAfterMs: windowMs - 10_000,
    })
    expect(limiter.blocked('pairing', '203.0.113.7')).toEqual({
      allowed: false,
      retryAfterMs: windowMs - 10_000,
    })
    // Other keys and other policies keep their own budget.
    expect(limiter.consume('pairing', '203.0.113.8')).toEqual({
      allowed: true,
      remaining: limit - 1,
    })
    expect(limiter.consume('auth_failure', '203.0.113.7')).toEqual({
      allowed: true,
      remaining: RATE_LIMITS.auth_failure.limit - 1,
    })
    // The window is fixed from the first attempt; it opens again when it ends.
    now = 1_000 + windowMs
    expect(limiter.blocked('pairing', '203.0.113.7')).toEqual({ allowed: true, remaining: limit })
    expect(limiter.consume('pairing', '203.0.113.7')).toEqual({
      allowed: true,
      remaining: limit - 1,
    })
  })

  it('checks a lockout without spending an attempt', () => {
    const limiter = createRateLimiter(() => 0)
    expect(limiter.blocked('prompt', 'client-1')).toEqual({
      allowed: true,
      remaining: RATE_LIMITS.prompt.limit,
    })
    expect(limiter.consume('prompt', 'client-1')).toEqual({
      allowed: true,
      remaining: RATE_LIMITS.prompt.limit - 1,
    })
    expect(limiter.blocked('prompt', 'client-1')).toEqual({
      allowed: true,
      remaining: RATE_LIMITS.prompt.limit - 1,
    })
  })

  it('bounds tracked keys by evicting the window closest to expiry', () => {
    let now = 0
    const limiter = createRateLimiter(() => now)
    for (let key = 0; key < RATE_LIMIT_MAX_KEYS; key += 1) {
      limiter.consume('mutation', `client-${key}`)
      now += 1
    }
    // client-0 has the earliest reset, so it is the one forgotten.
    limiter.consume('mutation', 'client-new')
    expect(limiter.blocked('mutation', 'client-0')).toEqual({
      allowed: true,
      remaining: RATE_LIMITS.mutation.limit,
    })
    expect(limiter.blocked('mutation', 'client-1')).toEqual({
      allowed: true,
      remaining: RATE_LIMITS.mutation.limit - 1,
    })
    limiter.reset()
    expect(limiter.blocked('mutation', 'client-1')).toEqual({
      allowed: true,
      remaining: RATE_LIMITS.mutation.limit,
    })
  })
})
