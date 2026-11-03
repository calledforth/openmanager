import {
  isLoopbackEnvironmentEndpoint,
  routeHealthLabel,
  WRONG_ENVIRONMENT_MESSAGE,
  type RouteHealthStatus,
} from '@openmanager/environment-client/connection'

import { endpointHost } from '../environment/connected-route'
import type { PhoneConnectionView, PhoneConnectionTone } from '../environment/connection-ui'
import type { PhoneConnectionState, PhoneEnvironment } from '../environment/controller'
import {
  ROUTE_KIND_LABELS,
  phoneRouteOrder,
  routeKindOf,
  type RouteKind,
} from '../environment/route-order'

/**
 * One route of an environment as the phone shows it: where it goes, how the
 * phone reaches it, whether the socket is on it now, and the last thing this
 * phone learned about it (its own record, from its own probes and sockets).
 */
export type RouteRowView = {
  endpoint: string
  host: string
  kind: RouteKind
  /** "This device", "Local network" or "Tunnel". */
  title: string
  inUse: boolean
  health: RouteHealthStatus
  /** "Available", "Unavailable", "Not checked", "Not authorized", or another environment answering. */
  healthWords: string
  /** When that last changed (ISO), when it has been checked. */
  changedAt: string | null
}

export type EnvironmentCardView = {
  environmentId: string
  label: string
  /** The environment the phone connects to. */
  selected: boolean
  /** The phone holds a token for it. */
  paired: boolean
  tone: PhoneConnectionTone
  /** The route in use (selected and connected), else the one the phone would ask first. */
  route: { kind: RouteKind; host: string } | null
  /** A short line when there is no route in use to show: the state, in the shared words. */
  words: string | null
  /** When `words` is a route's health: when that was learned (ISO). */
  since: string | null
}

function routeTitle(endpoint: string, kind: RouteKind): string {
  if (isLoopbackEnvironmentEndpoint(endpoint)) return 'This device'
  return kind === 'lan' ? 'Local network' : 'Tunnel'
}

/**
 * The routes in the phone's usual order of preference: this device and its
 * local network first, then the rest, each group in the saved order. This is
 * not a promise about the next attempt: after a drop the controller asks the
 * route in use first again, and a route whose socket just failed waits behind
 * the others for a minute (`PHONE_SOCKET_FAILURE_COOLDOWN_MS`).
 */
export function routeRows(environment: PhoneEnvironment, inUse: string | null): RouteRowView[] {
  return phoneRouteOrder(environment.routes).map((route) => {
    const kind = routeKindOf(route.endpoint)
    return {
      endpoint: route.endpoint,
      host: endpointHost(route.endpoint),
      kind,
      title: routeTitle(route.endpoint, kind),
      inUse: route.endpoint === inUse,
      health: route.health.status,
      healthWords:
        route.health.message === WRONG_ENVIRONMENT_MESSAGE
          ? 'Another environment answers here'
          : routeHealthLabel(route.health.status),
      changedAt: route.health.changedAt ?? null,
    }
  })
}

/**
 * The selected environment's state in a few words, for a card or the line
 * under a title: the shared derivation's own title or detail, never new
 * meaning. `null` once connected, where the route in use says it instead.
 */
export function shortConnectionWords(view: PhoneConnectionView): string | null {
  const { ui } = view
  switch (ui.kind) {
    case 'ready':
      return null
    case 'connecting':
      return 'Connecting…'
    case 'reconnecting':
    case 'unreachable':
      return ui.detail ?? ui.title
    case 'offline':
    case 'unauthorized':
    case 'incompatible_protocol':
    case 'confirm_route':
    case 'no_environment':
      return ui.title
  }
}

/**
 * The line under an environment's page title, where the connection panel
 * below already gives the title, the cause and the countdown: just the state.
 */
export function pageStatusWords(view: PhoneConnectionView): string {
  const { ui } = view
  switch (ui.kind) {
    case 'ready':
      return view.route ? `Connected over ${ROUTE_KIND_LABELS[view.route.kind]}` : ui.title
    case 'connecting':
      return 'Connecting…'
    case 'reconnecting':
    case 'unreachable':
      return ui.retrying ? 'Reconnecting' : ui.title
    case 'offline':
    case 'unauthorized':
    case 'incompatible_protocol':
    case 'confirm_route':
    case 'no_environment':
      return ui.title
  }
}

/** The line under the routes: the usual preference, and that failover is temporary. */
export const ROUTE_ORDER_NOTE =
  'Usually this device and the local network first, then the rest. After a drop the route in use is tried again first, and one that just failed waits about a minute.'

const HEALTH_TONES: Record<RouteHealthStatus, PhoneConnectionTone> = {
  available: 'ok',
  unknown: 'idle',
  unreachable: 'warn',
  unauthorized: 'error',
}

/**
 * The Settings cards, one per saved environment, in the saved order. The
 * selected one reads the live connection; the others, which the phone is not
 * connected to, show the last thing it learned about their first route.
 */
export function environmentCards(
  state: PhoneConnectionState,
  view: PhoneConnectionView,
): EnvironmentCardView[] {
  return state.environments.map((environment) => {
    const selected = environment.environmentId === state.selectedId
    const routes = routeRows(environment, selected ? (view.route?.endpoint ?? null) : null)
    if (selected) {
      const words = environment.paired ? shortConnectionWords(view) : 'Needs pairing again'
      const shown = view.route
        ? { kind: view.route.kind, host: endpointHost(view.route.endpoint) }
        : null
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        selected,
        paired: environment.paired,
        tone: environment.paired ? view.tone : 'error',
        route: shown,
        words: shown ? null : words,
        since: null,
      }
    }
    // The route that last answered, else the first the phone would ask.
    const first = routes.find((route) => route.health === 'available') ?? routes[0]
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      selected,
      paired: environment.paired,
      tone: environment.paired ? (first ? HEALTH_TONES[first.health] : 'idle') : 'error',
      route:
        first && first.health !== 'unreachable' ? { kind: first.kind, host: first.host } : null,
      words: !environment.paired
        ? 'Needs pairing again'
        : first && first.health === 'unreachable'
          ? first.healthWords
          : null,
      since: environment.paired && first?.health === 'unreachable' ? first.changedAt : null,
    }
  })
}
