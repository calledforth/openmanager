import { isDeepStrictEqual } from 'node:util'
import {
  PROVIDER_LIMITS_REFRESH_CAPABILITY,
  ProviderLimitsChangedEventSchema,
  ProviderLimitsReadingSchema,
  ProviderLimitsRefreshCommandSchema,
  ProviderLimitsRefreshResponseSchema,
  ProviderLimitsSchema,
  type CommandEnvelope,
  type ErrorCode,
  type ProviderLimits,
  type ProviderLimitsReading,
  type ProviderLimitWindow,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from './db/database.ts'

/** The runtime's `UsageLimitsResult` and `UsageLimitObservation`
 * (`@agentpack/contract`), restated: the server reaches the contract only
 * through the runtime's event types, and these are checked against them where
 * the two meet in `server.ts`. */
export type UsageLimitsResult =
  | {
      outcome: 'ok'
      reading: Pick<ProviderLimitsReading, 'windows' | 'extraUsage'>
    }
  | { outcome: 'unavailable' }
  | { outcome: 'unsupported' }

export type UsageLimitObservation = {
  windowId: string
  label: string
  group: ProviderLimitWindow['group']
  status?: 'ok' | 'warning' | 'limited'
  resetsAt?: string
  usedPercentAtLeast?: number
}

/** No reading younger than this is read again, whatever a client asks: one
 * read is a CLI held for up to a minute. */
export const MIN_REFRESH_INTERVAL_MS = 60_000
/** What a refresh that names no age accepts. */
export const DEFAULT_REFRESH_MAX_AGE_MS = 5 * 60_000
/** A window whose reset moves by more than this has rolled over: its old
 * percent belongs to the previous window. */
const ROLLOVER_TOLERANCE_MS = 60_000

type LastRefresh = NonNullable<ProviderLimits['lastRefresh']>

export type ProviderLimitsStore = {
  load(): Map<string, { reading: ProviderLimitsReading | null; lastRefresh: LastRefresh | null }>
  save(
    providerId: string,
    reading: ProviderLimitsReading | null,
    lastRefresh: LastRefresh | null,
  ): void
  close(): void
}

export type ProviderLimitsDeps = {
  /** Every provider the environment lists, in order. */
  providerIds: readonly string[]
  /** Whether this provider has a way to report limits at all. */
  supports: (providerId: string) => boolean
  /** One read in a throwaway process. */
  read: (providerId: string) => Promise<UsageLimitsResult>
  store: ProviderLimitsStore
  clock?: () => number
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

const errorResult = (requestId: string, code: ErrorCode, message: string) => ({
  type: 'error' as const,
  requestId,
  error: { code, message },
})

/**
 * Server-owned usage limits per provider (CAL-242).
 *
 * The environment is the one source: a full read on request, nudged in
 * between by what live sessions say, kept across restarts with its age.
 * Clients only ask for a refresh; the server decides whether one runs. Reads
 * are deduplicated per provider and held to `MIN_REFRESH_INTERVAL_MS`, so any
 * number of clients asking costs at most one CLI a minute.
 */
export function createProviderLimits(deps: ProviderLimitsDeps) {
  const clock = deps.clock ?? Date.now
  const log = deps.log ?? (() => undefined)
  const listeners = new Set<(event: ReturnType<typeof limitsEvent>) => void>()
  const state = new Map<string, ProviderLimits>()
  const inFlight = new Map<string, Promise<void>>()
  let stopped = false

  const persisted = deps.store.load()
  for (const providerId of deps.providerIds) {
    const supported = deps.supports(providerId)
    const saved = supported ? persisted.get(providerId) : undefined
    state.set(providerId, {
      supported,
      reading: saved?.reading ?? null,
      refreshing: false,
      lastRefresh: saved?.lastRefresh ?? null,
    })
  }

  const unsupported: ProviderLimits = Object.freeze({
    supported: false,
    reading: null,
    refreshing: false,
    lastRefresh: null,
  })

  const get = (providerId: string): ProviderLimits => state.get(providerId) ?? unsupported

  const set = (providerId: string, next: ProviderLimits, persist: boolean) => {
    const previous = state.get(providerId)
    if (!previous || isDeepStrictEqual(previous, next)) return
    state.set(providerId, ProviderLimitsSchema.parse(next))
    if (persist) {
      try {
        deps.store.save(providerId, next.reading, next.lastRefresh)
      } catch (error) {
        // The live state is still right; only a restart would lose it.
        log('warn', 'could not save provider limits', { providerId, reason: String(error) })
      }
    }
    if (stopped) return
    const event = limitsEvent(providerId, next)
    for (const listener of listeners) listener(event)
  }

  const ageMs = (iso: string | undefined) => (iso ? clock() - Date.parse(iso) : Infinity)

  /** Start a read unless one is running or the last one is fresh enough. */
  const refresh = (providerId: string, maxAgeMs = DEFAULT_REFRESH_MAX_AGE_MS): ProviderLimits => {
    const current = get(providerId)
    if (!current.supported || stopped) return current
    if (inFlight.has(providerId)) return current
    const floor = Math.max(maxAgeMs, MIN_REFRESH_INTERVAL_MS)
    // Measured from the last full read, not the reading's `at`: a live session
    // nudging one window does not make the others fresh.
    if (current.lastRefresh?.outcome === 'ok' && ageMs(current.lastRefresh.at) < floor)
      return current
    // An attempt of any outcome counts toward the floor, so a failing read
    // cannot be retried in a loop by a client that keeps asking.
    if (ageMs(current.lastRefresh?.at) < MIN_REFRESH_INTERVAL_MS) return current

    set(providerId, { ...current, refreshing: true }, false)
    const run = (async () => {
      let result: UsageLimitsResult | undefined
      try {
        result = await deps.read(providerId)
      } catch (error) {
        log('warn', 'provider limits read failed', { providerId, reason: String(error) })
      }
      const at = new Date(clock()).toISOString()
      const before = get(providerId)
      if (result?.outcome === 'unsupported') {
        set(providerId, { ...before, supported: false, refreshing: false }, false)
        return
      }
      const lastRefresh: LastRefresh = {
        outcome: result?.outcome === 'ok' ? 'ok' : result ? 'unavailable' : 'failed',
        at,
      }
      const reading =
        result?.outcome === 'ok'
          ? sanitize({ windows: result.reading.windows, extraUsage: result.reading.extraUsage, at })
          : // A failed read keeps the last numbers up, with their age; an account
            // without plan limits has nothing to keep.
            result?.outcome === 'unavailable'
            ? null
            : before.reading
      set(providerId, { ...before, reading, refreshing: false, lastRefresh }, true)
    })().finally(() => inFlight.delete(providerId))
    inFlight.set(providerId, run)
    return get(providerId)
  }

  return {
    get,

    onChanged(listener: (event: ReturnType<typeof limitsEvent>) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    refresh,

    /** Settles once every read in progress has (tests, shutdown). */
    async idle(): Promise<void> {
      await Promise.all([...inFlight.values()])
    },

    /** Fold a live session's `usage_limits_update` into the reading. */
    observe(providerId: string, observation: UsageLimitObservation): void {
      const current = state.get(providerId)
      if (!current?.supported) return
      const windows = [...(current.reading?.windows ?? [])]
      const index = windows.findIndex((window) => window.id === observation.windowId)
      const merged = mergeObservation(index >= 0 ? windows[index] : undefined, observation)
      if (index >= 0) {
        if (isDeepStrictEqual(windows[index], merged)) return
        windows[index] = merged
      } else {
        windows.push(merged)
      }
      const reading = sanitize({
        windows,
        extraUsage: current.reading?.extraUsage ?? null,
        at: new Date(clock()).toISOString(),
      })
      set(providerId, { ...current, reading }, true)
    },

    dispatch(command: CommandEnvelope): Promise<unknown> | undefined {
      if (command.name !== PROVIDER_LIMITS_REFRESH_CAPABILITY) return undefined
      const parsed = ProviderLimitsRefreshCommandSchema.safeParse(command)
      if (!parsed.success) {
        return Promise.resolve(
          errorResult(command.requestId, 'validation', 'Invalid provider limits request.'),
        )
      }
      const { providerId, maxAgeMs } = parsed.data.payload
      if (!state.has(providerId)) {
        return Promise.resolve(errorResult(command.requestId, 'not_found', 'Provider not found.'))
      }
      const limits = refresh(providerId, maxAgeMs)
      return Promise.resolve(
        ProviderLimitsRefreshResponseSchema.parse({
          type: 'response',
          requestId: command.requestId,
          payload: { providerId, limits },
        }),
      )
    },

    stop() {
      stopped = true
      listeners.clear()
    },
  }
}

export type ProviderLimitsService = ReturnType<typeof createProviderLimits>

function mergeObservation(
  existing: ProviderLimitWindow | undefined,
  observation: UsageLimitObservation,
): ProviderLimitWindow {
  const base: ProviderLimitWindow = existing ?? {
    id: observation.windowId,
    label: observation.label,
    group: observation.group,
    usedPercent: null,
    resetsAt: null,
    status: null,
  }
  const resetsAt = observation.resetsAt ?? base.resetsAt
  const rolledOver =
    observation.resetsAt !== undefined &&
    base.resetsAt !== null &&
    Math.abs(Date.parse(observation.resetsAt) - Date.parse(base.resetsAt)) > ROLLOVER_TOLERANCE_MS
  // Leaving a refusal also means the old 100% no longer holds.
  const released =
    base.status === 'limited' &&
    observation.status !== undefined &&
    observation.status !== 'limited'
  let usedPercent = rolledOver || released ? null : base.usedPercent
  if (observation.usedPercentAtLeast !== undefined) {
    usedPercent = Math.max(usedPercent ?? 0, observation.usedPercentAtLeast)
  }
  return {
    ...base,
    usedPercent,
    resetsAt,
    status: observation.status ?? (rolledOver || released ? null : base.status),
  }
}

/** Parse what the provider produced; anything out of contract becomes no reading
 * rather than a broadcast every client would refuse. */
function sanitize(reading: ProviderLimitsReading): ProviderLimitsReading | null {
  const parsed = ProviderLimitsReadingSchema.safeParse(reading)
  return parsed.success ? parsed.data : null
}

function limitsEvent(providerId: string, limits: ProviderLimits) {
  return ProviderLimitsChangedEventSchema.parse({
    type: 'event',
    name: 'provider_limits_changed',
    payload: { providerId, limits },
  })
}

type LimitsRow = {
  provider_id: string
  reading_json: string | null
  last_refresh_json: string | null
}

/** The `provider_limits` table (migration 27). Rows this build cannot read are skipped. */
export function openProviderLimitsStore(
  dataDir: string,
  clock: () => number = Date.now,
): ProviderLimitsStore {
  const database = openEnvironmentDatabase(dataDir)
  const readAll = database.prepare(
    'SELECT provider_id, reading_json, last_refresh_json FROM provider_limits',
  )
  const write = database.prepare(`
    INSERT INTO provider_limits (provider_id, reading_json, last_refresh_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      reading_json = excluded.reading_json,
      last_refresh_json = excluded.last_refresh_json,
      updated_at = excluded.updated_at
  `)
  return {
    load() {
      const rows = new Map<
        string,
        { reading: ProviderLimitsReading | null; lastRefresh: LastRefresh | null }
      >()
      for (const row of readAll.all() as LimitsRow[]) {
        const parsed = ProviderLimitsSchema.shape.reading.safeParse(parseJson(row.reading_json))
        const last = ProviderLimitsSchema.shape.lastRefresh.safeParse(
          parseJson(row.last_refresh_json),
        )
        rows.set(row.provider_id, {
          reading: parsed.success ? parsed.data : null,
          lastRefresh: last.success ? last.data : null,
        })
      }
      return rows
    },
    save(providerId, reading, lastRefresh) {
      write.run(
        providerId,
        reading ? JSON.stringify(reading) : null,
        lastRefresh ? JSON.stringify(lastRefresh) : null,
        clock(),
      )
    },
    close() {
      database.close()
    },
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
