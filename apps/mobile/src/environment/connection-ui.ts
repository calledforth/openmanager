import { PROTOCOL_VERSION } from '@openmanager/protocol'
import {
  deriveConnectionUi,
  type BootstrapOutcome,
  type ConnectionUiState,
  type DeriveConnectionInput,
  type EnvironmentSelection,
  type TransportStatus,
} from '@openmanager/environment-client/connection'

import type { PhoneConnectionState, PhoneEnvironment } from './controller'
import { phoneRouteOrder, routeKindOf, type RouteKind } from './route-order'

/**
 * What a person can do next about the connection, as the phone offers it.
 *
 * - `retry`: search the routes again now (`controller.retry()`).
 * - `pair_again`: the environment refused this phone's token; only a new
 *   pairing link helps (the pairing screen).
 * - `switch_environment`: choose another saved environment (Settings).
 * - `pair`: nothing is saved yet; pair with a computer.
 * - `network_settings`: the device has no network; the phone's own network
 *   settings, where airplane mode and Wi-Fi are. The phone reconnects on its
 *   own once the network is back.
 */
export type PhoneNextStep =
  'retry' | 'pair_again' | 'switch_environment' | 'pair' | 'network_settings'

/** How the state reads at a glance: the colour of its dot. */
export type PhoneConnectionTone = 'ok' | 'working' | 'warn' | 'error' | 'idle'

export type PhoneConnectionView = {
  /** The shared derivation's own answer: the same kind, title and words web shows. */
  ui: ConnectionUiState
  tone: PhoneConnectionTone
  /** The next steps, the first the main one. Empty when nothing is needed. */
  next: readonly PhoneNextStep[]
  /** The route the socket is up on, while it is up. */
  route: { endpoint: string; kind: RouteKind } | null
  /** When the controller asks again on its own, while it is waiting to. */
  retryAt: number | null
}

const NONE: EnvironmentSelection = { status: 'none' }

function selectedOf(state: PhoneConnectionState): PhoneEnvironment | null {
  return state.environments.find((item) => item.environmentId === state.selectedId) ?? null
}

/**
 * The route a sentence names: the one in use, else the first the phone would
 * ask (local network first). A saved environment always has one.
 */
function namedEndpoint(state: PhoneConnectionState, environment: PhoneEnvironment): string {
  if (state.endpoint && environment.routes.some((route) => route.endpoint === state.endpoint)) {
    return state.endpoint
  }
  return phoneRouteOrder(environment.routes)[0]?.endpoint ?? ''
}

/**
 * The socket as the shared derivation reads it, from the controller's status.
 *
 * The controller is the only thing that retries: its environment client is
 * made with `maxAttempts: 0`, so the client's own `retriesExhausted` is true
 * after every drop and says nothing about whether the phone will ask again.
 * It is never passed on; the controller's status says that instead.
 * `hasConnected` is whether the phone still holds a client the environment
 * accepted (it is kept through a drop, a hold and a change of route).
 */
function transportOf(state: PhoneConnectionState): TransportStatus {
  const hasConnected = state.client !== null
  const failure = state.connection?.failure ?? null
  switch (state.status) {
    case 'connected':
      return { phase: 'connected', hasConnected: true, failure: null }
    case 'waiting':
      // A socket that failed while opening, or soon after; or no route
      // answered (the route failure then says why).
      return {
        phase: 'closed',
        hasConnected,
        failure: state.routeFailure ? null : { code: 'unreachable', message: failure?.message },
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
function bootstrapOf(state: PhoneConnectionState, environment: PhoneEnvironment): BootstrapOutcome {
  if (state.status === 'connected' && state.bootstrap.status !== 'ready') {
    return {
      status: 'ready',
      environmentId: environment.environmentId,
      label: environment.label,
      protocolVersion: PROTOCOL_VERSION,
    }
  }
  return state.bootstrap
}

/**
 * The phone's connection, as the shared `deriveConnectionUi` input. Every
 * field is what the controller holds; nothing is guessed. The selected
 * environment's saved label names it, since the bootstrap's own label is
 * already copied there when it answers.
 */
export function phoneConnectionInput(state: PhoneConnectionState): DeriveConnectionInput {
  const environment = selectedOf(state)
  if (!environment || state.status === 'no_environment') {
    return { environment: NONE, bootstrap: { status: 'idle' }, transport: transportOf(state) }
  }
  return {
    environment: {
      status: 'selected',
      endpoint: namedEndpoint(state, environment),
      environmentId: environment.environmentId,
      label: environment.label,
    },
    bootstrap: bootstrapOf(state, environment),
    transport: transportOf(state),
    network: state.network,
    ...(state.routeFailure ? { routeFailure: state.routeFailure } : {}),
    autoRetry: true,
  }
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
 * Where the phone's connection stands, in the shared derivation's words, with
 * the phone's next steps. The shared actions map onto what the phone can do:
 * "retry" is the controller's retry; "switch environment" is Settings, or,
 * for a refused token, pairing again (the only thing that helps when every
 * route carries the same token).
 */
export function phoneConnectionView(state: PhoneConnectionState): PhoneConnectionView {
  const ui = deriveConnectionUi(phoneConnectionInput(state))
  const others = state.environments.length > 1
  const next: PhoneNextStep[] = []
  switch (ui.kind) {
    case 'no_environment':
      next.push('pair')
      break
    case 'unauthorized':
      next.push('pair_again')
      if (others) next.push('switch_environment')
      break
    case 'incompatible_protocol':
    case 'unreachable':
    case 'reconnecting':
      next.push('retry')
      if (others) next.push('switch_environment')
      break
    case 'offline':
      // Retrying cannot help while the device has no network, and another
      // environment is no nearer: the way back is the network itself. The
      // phone reconnects on its own once it returns.
      next.push('network_settings')
      break
    case 'connecting':
    case 'ready':
    case 'confirm_route':
      break
  }
  // The phone holds no token for the selected environment (refused for
  // certain, or unreadable): whatever the routes say, only pairing helps.
  const unpaired = ui.kind !== 'no_environment' && selectedOf(state)?.paired === false
  if (unpaired) {
    next.splice(0, next.length, 'pair_again', ...(others ? (['switch_environment'] as const) : []))
  }
  const route =
    state.status === 'connected' && state.client && state.endpoint
      ? { endpoint: state.endpoint, kind: routeKindOf(state.endpoint) }
      : null
  return {
    ui,
    tone: unpaired ? 'error' : TONES[ui.kind],
    next,
    route,
    retryAt: state.status === 'waiting' ? state.retryAt : null,
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
  switch_environment: 'Switch environment',
  pair: 'Pair with a computer',
  network_settings: 'Open network settings',
}
