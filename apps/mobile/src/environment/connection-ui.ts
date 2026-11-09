import { PROTOCOL_VERSION } from '@openmanager/protocol'
import {
  deriveConnectionUi,
  type BootstrapOutcome,
  type ConnectionUiState,
  type DeriveConnectionInput,
  type EnvironmentSelection,
  type TransportStatus,
} from '@openmanager/environment-client/connection'

import {
  linkOf,
  statusOf,
  type PhoneConnectionState,
  type PhoneConnectionStatus,
  type PhoneEnvironment,
  type PhoneLinkState,
} from './controller'
import { phoneRouteOrder, routeKindOf, type RouteKind } from './route-order'

/**
 * What a person can do next about a connection, as the phone offers it.
 *
 * - `retry`: search the environment's routes again now (`controller.retry`).
 * - `pair_again`: the environment refused this phone's token; only a new
 *   pairing link helps (the pairing screen).
 * - `pair`: nothing is saved yet; pair with a computer.
 * - `network_settings`: the device has no network; the phone's own network
 *   settings, where airplane mode and Wi-Fi are. The phone reconnects on its
 *   own once the network is back.
 *
 * There is no "switch environment": every saved environment is connected at
 * once, each on its own, so going to another one fixes nothing about this one.
 */
export type PhoneNextStep = 'retry' | 'pair_again' | 'pair' | 'network_settings'

/** How the state reads at a glance: the colour of its dot. */
export type PhoneConnectionTone = 'ok' | 'working' | 'warn' | 'error' | 'idle'

export type PhoneConnectionView = {
  /** The shared derivation's own answer: the same kind, title and words web shows. */
  ui: ConnectionUiState
  /** The environment the state is about; `null` with none saved. */
  environmentId: string | null
  tone: PhoneConnectionTone
  /** The next steps, the first the main one. Empty when nothing is needed. */
  next: readonly PhoneNextStep[]
  /** The route the socket is up on, while it is up. */
  route: { endpoint: string; kind: RouteKind } | null
  /** When the controller asks again on its own, while it is waiting to. */
  retryAt: number | null
}

/** What a view of one environment is read from. */
export type PhoneConnectionReading = Pick<
  PhoneConnectionState,
  'loaded' | 'links' | 'environments' | 'network' | 'selectedId'
>

const NONE: EnvironmentSelection = { status: 'none' }

/** One environment's part of the phone's state. */
type Reading = {
  status: PhoneConnectionStatus
  environment: PhoneEnvironment | null
  link: PhoneLinkState | null
  network: PhoneConnectionState['network']
}

function readingOf(state: PhoneConnectionReading, environmentId: string | null): Reading {
  return {
    status: statusOf(state, environmentId),
    environment: state.environments.find((item) => item.environmentId === environmentId) ?? null,
    link: linkOf(state, environmentId),
    network: state.network,
  }
}

/**
 * The route a sentence names: the one in use, else the first the phone would
 * ask (local network first). A saved environment always has one.
 */
function namedEndpoint(link: PhoneLinkState | null, environment: PhoneEnvironment): string {
  const endpoint = link?.endpoint
  if (endpoint && environment.routes.some((route) => route.endpoint === endpoint)) {
    return endpoint
  }
  return phoneRouteOrder(environment.routes)[0]?.endpoint ?? ''
}

/**
 * The socket as the shared derivation reads it, from the controller's status.
 *
 * The controller is the only thing that retries: its environment clients are
 * made with `maxAttempts: 0`, so a client's own `retriesExhausted` is true
 * after every drop and says nothing about whether the phone will ask again.
 * It is never passed on; the controller's status says that instead.
 * `hasConnected` is whether the phone still holds a client the environment
 * accepted (it is kept through a drop, a hold and a change of route).
 */
function transportOf({ status, link }: Reading): TransportStatus {
  const hasConnected = (link?.client ?? null) !== null
  const failure = link?.connection?.failure ?? null
  switch (status) {
    case 'connected':
      return { phase: 'connected', hasConnected: true, failure: null }
    case 'waiting':
      // A socket that failed while opening, or soon after; or no route
      // answered (the route failure then says why).
      return {
        phase: 'closed',
        hasConnected,
        failure: link?.routeFailure ? null : { code: 'unreachable', message: failure?.message },
      }
    case 'unauthorized':
      return {
        phase: 'closed',
        hasConnected,
        failure: { code: 'auth', message: failure?.message },
      }
    case 'incompatible_protocol':
      return {
        phase: 'closed',
        hasConnected,
        failure: { code: 'protocol_incompatible', message: failure?.message },
      }
    case 'starting':
    case 'no_environment':
    case 'searching':
    case 'connecting':
    case 'held':
    case 'offline':
      return { phase: hasConnected ? 'reconnecting' : 'connecting', hasConnected, failure: null }
  }
}

/**
 * A connected socket is proof its route reaches this environment in this
 * protocol: its handshake said so. As on web, a bootstrap that has not
 * answered `ready` does not outweigh it.
 */
function bootstrapOf({ status, link }: Reading, environment: PhoneEnvironment): BootstrapOutcome {
  const bootstrap: BootstrapOutcome = link?.bootstrap ?? { status: 'idle' }
  if (status === 'connected' && bootstrap.status !== 'ready') {
    return {
      status: 'ready',
      environmentId: environment.environmentId,
      label: environment.label,
      protocolVersion: PROTOCOL_VERSION,
    }
  }
  return bootstrap
}

function inputOf(reading: Reading): DeriveConnectionInput {
  const { environment, link, status } = reading
  if (!environment || status === 'no_environment') {
    return { environment: NONE, bootstrap: { status: 'idle' }, transport: transportOf(reading) }
  }
  return {
    environment: {
      status: 'selected',
      endpoint: namedEndpoint(link, environment),
      environmentId: environment.environmentId,
      label: environment.label,
    },
    bootstrap: bootstrapOf(reading, environment),
    transport: transportOf(reading),
    network: reading.network,
    ...(link?.routeFailure ? { routeFailure: link.routeFailure } : {}),
    autoRetry: true,
  }
}

/**
 * One environment's connection, as the shared `deriveConnectionUi` input.
 * Every field is what the controller holds; nothing is guessed. The
 * environment's saved label names it, since the bootstrap's own label is
 * already copied there when it answers. `environmentId` defaults to the one
 * new sessions go to, which with one saved is the only one.
 */
export function phoneConnectionInput(
  state: PhoneConnectionReading,
  environmentId: string | null = state.selectedId,
): DeriveConnectionInput {
  return inputOf(readingOf(state, environmentId))
}

const TONES: Record<ConnectionUiState['kind'], PhoneConnectionTone> = {
  ready: 'ok',
  connecting: 'working',
  reconnecting: 'working',
  confirm_route: 'warn',
  unreachable: 'warn',
  offline: 'warn',
  unauthorized: 'error',
  incompatible_protocol: 'error',
  no_environment: 'idle',
}

/**
 * Where one environment's connection stands, in the shared derivation's
 * words, with the phone's next steps. The shared actions map onto what the
 * phone can do: "retry" is the controller's retry of that environment; for a
 * refused token, pairing again (the only thing that helps when every route
 * carries the same token). `environmentId` defaults to the one new sessions
 * go to, which with one saved is the only one.
 */
export function phoneConnectionView(
  state: PhoneConnectionReading,
  environmentId: string | null = state.selectedId,
): PhoneConnectionView {
  const reading = readingOf(state, environmentId)
  const ui = deriveConnectionUi(inputOf(reading))
  const next: PhoneNextStep[] = []
  switch (ui.kind) {
    case 'no_environment':
      next.push('pair')
      break
    case 'unauthorized':
      next.push('pair_again')
      break
    case 'incompatible_protocol':
    case 'unreachable':
    case 'reconnecting':
      next.push('retry')
      break
    case 'offline':
      // Retrying cannot help while the device has no network: the way back is
      // the network itself. The phone reconnects on its own once it returns.
      next.push('network_settings')
      break
    case 'connecting':
    case 'ready':
    case 'confirm_route':
      break
  }
  // The phone holds no token for the environment (refused for certain, or
  // unreadable): whatever the routes say, only pairing helps.
  const unpaired = ui.kind !== 'no_environment' && reading.environment?.paired === false
  if (unpaired) next.splice(0, next.length, 'pair_again')
  const { link } = reading
  const route =
    reading.status === 'connected' && link?.client && link.endpoint
      ? { endpoint: link.endpoint, kind: routeKindOf(link.endpoint) }
      : null
  return {
    ui,
    environmentId: reading.environment?.environmentId ?? null,
    tone: unpaired ? 'error' : TONES[ui.kind],
    next,
    route,
    retryAt: reading.status === 'waiting' ? (link?.retryAt ?? null) : null,
  }
}

/** "Trying again in 8 s", while the controller's next search is still ahead. */
export function retryCountdownWords(retryAt: number | null, now: number): string | null {
  if (retryAt === null) return null
  const seconds = Math.ceil((retryAt - now) / 1000)
  if (seconds <= 0) return 'Trying again…'
  return `Trying again in ${seconds} s`
}

export const NEXT_STEP_LABELS: Record<PhoneNextStep, string> = {
  retry: 'Try again now',
  pair_again: 'Pair again',
  pair: 'Pair with a computer',
  network_settings: 'Open network settings',
}
