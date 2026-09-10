export const ENVIRONMENT_STORAGE_KEY = 'openmanager-environments'
export const LEGACY_ENVIRONMENT_STORAGE_KEY = 'openmanager-environment'
export const DEFAULT_ENVIRONMENT_LABEL = 'Unnamed environment'

const REGISTRY_VERSION = 1
const MAX_CREDENTIAL_LENGTH = 1024

export type StoredEnvironment = {
  environmentId: string
  label: string
  endpoints: string[]
  credential: string
}

export type EnvironmentRegistry = {
  selectedId: string | null
  environments: StoredEnvironment[]
}

export const EMPTY_REGISTRY: EnvironmentRegistry = { selectedId: null, environments: [] }

type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>
type StorageRemover = Pick<Storage, 'removeItem'>

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

export function parseEnvironmentCredential(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_CREDENTIAL_LENGTH) return ''
  if (/\s/.test(trimmed)) return ''
  return trimmed
}

function parseEnvironmentId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const environmentId = raw.trim()
  if (!environmentId || environmentId.length > 256 || /\s/.test(environmentId)) return null
  return environmentId
}

function parseLabel(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_ENVIRONMENT_LABEL
  const label = raw.trim().slice(0, 128)
  return label || DEFAULT_ENVIRONMENT_LABEL
}

function parseEndpoints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const endpoints: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const endpoint = parseEnvironmentEndpoint(item)
    if (endpoint && !endpoints.includes(endpoint)) endpoints.push(endpoint)
  }
  return endpoints
}

export function parseStoredEnvironment(input: unknown): StoredEnvironment | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const environmentId = parseEnvironmentId(record.environmentId)
  const endpoints = parseEndpoints(record.endpoints)
  if (!environmentId || endpoints.length === 0) return null
  const credential =
    typeof record.credential === 'string' ? parseEnvironmentCredential(record.credential) : ''
  return {
    environmentId,
    label: parseLabel(record.label),
    endpoints,
    credential,
  }
}

function rememberEndpoint(endpoints: readonly string[], endpoint: string): string[] {
  return [endpoint, ...endpoints.filter((item) => item !== endpoint)]
}

export function upsertStoredEnvironment(
  registry: EnvironmentRegistry,
  input: {
    environmentId: string
    endpoint: string
    label?: string
    credential?: string
  },
): EnvironmentRegistry | null {
  const environmentId = parseEnvironmentId(input.environmentId)
  const endpoint = parseEnvironmentEndpoint(input.endpoint)
  if (!environmentId || !endpoint) return null

  const credential = parseEnvironmentCredential(input.credential ?? '')
  const existing = registry.environments.find((item) => item.environmentId === environmentId)
  const record: StoredEnvironment = existing
    ? {
        environmentId,
        label: input.label !== undefined ? parseLabel(input.label) : existing.label,
        endpoints: rememberEndpoint(existing.endpoints, endpoint),
        credential: credential || existing.credential,
      }
    : {
        environmentId,
        label: parseLabel(input.label),
        endpoints: [endpoint],
        credential,
      }

  const environments = existing
    ? registry.environments.map((item) => (item.environmentId === environmentId ? record : item))
    : [...registry.environments, record]

  return { selectedId: environmentId, environments }
}

export function removeStoredEnvironment(
  registry: EnvironmentRegistry,
  environmentId: string,
): EnvironmentRegistry {
  const environments = registry.environments.filter((item) => item.environmentId !== environmentId)
  return {
    selectedId: registry.selectedId === environmentId ? null : registry.selectedId,
    environments,
  }
}

export function selectStoredEnvironment(
  registry: EnvironmentRegistry,
  environmentId: string,
): EnvironmentRegistry {
  if (!registry.environments.some((item) => item.environmentId === environmentId)) return registry
  return { ...registry, selectedId: environmentId }
}

export function selectedStoredEnvironment(
  registry: EnvironmentRegistry,
): StoredEnvironment | null {
  if (!registry.selectedId) return null
  return registry.environments.find((item) => item.environmentId === registry.selectedId) ?? null
}

/**
 * The stored record for a live selection. An endpoint can be remembered under
 * several environments (a reused localhost port, a tunnel that moved), so the
 * environment ID wins whenever the selection has one; the endpoint match is
 * only the fallback for a pending connect whose bootstrap has not answered.
 */
export function findStoredEnvironment(
  environments: readonly StoredEnvironment[],
  endpoint: string,
  environmentId?: string | null,
): StoredEnvironment | undefined {
  if (environmentId) {
    const byId = environments.find((item) => item.environmentId === environmentId)
    if (byId) return byId
  }
  return environments.find((item) => item.endpoints.includes(endpoint))
}

export function environmentRegistriesEqual(
  left: EnvironmentRegistry,
  right: EnvironmentRegistry,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function parseRegistryDocument(parsed: unknown): EnvironmentRegistry | null {
  if (!parsed || typeof parsed !== 'object') return null
  const document = parsed as Record<string, unknown>
  if (document.version !== REGISTRY_VERSION || !Array.isArray(document.environments)) return null
  const environments: StoredEnvironment[] = []
  for (const item of document.environments) {
    const record = parseStoredEnvironment(item)
    if (!record) continue
    if (environments.some((existing) => existing.environmentId === record.environmentId)) continue
    environments.push(record)
  }
  const selectedId =
    typeof document.selectedId === 'string' &&
    environments.some((item) => item.environmentId === document.selectedId)
      ? document.selectedId
      : null
  return { selectedId, environments }
}

function migrateLegacyRecord(parsed: unknown): EnvironmentRegistry | null {
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (typeof record.endpoint !== 'string') return null
  const endpoint = parseEnvironmentEndpoint(record.endpoint)
  const environmentId = parseEnvironmentId(record.environmentId)
  if (!endpoint || !environmentId) return null
  return {
    selectedId: environmentId,
    environments: [
      {
        environmentId,
        label: parseLabel(record.label),
        endpoints: [endpoint],
        credential: '',
      },
    ],
  }
}

function serializeRegistry(registry: EnvironmentRegistry): string {
  return JSON.stringify({
    version: REGISTRY_VERSION,
    selectedId: registry.selectedId,
    environments: registry.environments,
  })
}

export function readEnvironmentRegistry(
  storage?: StorageReader & Partial<StorageWriter> & Partial<StorageRemover>,
): EnvironmentRegistry {
  try {
    const store = storage ?? window.localStorage
    const raw = store.getItem(ENVIRONMENT_STORAGE_KEY)
    if (raw) return parseRegistryDocument(JSON.parse(raw)) ?? EMPTY_REGISTRY

    const legacy = store.getItem(LEGACY_ENVIRONMENT_STORAGE_KEY)
    if (!legacy) return EMPTY_REGISTRY
    const migrated = migrateLegacyRecord(JSON.parse(legacy))
    if (!migrated) return EMPTY_REGISTRY
    try {
      store.setItem?.(ENVIRONMENT_STORAGE_KEY, serializeRegistry(migrated))
      store.removeItem?.(LEGACY_ENVIRONMENT_STORAGE_KEY)
    } catch {
      /* keep the in-memory migration even if persist fails */
    }
    return migrated
  } catch {
    return EMPTY_REGISTRY
  }
}

export function writeEnvironmentRegistry(
  registry: EnvironmentRegistry,
  storage?: StorageWriter & Partial<StorageRemover>,
) {
  try {
    const store = storage ?? window.localStorage
    store.setItem(ENVIRONMENT_STORAGE_KEY, serializeRegistry(registry))
    store.removeItem?.(LEGACY_ENVIRONMENT_STORAGE_KEY)
  } catch {
    /* ignore quota / private-mode failures */
  }
}

export function clearEnvironmentRegistry(storage?: StorageRemover) {
  try {
    const store = storage ?? window.localStorage
    store.removeItem(ENVIRONMENT_STORAGE_KEY)
    store.removeItem(LEGACY_ENVIRONMENT_STORAGE_KEY)
  } catch {
    /* ignore quota / private-mode failures */
  }
}
