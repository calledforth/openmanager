import type { ConnectionState } from '@openmanager/environment-client'
import { fetchBootstrap } from './bootstrap'
import type { BootstrapOutcome } from './connection-state'
import type { RouteHealthReport, RouteHealthStatus } from './environment-store'

const PROBE_TIMEOUT_MS = 8000

export const WRONG_ENVIRONMENT_MESSAGE = 'A different environment answers at this address.'

/**
 * What a bootstrap answer says about the route it was fetched through. A
 * protocol mismatch still counts as available: the route reached the
 * environment, and the mismatch is the environment's, not the route's. An
 * answer from another environment does not: the address no longer leads here.
 * Returns null while there is no answer yet.
 */
export function routeHealthFromBootstrap(
  outcome: BootstrapOutcome,
  environmentId: string,
): RouteHealthReport | null {
  if (outcome.status === 'ready' || outcome.status === 'incompatible_protocol') {
    if (outcome.environmentId && outcome.environmentId !== environmentId) {
      return { status: 'unreachable', message: WRONG_ENVIRONMENT_MESSAGE }
    }
    return { status: 'available' }
  }
  if (outcome.status === 'unauthorized' || outcome.status === 'unreachable') {
    return { status: outcome.status, message: outcome.message }
  }
  return null
}

/**
 * What the live socket says about the route it dialled. Only the states that
 * are about the route are reported; a connection still being attempted, or one
 * refused over protocol or capabilities, says nothing new.
 */
export function routeHealthFromConnection(
  connection: Pick<ConnectionState, 'phase' | 'failure'>,
): RouteHealthReport | null {
  if (connection.phase === 'connected') return { status: 'available' }
  if (connection.failure?.code === 'auth') {
    return { status: 'unauthorized', message: connection.failure.message }
  }
  if (connection.failure?.code === 'unavailable') {
    return { status: 'unreachable', message: connection.failure.message }
  }
  return null
}

/** Ask a route that is not in use whether it still leads to its environment. */
export async function probeRouteHealth(
  environmentId: string,
  endpoint: string,
): Promise<RouteHealthReport> {
  const outcome = await fetchBootstrap(endpoint, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  return routeHealthFromBootstrap(outcome, environmentId) ?? { status: 'unreachable' }
}

const HEALTH_LABELS: Record<RouteHealthStatus, string> = {
  unknown: 'Not checked',
  available: 'Available',
  unreachable: 'Unavailable',
  unauthorized: 'Not authorized',
}

export function routeHealthLabel(status: RouteHealthStatus): string {
  return HEALTH_LABELS[status]
}
