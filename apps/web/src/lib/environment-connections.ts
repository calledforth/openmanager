import type { RouteFailure, RouteSearch } from './connection-state'

/** What the live socket on a route last said about itself. */
export type SocketReport = { endpoint: string; connected: boolean }

/**
 * What this page knows about reaching one environment, on top of its saved
 * record. Nothing here is persisted: a reload starts every environment idle.
 */
export type EnvironmentConnection = {
  /** The environment has answered since this connection last started over. */
  hasConnected: boolean
  /** Why no saved route reaches the environment. */
  routeFailure: RouteFailure | null
  /** The route in use failed and the other saved routes are being tried. */
  routeSearch: RouteSearch | null
  /**
   * Whether the socket is connected, and on which route. While it is, the
   * socket is what says the environment is there: a bootstrap asked again
   * meanwhile can only be older news.
   */
  socket: SocketReport | null
}

/** Each environment's connection, by environment ID. Idle ones are left out. */
export type EnvironmentConnections = Readonly<Record<string, EnvironmentConnection>>

export const NO_CONNECTIONS: EnvironmentConnections = Object.freeze({})

const IDLE_CONNECTION: EnvironmentConnection = Object.freeze({
  hasConnected: false,
  routeFailure: null,
  routeSearch: null,
  socket: null,
})

export function connectionOf(
  connections: EnvironmentConnections,
  environmentId: string | null | undefined,
): EnvironmentConnection {
  // Own keys only: an environment ID comes from an unauthenticated answer.
  return environmentId && Object.hasOwn(connections, environmentId)
    ? connections[environmentId]!
    : IDLE_CONNECTION
}

function sameConnection(left: EnvironmentConnection, right: EnvironmentConnection): boolean {
  return (
    left.hasConnected === right.hasConnected &&
    // By identity: a failure found again is news, and restarts its retry delay.
    left.routeFailure === right.routeFailure &&
    left.routeSearch === right.routeSearch &&
    left.socket?.endpoint === right.socket?.endpoint &&
    left.socket?.connected === right.socket?.connected
  )
}

export function dropConnection(
  connections: EnvironmentConnections,
  environmentId: string,
): EnvironmentConnections {
  if (!Object.hasOwn(connections, environmentId)) return connections
  return Object.fromEntries(Object.entries(connections).filter(([id]) => id !== environmentId))
}

/** Returns the same value when nothing changed. */
export function patchConnection(
  connections: EnvironmentConnections,
  environmentId: string,
  change: Partial<EnvironmentConnection>,
): EnvironmentConnections {
  const current = connectionOf(connections, environmentId)
  const next = { ...current, ...change }
  if (sameConnection(current, next)) return connections
  return sameConnection(next, IDLE_CONNECTION)
    ? dropConnection(connections, environmentId)
    : { ...connections, [environmentId]: next }
}

/**
 * The environment refused its token. Every route carries the same one, so
 * nothing may send it again on its own; only a person, or the socket getting
 * through, lifts this.
 */
export function tokenIsRefused(connection: EnvironmentConnection): boolean {
  return connection.routeFailure?.reason === 'credential_rejected'
}
