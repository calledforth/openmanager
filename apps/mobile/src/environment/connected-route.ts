import type { PhoneConnectionState, PhoneEnvironment } from './controller'
import { ROUTE_KIND_LABELS, routeKindOf, type RouteKind } from './route-order'

/** The route the controller's socket is up on, while it is up. */
export type ConnectedRoute = { endpoint: string; kind: RouteKind }

/**
 * The route the selected environment is connected through, read off the
 * controller's own state: `null` unless the socket is up. Nothing is assumed
 * from what was saved or what a link named.
 */
export function connectedRoute(state: PhoneConnectionState): ConnectedRoute | null {
  if (state.status !== 'connected' || !state.client || !state.endpoint) return null
  return { endpoint: state.endpoint, kind: routeKindOf(state.endpoint) }
}

/** The selected environment, as the controller holds it. */
export function selectedEnvironment(state: PhoneConnectionState): PhoneEnvironment | null {
  return state.environments.find((item) => item.environmentId === state.selectedId) ?? null
}

/**
 * The environment line under a big title: the selected environment's label,
 * and while connected the kind of route in use (LAN or Tunnel).
 */
export type EnvironmentLine = { label: string; detail?: string; connected: boolean }

export function environmentLine(state: PhoneConnectionState): EnvironmentLine | null {
  const environment = selectedEnvironment(state)
  if (!environment) return null
  const route = connectedRoute(state)
  return route
    ? { label: environment.label, detail: ROUTE_KIND_LABELS[route.kind], connected: true }
    : { label: environment.label, connected: false }
}

/** The host an endpoint names, for a person to read (`192.168.1.4:43120`). */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint
  } catch {
    return endpoint
  }
}
