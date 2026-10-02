import { fetchBootstrap } from './bootstrap'
import type { BootstrapOutcome, RouteFailure, RouteFailureReason } from './connection-state'
import {
  isLoopbackEnvironmentEndpoint,
  routeSearchOrder,
  type StoredEnvironment,
} from './environment-store'

const SEARCH_TIMEOUT_MS = 6000

/**
 * Statuses a gateway (a tunnel, a reverse proxy) answers with when it is up
 * but the server behind it is not. Cloudflare, Tailscale and ngrok all answer
 * 502 when their tunnel is connected and nothing listens at the origin.
 */
const ORIGIN_DOWN_STATUSES = new Set([502, 503, 504])

/**
 * What a bootstrap answer says is wrong with a route, or null when the route
 * reached the environment it belongs to. A protocol mismatch reached it: that
 * is the environment's to fix, not the route's.
 */
export function routeFailureReason(
  outcome: BootstrapOutcome,
  environmentId: string,
  endpoint: string,
): RouteFailureReason | null {
  if (outcome.status === 'ready' || outcome.status === 'incompatible_protocol') {
    return outcome.environmentId && outcome.environmentId !== environmentId
      ? 'wrong_environment'
      : null
  }
  if (outcome.status === 'unauthorized') return 'route_refused'
  if (outcome.status !== 'unreachable') return null
  if (outcome.cause === 'http' && ORIGIN_DOWN_STATUSES.has(outcome.httpStatus ?? 0)) {
    return 'environment_offline'
  }
  // Nothing answering on this device's own loopback address means nothing is
  // listening there. Over a network the same silence could be either side.
  if (outcome.cause === 'network' && isLoopbackEnvironmentEndpoint(endpoint)) {
    return 'environment_offline'
  }
  return 'route_down'
}

/**
 * Which reason to show when several routes failed. A sign that the server
 * itself is down explains every other failure, so it wins; a refusal is next,
 * since a person can act on it; then an address that now leads to another
 * environment, which says what changed; a route that is simply down is the
 * least specific.
 */
const REASON_RANK: readonly RouteFailureReason[] = [
  'credential_rejected',
  'environment_offline',
  'route_refused',
  'wrong_environment',
  'route_down',
]

export type RouteProbe = {
  endpoint: string
  outcome: BootstrapOutcome
  /** Null when the route reached its environment. */
  reason: RouteFailureReason | null
  /** The answer was handed in rather than fetched by this search. */
  known: boolean
}

/** The one failure to show for routes that all failed, or null if one did not. */
export function summarizeRouteFailures(probes: readonly RouteProbe[]): RouteFailure | null {
  let worst: RouteProbe | undefined
  for (const probe of probes) {
    if (!probe.reason) return null
    if (!worst || REASON_RANK.indexOf(probe.reason) < REASON_RANK.indexOf(worst.reason!)) {
      worst = probe
    }
  }
  if (!worst) return null
  const message =
    worst.outcome.status === 'unauthorized' || worst.outcome.status === 'unreachable'
      ? worst.outcome.message
      : undefined
  return {
    reason: worst.reason!,
    endpoint: worst.endpoint,
    local: isLoopbackEnvironmentEndpoint(worst.endpoint),
    tried: probes.length,
    ...(message ? { message } : {}),
  }
}

export type RouteSearchResult =
  | { found: string; probes: RouteProbe[] }
  | { found: null; probes: RouteProbe[]; failure: RouteFailure }

/**
 * Try the environment's routes in search order and return the first that
 * reaches it. Every route is asked at once, but a route is only chosen after
 * every route ahead of it has failed, so a slow local answer still beats a
 * fast tunnel. `known` hands in an answer this attempt already has, so that
 * route is not asked twice. `first` is asked on its own before the rest, which
 * are only asked if it fails: the check for a route that may only have
 * blinked.
 */
export async function searchRoutes(
  environment: StoredEnvironment,
  options: {
    known?: { endpoint: string; outcome: BootstrapOutcome }
    first?: string
    probe?: (endpoint: string) => Promise<BootstrapOutcome>
  } = {},
): Promise<RouteSearchResult> {
  const probe =
    options.probe ??
    ((endpoint: string) =>
      fetchBootstrap(endpoint, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) }))
  const answers = new Map<string, BootstrapOutcome>()
  if (options.known) answers.set(options.known.endpoint, options.known.outcome)
  const first = environment.routes.find((route) => route.endpoint === options.first)
  if (first && !answers.has(first.endpoint)) {
    const outcome = await probe(first.endpoint)
    const reason = routeFailureReason(outcome, environment.environmentId, first.endpoint)
    if (!reason) {
      return {
        found: first.endpoint,
        probes: [{ endpoint: first.endpoint, outcome, reason, known: false }],
      }
    }
    answers.set(first.endpoint, outcome)
  }
  const pending = routeSearchOrder(environment).map((route) => {
    const answer = answers.get(route.endpoint)
    return {
      endpoint: route.endpoint,
      known: answer !== undefined && route.endpoint === options.known?.endpoint,
      outcome: answer !== undefined ? Promise.resolve(answer) : probe(route.endpoint),
    }
  })
  const probes: RouteProbe[] = []
  for (const item of pending) {
    const outcome = await item.outcome
    const reason = routeFailureReason(outcome, environment.environmentId, item.endpoint)
    probes.push({ endpoint: item.endpoint, outcome, reason, known: item.known })
    if (!reason) return { found: item.endpoint, probes }
  }
  return { found: null, probes, failure: summarizeRouteFailures(probes)! }
}
