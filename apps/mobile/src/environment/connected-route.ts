import { linkOf, type PhoneConnectionState } from './controller'
import { routeKindOf, type RouteKind } from './route-order'

/** The route an environment's socket is up on, while it is up. */
export type ConnectedRoute = { endpoint: string; kind: RouteKind }

/**
 * The route an environment is connected through, read off the controller's
 * own state: `null` unless its socket is up. Nothing is assumed from what was
 * saved or what a link named. `environmentId` defaults to the one new
 * sessions go to.
 */
export function connectedRoute(
  state: Pick<PhoneConnectionState, 'links' | 'selectedId'>,
  environmentId: string | null = state.selectedId,
): ConnectedRoute | null {
  const link = linkOf(state, environmentId)
  if (link?.status !== 'connected' || !link.client || !link.endpoint) return null
  return { endpoint: link.endpoint, kind: routeKindOf(link.endpoint) }
}

/** The host an endpoint names, for a person to read (`192.168.1.4:43120`). */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}
