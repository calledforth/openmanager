/**
 * What the phone does when an environment refuses its credential.
 *
 * The environment closes the socket with the revocation code; the shared
 * client stops for good (no redial) and marks the failure
 * `credentialRevoked`, and `routeHealthFromConnection` passes that on as
 * `revoked`. The connection latches `credential_rejected` for the
 * environment, which the shared `deriveConnectionUi` shows as "Not
 * authorized" with no retry. On top of that the phone forgets the credential
 * (`forgetRejectedCredential`), so it is never sent again, and SecureStore
 * loses it on the next registry write. The environment stays in the registry
 * (its label, routes and selection), reading as needing to pair again
 * (`environmentNeedsPairing`), which is what the re-pair path offers.
 *
 * Only a revocation drops the credential. Other `auth` failures (this client
 * finding a different environment at the address, for one) leave it alone:
 * forgetting a credential cannot be undone without pairing again.
 */
import type { ConnectionFailure } from '@openmanager/environment-client'
import {
  findStoredEnvironment,
  type EnvironmentRegistry,
  type RouteHealthReport,
  type StoredEnvironment,
} from '@openmanager/environment-client/connection'

/** The live connection's failure says the environment refused this credential. */
export function isRevokedCredentialFailure(
  failure: Pick<ConnectionFailure, 'code' | 'credentialRevoked'> | null | undefined,
): boolean {
  return failure?.code === 'auth' && failure.credentialRevoked === true
}

/** A route-health report says the environment refused this credential. */
export function isRevokedCredentialReport(report: RouteHealthReport | null | undefined): boolean {
  return report?.status === 'unauthorized' && report.revoked === true
}

/**
 * The registry without the credential the environment refused. `rejected` is
 * the credential the refused socket carried: if the environment's credential
 * has changed since (paired again, rotated), the refusal is about a token
 * nobody uses any more and the registry is returned unchanged. Label, routes
 * and selection are kept.
 */
export function forgetRejectedCredential(
  registry: EnvironmentRegistry,
  environmentId: string,
  rejected: string,
): EnvironmentRegistry {
  const existing = findStoredEnvironment(registry.environments, environmentId)
  if (!existing || !rejected || existing.credential !== rejected) return registry
  return {
    ...registry,
    environments: registry.environments.map((item) =>
      item === existing ? { ...existing, credential: '' } : item,
    ),
  }
}

/**
 * The environment is saved but has no credential: it was refused, never
 * paired, or SecureStore could not read it. The phone offers to pair again.
 */
export function environmentNeedsPairing(environment: StoredEnvironment | undefined): boolean {
  return environment !== undefined && environment.credential === ''
}
