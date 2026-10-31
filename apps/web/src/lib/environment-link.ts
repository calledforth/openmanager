import { PROTOCOL_VERSION } from './bootstrap'
import {
  deriveConnectionUi,
  type BootstrapOutcome,
  type ConnectionUiState,
  type TransportStatus,
} from './connection-state'
import type { EnvironmentConnection } from './environment-connections'
import type { StoredEnvironment } from './environment-store'
import { WRONG_ENVIRONMENT_MESSAGE } from './route-health'

/** What a saved environment's connection comes to, on the route it is using. */
export type EnvironmentLink = {
  environmentId: string
  endpoint: string
  credential: string
  /** What the route last answered, which may be from before a new question. */
  answer: BootstrapOutcome
  /**
   * The route's answer to the latest question is that it is this environment.
   * A socket may only be dialled while that holds: otherwise nothing says the
   * address still leads to the environment whose token it would carry.
   */
  routeVerified: boolean
  /**
   * The route answered as a different environment. No socket may be opened on
   * it, whatever else the state says: the socket would carry this environment's
   * token to whatever answered.
   */
  wrongEnvironment: boolean
  /**
   * The environment refused this token, and nothing has got through with it
   * since. Saved, so it holds across a reload: until a socket gets through,
   * what this browser kept of the environment stays hidden.
   */
  tokenRefused: boolean
  ui: ConnectionUiState
  /**
   * Goes up each time the route is asked again. The socket dials immediately
   * then, instead of waiting out its backoff.
   */
  attempt: number
}

/** The address answered, and it is not this environment. */
export function answeredAsAnother(answer: BootstrapOutcome, environmentId: string): boolean {
  return (
    (answer.status === 'ready' || answer.status === 'incompatible_protocol') &&
    answer.environmentId !== undefined &&
    answer.environmentId !== environmentId
  )
}

export function transportFromBootstrap(
  bootstrap: BootstrapOutcome,
  hasConnected: boolean,
): TransportStatus {
  if (bootstrap.status === 'ready') {
    return { phase: 'connected', hasConnected: true, failure: null }
  }
  if (bootstrap.status === 'loading' || bootstrap.status === 'idle') {
    return {
      phase: hasConnected ? 'reconnecting' : 'connecting',
      hasConnected,
      failure: null,
    }
  }
  if (bootstrap.status === 'unauthorized') {
    return { phase: 'closed', hasConnected, failure: { code: 'auth', message: bootstrap.message } }
  }
  if (bootstrap.status === 'incompatible_protocol') {
    return { phase: 'closed', hasConnected, failure: { code: 'protocol_incompatible' } }
  }
  return {
    phase: 'closed',
    hasConnected,
    failure: { code: 'unreachable', message: bootstrap.message },
  }
}

export function deriveEnvironmentLink({
  record,
  endpoint,
  answer,
  fresh,
  connection,
  online,
  attempt,
}: {
  record: StoredEnvironment
  endpoint: string
  answer: BootstrapOutcome
  /** The answer is to the latest question, not the one before it. */
  fresh: boolean
  connection: EnvironmentConnection
  online: boolean
  attempt: number
}): EnvironmentLink {
  const { environmentId, label, credential } = record
  const answered = answer.status === 'ready' || answer.status === 'incompatible_protocol'
  const wrongEnvironment = answeredAsAnother(answer, environmentId)
  const routeVerified =
    fresh && answer.status === 'ready' && answer.environmentId === environmentId
  const socketConnected =
    connection.socket?.connected === true && connection.socket.endpoint === endpoint
  // A connected socket is proof the route reaches this environment in this
  // protocol: its handshake said so. Bootstrap failing, or not having answered
  // yet, does not outweigh that. What does is an answer from another
  // environment, or a protocol change: those still take over.
  const bootstrap: BootstrapOutcome = wrongEnvironment
    ? {
        status: 'unreachable',
        message: `${WRONG_ENVIRONMENT_MESSAGE} Use another route to this environment, or connect to the address again to add what answers there.`,
      }
    : socketConnected && !answered
      ? { status: 'ready', environmentId, label, protocolVersion: PROTOCOL_VERSION }
      : answer
  const ui = deriveConnectionUi({
    environment: { status: 'selected', endpoint, environmentId, label },
    bootstrap,
    transport: transportFromBootstrap(
      bootstrap,
      connection.hasConnected || bootstrap.status === 'ready',
    ),
    network: { online },
    routeFailure: connection.routeFailure ?? undefined,
    routeSearch: socketConnected ? undefined : (connection.routeSearch ?? undefined),
  })
  return {
    environmentId,
    endpoint,
    credential,
    answer,
    routeVerified,
    wrongEnvironment,
    tokenRefused: record.tokenRefused === true,
    ui,
    attempt,
  }
}
