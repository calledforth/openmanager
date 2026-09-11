import type {
  EnvironmentClientBackend,
  EnvironmentClientConfig,
} from '../../../shared/runtime-config'

/**
 * Local-storage override for the environment client backend, so the flag can
 * be flipped from devtools (`localStorage.setItem(KEY, 'websocket')` and
 * reload) without relaunching Electron with a different environment.
 */
export const ENVIRONMENT_CLIENT_STORAGE_KEY = 'openmanager.environment-client'

const isBackend = (value: unknown): value is EnvironmentClientBackend =>
  value === 'convex' || value === 'websocket'

export function resolveEnvironmentClientSelection(
  config: EnvironmentClientConfig,
  storedOverride: string | null | undefined,
): EnvironmentClientConfig {
  const override = storedOverride?.trim().toLowerCase()
  return isBackend(override) ? { ...config, backend: override } : config
}

export function readStoredBackendOverride(
  storage: Pick<Storage, 'getItem'> | undefined,
): string | null {
  try {
    return storage?.getItem(ENVIRONMENT_CLIENT_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

/**
 * Derive the environment's WebSocket URL from its HTTP origin. Mirrors
 * `apps/web/src/lib/environment-socket.ts`; the bootstrap payload's own URL is
 * the loopback address the server bound to, which is only right on this host.
 */
export function environmentSocketUrl(endpoint: string): string {
  const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`
  const url = new URL('ws', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
