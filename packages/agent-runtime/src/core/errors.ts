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
