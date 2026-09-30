export const ENVIRONMENT_STORAGE_KEY = 'openmanager-environments'
export const LEGACY_ENVIRONMENT_STORAGE_KEY = 'openmanager-environment'
export const DEFAULT_ENVIRONMENT_LABEL = 'Unnamed environment'

const REGISTRY_VERSION = 2
const MAX_CREDENTIAL_LENGTH = 1024
const MAX_HEALTH_MESSAGE_LENGTH = 300

/**
 * How a route reaches the environment. `local` and `remote` are what this
 * client can tell on its own; the field is an open string so a type the
 * environment reports later (`cloudflare`, `tailscale`, `lan`, `ssh`) is kept
 * as written, without another storage version.
 */
export type RouteType = string

export const ROUTE_HEALTH_STATUSES = [
  'unknown',
  'available',
  'unreachable',
  'unauthorized',
] as const
export type RouteHealthStatus = (typeof ROUTE_HEALTH_STATUSES)[number]

/** The last thing this client learned about a route, and when that changed. */
export type RouteHealth = {
  status: RouteHealthStatus
  /** ISO time the status last changed. Absent while the route is unchecked. */
  changedAt?: string
  message?: string
}

export type RouteHealthReport = { status: RouteHealthStatus; message?: string }

/**
 * One way to reach an environment. The endpoint is a replaceable network
 * detail: identity, the credential and every session belong to the
 * environment, never to a route.
 */
export type EnvironmentRoute = {
  type: RouteType
  endpoint: string
  /** Order of preference, `0` first. The route in use is the lowest one. */
  priority: number
  health: RouteHealth
}

export type StoredEnvironment = {
  environmentId: string
  label: string
  /** Never empty, sorted by priority. */
  routes: EnvironmentRoute[]
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

function endpointBase(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint : `${endpoint}/`
}

/** Join `/bootstrap` onto the stored endpoint, keeping any path prefix. */
export function environmentBootstrapUrl(endpoint: string): string {
  return new URL('bootstrap', endpointBase(endpoint)).href
}

/** Join `/local-owner` onto the stored endpoint, keeping any path prefix. */
export function environmentLocalOwnerUrl(endpoint: string): string {
  return new URL('local-owner', endpointBase(endpoint)).href
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** True when the stored HTTP endpoint names a loopback host. */
export function isLoopbackEnvironmentEndpoint(endpoint: string): boolean {
  const parsed = parseEnvironmentEndpoint(endpoint)
  if (!parsed) return false
  try {
    return LOOPBACK_HOSTS.has(new URL(parsed).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * RFC 6455 subprotocol token characters. The credential travels to the
 * environment inside a `Sec-WebSocket-Protocol` entry, and the browser throws
 * from the WebSocket constructor for anything outside this grammar (`=`, `,`,
 * quotes, spaces), so such values are rejected here instead of looping as
 * "unavailable" later.
 */
const SUBPROTOCOL_TOKEN_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/

export function parseEnvironmentCredential(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_CREDENTIAL_LENGTH) return ''
  if (!SUBPROTOCOL_TOKEN_PATTERN.test(trimmed)) return ''
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

const ROUTE_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const UNKNOWN_HEALTH: RouteHealth = { status: 'unknown' }

/** A loopback address is this machine; anything else is reached over a network. */
export function routeTypeForEndpoint(endpoint: string): RouteType {
  return isLoopbackEnvironmentEndpoint(endpoint) ? 'local' : 'remote'
}

const ROUTE_TYPE_LABELS: Record<string, string> = {
  local: 'Local',
  remote: 'Remote',
  cloudflare: 'Cloudflare',
  tailscale: 'Tailscale',
  lan: 'LAN',
  ssh: 'SSH',
}

export function routeTypeLabel(type: RouteType): string {
  return ROUTE_TYPE_LABELS[type] ?? type
}

function parseRouteType(raw: unknown, endpoint: string): RouteType {
  return typeof raw === 'string' && ROUTE_TYPE_PATTERN.test(raw)
    ? raw
    : routeTypeForEndpoint(endpoint)
}

function parseHealthMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return raw.trim().slice(0, MAX_HEALTH_MESSAGE_LENGTH) || undefined
}

function parseRouteHealth(raw: unknown): RouteHealth {
  if (!raw || typeof raw !== 'object') return UNKNOWN_HEALTH
  const record = raw as Record<string, unknown>
  const status = ROUTE_HEALTH_STATUSES.find((item) => item === record.status)
  if (!status || status === 'unknown') return UNKNOWN_HEALTH
  const health: RouteHealth = { status }
  if (typeof record.changedAt === 'string' && !Number.isNaN(Date.parse(record.changedAt))) {
    health.changedAt = record.changedAt
  }
  const message = parseHealthMessage(record.message)
  if (message) health.message = message
  return health
}

/** One route per endpoint, in priority order, renumbered from zero. */
function orderRoutes(routes: readonly EnvironmentRoute[]): EnvironmentRoute[] {
  const unique: EnvironmentRoute[] = []
  for (const route of routes) {
    if (!unique.some((item) => item.endpoint === route.endpoint)) unique.push(route)
  }
  return unique
    .map((route, index) => ({ route, index }))
    .sort((left, right) => left.route.priority - right.route.priority || left.index - right.index)
    .map(({ route }, priority) => (route.priority === priority ? route : { ...route, priority }))
}

function parseRoutes(raw: unknown): EnvironmentRoute[] {
  if (!Array.isArray(raw)) return []
  const routes: EnvironmentRoute[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const endpoint =
      typeof record.endpoint === 'string' ? parseEnvironmentEndpoint(record.endpoint) : null
    if (!endpoint) continue
    routes.push({
      type: parseRouteType(record.type, endpoint),
      endpoint,
      priority:
        typeof record.priority === 'number' && Number.isFinite(record.priority)
          ? record.priority
          : Number.MAX_SAFE_INTEGER,
      health: parseRouteHealth(record.health),
    })
  }
  return orderRoutes(routes)
}

/** Version 1 kept a bare endpoint list, most recently used first. */
function routesFromEndpoints(raw: unknown): EnvironmentRoute[] {
  if (!Array.isArray(raw)) return []
  return parseRoutes(
    raw
      .filter((item): item is string => typeof item === 'string')
      .map((endpoint, priority) => ({ endpoint, priority })),
  )
}

export function parseStoredEnvironment(input: unknown): StoredEnvironment | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const environmentId = parseEnvironmentId(record.environmentId)
  const routes =
    record.routes !== undefined ? parseRoutes(record.routes) : routesFromEndpoints(record.endpoints)
  if (!environmentId || routes.length === 0) return null
  const credential =
    typeof record.credential === 'string' ? parseEnvironmentCredential(record.credential) : ''
  return {
    environmentId,
    label: parseLabel(record.label),
    routes,
    credential,
  }
}

/** The route this client uses for the environment: the lowest priority. */
export function preferredRoute(environment: StoredEnvironment): EnvironmentRoute {
  return environment.routes[0]!
}

function applyHealth(current: RouteHealth, report: RouteHealthReport, now: Date): RouteHealth {
  const message = report.status === 'unknown' ? undefined : parseHealthMessage(report.message)
  if (current.status === report.status && current.message === message) return current
  if (report.status === 'unknown') return UNKNOWN_HEALTH
  return { status: report.status, changedAt: now.toISOString(), ...(message ? { message } : {}) }
}

/** Put `endpoint` first, adding it when the environment has not seen it yet. */
function preferRoute(
  routes: readonly EnvironmentRoute[],
  endpoint: string,
  report?: RouteHealthReport,
  now: Date = new Date(),
): EnvironmentRoute[] {
  const known = routes.find((item) => item.endpoint === endpoint)
  const base: EnvironmentRoute = known ?? {
    type: routeTypeForEndpoint(endpoint),
    endpoint,
    priority: 0,
    health: UNKNOWN_HEALTH,
  }
  const health = report ? applyHealth(base.health, report, now) : base.health
  return orderRoutes([
    { ...base, health, priority: -1 },
    ...routes.filter((item) => item.endpoint !== endpoint),
  ])
}

function replaceEnvironment(
  registry: EnvironmentRegistry,
  record: StoredEnvironment,
): StoredEnvironment[] {
  return registry.environments.map((item) =>
    item.environmentId === record.environmentId ? record : item,
  )
}

/**
 * Add or update an environment by its ID and make `endpoint` the route in
 * use. A URL the environment has not seen becomes another route to the same
 * record; it never creates a second environment.
 */
export function upsertStoredEnvironment(
  registry: EnvironmentRegistry,
  input: {
    environmentId: string
    endpoint: string
    label?: string
    credential?: string
    /** What reaching the endpoint just showed. Omitted leaves its health alone. */
    health?: RouteHealthReport
  },
  now: Date = new Date(),
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
        routes: preferRoute(existing.routes, endpoint, input.health, now),
        credential: credential || existing.credential,
      }
    : {
        environmentId,
        label: parseLabel(input.label),
        routes: preferRoute([], endpoint, input.health, now),
        credential,
      }

  const environments = existing
    ? replaceEnvironment(registry, record)
    : [...registry.environments, record]

  return { selectedId: environmentId, environments }
}

/**
 * Make `endpoint` the route in use for its environment and select that
 * environment. Returns the same registry when that is already the case, or
 * when the environment has no such route.
 */
export function preferStoredRoute(
  registry: EnvironmentRegistry,
  environmentId: string,
  endpoint: string,
): EnvironmentRegistry {
  const existing = findStoredEnvironment(registry.environments, environmentId)
  if (!existing || !existing.routes.some((item) => item.endpoint === endpoint)) return registry
  if (registry.selectedId === environmentId && preferredRoute(existing).endpoint === endpoint) {
    return registry
  }
  const record = { ...existing, routes: preferRoute(existing.routes, endpoint) }
  return { selectedId: environmentId, environments: replaceEnvironment(registry, record) }
}

/**
 * Forget one route. The last route stays: an environment with no way to reach
 * it is removed as a whole instead.
 */
export function removeStoredRoute(
  registry: EnvironmentRegistry,
  environmentId: string,
  endpoint: string,
): EnvironmentRegistry {
  const existing = findStoredEnvironment(registry.environments, environmentId)
  if (!existing || existing.routes.length < 2) return registry
  if (!existing.routes.some((item) => item.endpoint === endpoint)) return registry
  const record = {
    ...existing,
    routes: orderRoutes(existing.routes.filter((item) => item.endpoint !== endpoint)),
  }
  return { ...registry, environments: replaceEnvironment(registry, record) }
}

/**
 * Record what reaching a route showed. Returns the same registry when nothing
 * changed, so a repeated report is not a write.
 */
export function setStoredRouteHealth(
  registry: EnvironmentRegistry,
  environmentId: string,
  endpoint: string,
  report: RouteHealthReport,
  now: Date = new Date(),
): EnvironmentRegistry {
  const existing = findStoredEnvironment(registry.environments, environmentId)
  const route = existing?.routes.find((item) => item.endpoint === endpoint)
  if (!existing || !route) return registry
  const health = applyHealth(route.health, report, now)
  if (health === route.health) return registry
  const record = {
    ...existing,
    routes: existing.routes.map((item) => (item === route ? { ...item, health } : item)),
  }
  return { ...registry, environments: replaceEnvironment(registry, record) }
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
 * The stored record for a live selection, by environment ID only. An endpoint
 * is not an identity: a reused localhost port or a moved tunnel can point at a
 * different server with a different token, so there is no endpoint fallback.
 */
export function findStoredEnvironment(
  environments: readonly StoredEnvironment[],
  environmentId: string | null | undefined,
): StoredEnvironment | undefined {
  if (!environmentId) return undefined
  return environments.find((item) => item.environmentId === environmentId)
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
  // Version 1 differs only in each record's route list, which
  // `parseStoredEnvironment` reads in either shape.
  const known = document.version === REGISTRY_VERSION || document.version === 1
  if (!known || !Array.isArray(document.environments)) return null
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
        routes: preferRoute([], endpoint),
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
    if (raw) {
      const document: unknown = JSON.parse(raw)
      const registry = parseRegistryDocument(document)
      if (!registry) return EMPTY_REGISTRY
      if ((document as { version?: unknown }).version !== REGISTRY_VERSION) {
        try {
          store.setItem?.(ENVIRONMENT_STORAGE_KEY, serializeRegistry(registry))
        } catch {
          /* keep the in-memory upgrade even if persist fails */
        }
      }
      return registry
    }

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
