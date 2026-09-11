export type ConvexConfigSource = 'settings' | 'environment' | 'unset'

/**
 * Which `EnvironmentClient` implementation the renderer mounts.
 *
 * `convex` is the temporary compatibility adapter over the existing Convex
 * deployment and Electron IPC; `websocket` is the real client against the
 * environment server. The adapter and this flag go away with Convex
 * retirement (docs/compatibility-adapters.md).
 */
export type EnvironmentClientBackend = 'convex' | 'websocket'

export interface EnvironmentClientConfig {
  backend: EnvironmentClientBackend
  /** HTTP origin of the environment server; the WebSocket URL derives from it. */
  serverUrl: string
  /** Client token for the environment server, or empty when none is set. */
  credential: string
}

export interface ConvexRuntimeConfig {
  convexUrl: string
  convexSource: ConvexConfigSource
  environmentUrlAvailable: boolean
}

export interface RuntimeConfig extends ConvexRuntimeConfig {
  environmentClient: EnvironmentClientConfig
}

export interface ConvexConnectionResult {
  ok: boolean
  normalizedUrl?: string
  error?: string
}
