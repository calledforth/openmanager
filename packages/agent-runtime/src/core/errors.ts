import type { CapabilityKey, ProviderId } from '@agentpack/contract'
export class CapabilityMissingError extends Error {
  readonly name = 'CapabilityMissingError'
  constructor(
    readonly providerId: ProviderId,
    readonly capability: CapabilityKey,
    readonly operation: string,
  ) {
    super(`${providerId} does not support ${operation}`)
  }
}
/**
 * A session that must be loaded (`load: 'require'`) is unknown to the agent.
 * Under that policy the runtime refuses to create a session in its place: its
 * transcript lives in the agent, so a fresh one would silently lose it.
 */
export class SessionUnknownError extends Error {
  readonly name = 'SessionUnknownError'
  constructor(
    readonly providerId: ProviderId,
    readonly sessionId: string | undefined,
  ) {
    super(
      sessionId
        ? `${providerId} no longer knows session ${sessionId}`
        : `${providerId} has no session to load`,
    )
  }
}

export class AuthRequiredError extends Error {
  readonly name = 'AuthRequiredError'
  constructor(
    readonly providerId: ProviderId,
    message: string,
    readonly loginHint: string,
  ) {
    super(message)
  }
}
