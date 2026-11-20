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
      reading: Pick<ProviderLimitsReading, 'windows' | 'extraUsage' | 'plan' | 'credits'>
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
  usedPercent?: number
}

/** No reading younger than this is read again, whatever a client asks: one
 * read is a CLI held for up to a minute. */
export const MIN_REFRESH_INTERVAL_MS = 60_000
/** What a refresh that names no age accepts. */
export const DEFAULT_REFRESH_MAX_AGE_MS = 5 * 60_000
/** How long "this account has no plan limits" stands for a passive ask (a
 * page or the sidebar, `maxAgeMs > 0`). An account changes kind rarely, and a
 * change is followed by a read of its own (`observeHealth`), so asking sooner
 * only costs a CLI per hover. A deliberate refresh (`maxAgeMs: 0`) is held
 * only to `MIN_REFRESH_INTERVAL_MS`: the provider may have said so for a
 * moment. */
export const UNAVAILABLE_REFRESH_MS = 30 * 60_000
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

/** What limits need from provider health: whether the CLI is there, and
 * whose account it is. */
export type LimitsHealth = {
  install: { state: 'unknown' | 'installed' | 'missing' | 'unusable' }
  auth: { state: 'unknown' | 'authenticated' | 'unauthenticated' | 'error'; accountLabel?: string }
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
  /** Bumped when the account changes: a read started before is the old one's. */
  const generation = new Map<string, number>()
  /** Providers whose probe turned out to have no route to limits. */
  const noRoute = new Set<string>()
  /** Providers a read has answered (numbers, or "no plan limits"), in this
   * run or one before: their CLI has worked. */
  const readBefore = new Set<string>()
  const accounts = new Map<string, { signedIn: boolean; label: string | undefined }>()
  let stopped = false

  /** Whether a provider shows limits once health says `install`. Only a
   * confirmed `missing` hides a card: nothing can be read. `unknown` (not
   * probed yet, a probe that ran out of time, no project to probe in) says
   * nothing, so the card stays as it was. `unusable` is often passing (a
   * handshake that timed out, a CLI mid-update): a provider that has had a
   * reading keeps its card; one never read hides it, as its reads can only
   * fail. */
  const supportedWhen = (
    providerId: string,
    current: boolean,
    install: LimitsHealth['install']['state'],
  ): boolean => {
    if (!deps.supports(providerId) || noRoute.has(providerId)) return false
    switch (install) {
      case 'installed':
        return true
      case 'missing':
        return false
      case 'unusable':
        return readBefore.has(providerId) ? current : false
      case 'unknown':
        return current
    }
  }

  const persisted = deps.store.load()
  for (const providerId of deps.providerIds) {
    const saved = deps.supports(providerId) ? persisted.get(providerId) : undefined
    if (saved?.reading || (saved?.lastRefresh && saved.lastRefresh.outcome !== 'failed'))
      readBefore.add(providerId)
    state.set(providerId, {
      supported: deps.supports(providerId),
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
    // Measured from the last attempt, not the reading's `at`: a live session
    // nudging one window does not make the others fresh. Every outcome holds
    // the client's age, so neither a failing read nor an account without
    // limits starts a CLI each time a client asks; "no limits" holds longer.
    const last = current.lastRefresh
    if (last) {
      const hold =
        last.outcome === 'unavailable' && maxAgeMs > 0
          ? Math.max(floor, UNAVAILABLE_REFRESH_MS)
          : floor
      if (ageMs(last.at) < hold) return current
    }

    set(providerId, { ...current, refreshing: true }, false)
    const started = generation.get(providerId) ?? 0
    const run = (async () => {
      let result: UsageLimitsResult | undefined
      try {
        result = await deps.read(providerId)
      } catch (error) {
        log('warn', 'provider limits read failed', { providerId, reason: String(error) })
      }
      const at = new Date(clock()).toISOString()
      const before = get(providerId)
      // The account changed while this read ran: it may be the old one's.
      if ((generation.get(providerId) ?? 0) !== started) {
        set(providerId, { ...before, refreshing: false }, false)
        return
      }
      if (result?.outcome === 'unsupported') {
        noRoute.add(providerId)
        set(providerId, { ...before, supported: false, refreshing: false }, false)
        return
      }
      const lastRefresh: LastRefresh = {
        outcome: result?.outcome === 'ok' ? 'ok' : result ? 'unavailable' : 'failed',
        at,
      }
      const reading =
        result?.outcome === 'ok'
          ? sanitize({
              windows: result.reading.windows,
              extraUsage: result.reading.extraUsage,
              ...(result.reading.plan !== undefined ? { plan: result.reading.plan } : {}),
              ...(result.reading.credits !== undefined ? { credits: result.reading.credits } : {}),
              at,
            })
          : // A failed read keeps the last numbers up, with their age; an account
            // without plan limits has nothing to keep.
            result?.outcome === 'unavailable'
            ? null
            : before.reading
      if (lastRefresh.outcome !== 'failed') readBefore.add(providerId)
      set(providerId, { ...before, reading, refreshing: false, lastRefresh }, true)
    })().finally(() => inFlight.delete(providerId))
    inFlight.set(providerId, run)
    return get(providerId)
  }

  /** Another account: what was read is not its own. Cleared now, read
   * again at once, after any read still running for the old one. */
  const accountChanged = (providerId: string) => {
    const current = get(providerId)
    generation.set(providerId, (generation.get(providerId) ?? 0) + 1)
    set(providerId, { ...current, reading: null, lastRefresh: null }, true)
    const running = inFlight.get(providerId)
    if (running) void running.then(() => refresh(providerId, 0))
    else refresh(providerId, 0)
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

    /** Provider health moved. A CLI confirmed missing shows no limits
     * (`supportedWhen`: nothing to read, so no card that can only fail); a
     * sign-in,
     * sign-out or another account drops the reading, which was the previous
     * login's, and reads again. The first word on the account after a start
     * changes nothing: the kept reading stands, with its age. */
    observeHealth(providerId: string, health: LimitsHealth): void {
      const current = state.get(providerId)
      if (!current || stopped) return
      const supported = supportedWhen(providerId, current.supported, health.install.state)
      if (supported !== current.supported) set(providerId, { ...current, supported }, false)
      if (!supported) return

      const auth = health.auth
      if (auth.state !== 'authenticated' && auth.state !== 'unauthenticated') return
      const signedIn = auth.state === 'authenticated'
      const before = accounts.get(providerId)
      // A sign-in can be announced before it is named; it keeps the name known.
      const label = signedIn
        ? (auth.accountLabel ?? (before?.signedIn ? before.label : undefined))
        : undefined
      accounts.set(providerId, { signedIn, label })
      if (!before) return
      // An unnamed account gaining a name is news only where the last read
      // found no plan limits: an API key (no email) becoming a subscription.
      // Elsewhere it is the same account being named late.
      const named =
        before.label === undefined &&
        label !== undefined &&
        current.lastRefresh?.outcome === 'unavailable'
      const changed =
        before.signedIn !== signedIn ||
        named ||
        (before.label !== undefined && label !== undefined && before.label !== label)
      if (changed) accountChanged(providerId)
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
      // The plan and credits are a full read's; a window's word keeps them.
      const reading = sanitize({
        ...current.reading,
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
  // An exact number (Codex) is the number, whatever was known.
  if (observation.usedPercent !== undefined) usedPercent = observation.usedPercent
  // Below 100% with no verdict given, an old refusal no longer holds.
  const freed = observation.usedPercent !== undefined && observation.usedPercent < 100
  return {
    ...base,
    usedPercent,
    resetsAt,
    status:
      observation.status ??
      (rolledOver || released || (freed && base.status === 'limited') ? null : base.status),
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
