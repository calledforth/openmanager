import type { EnvironmentClientBackend, EnvironmentClientConfig } from '../shared/runtime-config'

export const DEFAULT_ENVIRONMENT_SERVER_URL = 'http://127.0.0.1:43120'

const BACKENDS: ReadonlySet<string> = new Set<EnvironmentClientBackend>(['convex', 'websocket'])

/**
 * Which environment client the renderer should mount, from the main process's
 * environment. The renderer may still override the backend from local storage
 * (see `renderer/src/environment/select-backend.ts`) so the flag can be flipped
 * from devtools without restarting with a different environment.
 *
 * - `OPENMANAGER_ENVIRONMENT_CLIENT`: `convex` (default) or `websocket`
 * - `OPENMANAGER_ENVIRONMENT_URL`: HTTP origin of the environment server
 * - `OPENMANAGER_CLIENT_TOKEN`: the server's development client token
 */
export function resolveEnvironmentClientConfig(
  env: Record<string, string | undefined>,
): EnvironmentClientConfig {
  const requested = env.OPENMANAGER_ENVIRONMENT_CLIENT?.trim().toLowerCase() ?? ''
  const backend: EnvironmentClientBackend = BACKENDS.has(requested)
    ? (requested as EnvironmentClientBackend)
    : 'convex'
  const serverUrl = env.OPENMANAGER_ENVIRONMENT_URL?.trim() || DEFAULT_ENVIRONMENT_SERVER_URL
  const credential = env.OPENMANAGER_CLIENT_TOKEN?.trim() ?? ''
  return { backend, serverUrl, credential }
}
