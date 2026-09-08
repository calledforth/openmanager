export const ENVIRONMENT_STORAGE_KEY = 'openmanager-environment'

export type StoredEnvironment = {
  endpoint: string
  environmentId?: string
  label?: string
}

export function parseEnvironmentEndpoint(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  url.hash = ''
  url.search = ''
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1)
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname)
}

/** Join `/bootstrap` onto the stored endpoint, keeping any path prefix. */
export function environmentBootstrapUrl(endpoint: string): string {
  const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`
  return new URL('bootstrap', base).href
}

export function readStoredEnvironment(storage?: Pick<Storage, 'getItem'>): StoredEnvironment | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(ENVIRONMENT_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.endpoint !== 'string') return null
    const endpoint = parseEnvironmentEndpoint(record.endpoint)
    if (!endpoint) return null
    return {
      endpoint,
      environmentId: typeof record.environmentId === 'string' ? record.environmentId : undefined,
      label: typeof record.label === 'string' ? record.label : undefined,
    }
  } catch {
    return null
  }
}

export function writeStoredEnvironment(
  environment: StoredEnvironment,
  storage?: Pick<Storage, 'setItem'>,
) {
  try {
    ;(storage ?? window.localStorage).setItem(ENVIRONMENT_STORAGE_KEY, JSON.stringify(environment))
  } catch {
    /* ignore quota / private-mode failures */
  }
}

export function clearStoredEnvironment(storage?: Pick<Storage, 'removeItem'>) {
  try {
    ;(storage ?? window.localStorage).removeItem(ENVIRONMENT_STORAGE_KEY)
  } catch {
    /* ignore quota / private-mode failures */
  }
}
