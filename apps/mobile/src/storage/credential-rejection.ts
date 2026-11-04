/**
 * What the phone does when its credential is refused.
 *
 * Whatever answers closes the socket with the revocation code; the shared
 * client stops for good (no redial) and says how the credential was refused
 * (`credentialRefusal`), which `routeHealthFromConnection` passes on. The
 * connection latches `credential_rejected` for the environment, which the
 * shared `deriveConnectionUi` shows as "Not authorized" with no retry. That
 * part is the same as on the web.
 *
 * On top of it the phone forgets the credential, so it is never sent again
 * and SecureStore loses it with the next registry write, but only once it is
 * sure the environment itself refused it (`confirmCredentialRejected`):
 *
 * - `revoked`: the environment accepted the credential and then revoked it.
 *   Only the environment that issued it knows it, so this is certain.
 * - `unknown`: what answered does not know the credential. The environment
 *   revoking it while the phone was away looks like this, and so does an
 *   address that now leads to a different environment. The phone asks the
 *   same address which environment it is (`/bootstrap`, no credential sent)
 *   and forgets the credential only if it is the same one.
 *
 * Forgetting cannot be undone without pairing again, so anything short of
 * that (no answer, another environment) keeps the credential. The latch
 * still stops any retry either way.
 *
 * The environment stays in the registry (its label, routes and selection),
 * reading as needing to pair again (`environmentNeedsPairing`), which is what
 * the re-pair path offers.
 */
import type { ConnectionFailure, CredentialRefusal } from '@openmanager/environment-client'
import {
  fetchBootstrap,
  findStoredEnvironment,
  noLoopbackGate,
  type BootstrapOutcome,
  type EnvironmentRegistry,
  type RouteHealthReport,
  type StoredEnvironment,
} from '@openmanager/environment-client/connection'

const CONFIRM_TIMEOUT_MS = 6000

/** How the credential was refused, from a connection failure or a route-health report. */
export function credentialRefusalOf(
  signal:
    | Pick<ConnectionFailure, 'code' | 'credentialRefusal'>
    | Pick<RouteHealthReport, 'status' | 'credentialRefusal'>
    | null
    | undefined,
): CredentialRefusal | null {
  if (!signal) return null
  const refused = 'code' in signal ? signal.code === 'auth' : signal.status === 'unauthorized'
  return refused ? (signal.credentialRefusal ?? null) : null
}

/**
 * Whether the environment itself refused the credential, so the phone may
 * forget it. `endpoint` is the route that refused it. `probe` asks that route
 * which environment it is; by default the shared unauthenticated bootstrap.
 */
export async function confirmCredentialRejected(input: {
  refusal: CredentialRefusal | null
  environmentId: string
  endpoint: string
  probe?: (endpoint: string) => Promise<BootstrapOutcome>
}): Promise<boolean> {
  if (input.refusal === 'revoked') return true
  if (input.refusal !== 'unknown') return false
  const probe =
    input.probe ??
    ((endpoint: string) =>
      fetchBootstrap(endpoint, {
        loopbackAccessDenied: noLoopbackGate,
        timeoutMs: CONFIRM_TIMEOUT_MS,
      }))
  let outcome: BootstrapOutcome
  try {
    outcome = await probe(input.endpoint)
  } catch {
    return false
  }
  return (
    (outcome.status === 'ready' || outcome.status === 'incompatible_protocol') &&
    outcome.environmentId === input.environmentId
  )
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
