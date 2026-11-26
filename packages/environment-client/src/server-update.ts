import {
  compareServerVersions,
  SERVER_UPDATE_PATH,
  ServerUpdateStatusSchema,
  type ServerUpdateStatus,
} from '@openmanager/protocol'
import { environmentSocketUrl } from './connection/environment-store'
import { EnvironmentClientError } from './errors'
import { environmentHttpUrl } from './websocket'

/**
 * The environment server's own updates, read and started over HTTP
 * (protocol/server-update.ts). Nothing here needs a connected socket: a
 * client the server refused for being on a newer protocol uses this too.
 */

export interface ServerUpdateTarget {
  /** The stored HTTP endpoint, as the environment list keeps it. */
  endpoint: string
  credential: string
  fetch?: typeof fetch
}

function updateUrl(endpoint: string, query = ''): string {
  return `${environmentHttpUrl(environmentSocketUrl(endpoint), SERVER_UPDATE_PATH)}${query}`
}

async function refusal(response: Response, fallback: string): Promise<EnvironmentClientError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown }
  } | null
  const message = typeof body?.error?.message === 'string' ? body.error.message : fallback
  const code =
    response.status === 401
      ? 'auth'
      : response.status === 403
        ? 'capability_missing'
        : response.status === 400
          ? 'validation'
          : response.status === 409
            ? 'conflict'
            : 'unavailable'
  return new EnvironmentClientError(code, message)
}

/**
 * The server's update status, or `'unsupported'` when the server is older
 * than the route (it answers 404). `check` asks GitHub for the newest
 * release first; the server does that at most every ten seconds.
 */
export async function fetchServerUpdateStatus(
  target: ServerUpdateTarget,
  options: { check?: boolean; signal?: AbortSignal } = {},
): Promise<ServerUpdateStatus | 'unsupported'> {
  const response = await (target.fetch ?? globalThis.fetch)(
    updateUrl(target.endpoint, options.check ? '?check=1' : ''),
    {
      headers: { authorization: `Bearer ${target.credential}` },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  )
  if (response.status === 404) return 'unsupported'
  if (!response.ok) throw await refusal(response, 'The update status could not be read.')
  return ServerUpdateStatusSchema.parse(await response.json())
}

/** Ask the server to update itself, to `version` or the newest release. */
export async function startServerUpdate(
  target: ServerUpdateTarget,
  version?: string,
): Promise<ServerUpdateStatus> {
  const response = await (target.fetch ?? globalThis.fetch)(updateUrl(target.endpoint), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(version ? { version } : {}),
  })
  if (response.status === 404) {
    throw new EnvironmentClientError(
      'not_found',
      'This server is too old to update from here. Run "openmanager update" on its machine.',
    )
  }
  if (!response.ok) throw await refusal(response, 'The server did not start the update.')
  return ServerUpdateStatusSchema.parse(await response.json())
}

export type ServerUpdateWatchSnapshot = {
  /** The last status read, if any. */
  status: ServerUpdateStatus | undefined
  /** The server predates the update route. */
  unsupported: boolean
  /** A start request is on its way. */
  starting: boolean
  /** The last request failed (and no update was running to explain it). */
  error: string | undefined
  /** This watcher saw the server move from one version to another. */
  justUpdated: { from: string; to: string } | undefined
}

export type ServerUpdateWatcher = {
  getSnapshot(): ServerUpdateWatchSnapshot
  subscribe(listener: () => void): () => void
  refresh(options?: { check?: boolean }): Promise<void>
  update(version?: string): Promise<void>
  /** Forget `justUpdated` once a client has shown it. */
  acknowledge(): void
  dispose(): void
}

/** Polling while idle: an hour, since the server itself checks GitHub every six. */
export const SERVER_UPDATE_IDLE_POLL_MS = 60 * 60_000
/** Polling while an update runs: the server goes away and comes back. */
export const SERVER_UPDATE_BUSY_POLL_MS = 2_000
/** How long an unreachable server is taken to be restarting, not broken. */
export const SERVER_UPDATE_RESTART_GRACE_MS = 3 * 60_000

/**
 * One environment's update status, kept fresh: read when created, every hour,
 * and every two seconds while an update runs, through the restart. When the
 * answering version changes after this watcher saw an update start, it says
 * so once (`justUpdated`), which is what a client toasts.
 */
export function createServerUpdateWatcher(
  target: ServerUpdateTarget,
  options: { now?: () => number; idlePollMs?: number; busyPollMs?: number } = {},
): ServerUpdateWatcher {
  const now = options.now ?? Date.now
  const listeners = new Set<() => void>()
  let snapshot: ServerUpdateWatchSnapshot = {
    status: undefined,
    unsupported: false,
    starting: false,
    error: undefined,
    justUpdated: undefined,
  }
  /** The version answering when this watcher saw an update begin. */
  let watchingFrom: { version: string; since: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let inFlight: Promise<void> | undefined

  const set = (next: Partial<ServerUpdateWatchSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }

  const schedule = () => {
    clearTimeout(timer)
    if (disposed) return
    const busy = watchingFrom !== undefined || snapshot.status?.state === 'updating'
    timer = setTimeout(
      () => void refresh(),
      busy
        ? (options.busyPollMs ?? SERVER_UPDATE_BUSY_POLL_MS)
        : (options.idlePollMs ?? SERVER_UPDATE_IDLE_POLL_MS),
    )
  }

  const observe = (status: ServerUpdateStatus) => {
    if (status.state === 'updating' && !watchingFrom) {
      watchingFrom = { version: status.currentVersion, since: now() }
    }
    let justUpdated = snapshot.justUpdated
    if (watchingFrom && status.currentVersion !== watchingFrom.version) {
      if (compareServerVersions(status.currentVersion, watchingFrom.version) > 0) {
        justUpdated = { from: watchingFrom.version, to: status.currentVersion }
      }
      watchingFrom = undefined
    } else if (watchingFrom && status.state !== 'updating') {
      // Failed, or installed but waiting for a restart: nothing more to watch.
      watchingFrom = undefined
    }
    set({ status, unsupported: false, error: undefined, justUpdated })
  }

  async function refresh(refreshOptions: { check?: boolean } = {}): Promise<void> {
    if (disposed) return
    if (inFlight && !refreshOptions.check) return inFlight
    const run = (async () => {
      try {
        const status = await fetchServerUpdateStatus(target, refreshOptions)
        if (disposed) return
        if (status === 'unsupported') set({ unsupported: true, error: undefined })
        else observe(status)
      } catch (error) {
        if (disposed) return
        // Mid-update the server is down for a while; that is not an error.
        if (watchingFrom && now() - watchingFrom.since < SERVER_UPDATE_RESTART_GRACE_MS) return
        watchingFrom = undefined
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        schedule()
      }
    })().finally(() => {
      if (inFlight === run) inFlight = undefined
    })
    inFlight = run
    return run
  }

  async function update(version?: string): Promise<void> {
    if (snapshot.starting) return
    const from = snapshot.status?.currentVersion
    set({ starting: true, error: undefined, justUpdated: undefined })
    try {
      const status = await startServerUpdate(target, version)
      watchingFrom = { version: from ?? status.currentVersion, since: now() }
      observe(status)
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      set({ starting: false })
      schedule()
    }
  }

  void refresh()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    update,
    acknowledge() {
      if (snapshot.justUpdated) set({ justUpdated: undefined })
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      listeners.clear()
    },
  }
}

export type ServerUpdateNotice =
  | { kind: 'none' }
  | { kind: 'available'; from: string; to: string; canUpdate: boolean; reason?: string }
  | { kind: 'updating'; to: string | undefined }
  | { kind: 'failed'; to: string | undefined; error: string }
  | { kind: 'restart_required'; to: string | undefined }
  | { kind: 'updated'; from: string; to: string }

/** What a client shows for one environment, from its watcher's snapshot. */
export function serverUpdateNotice(snapshot: ServerUpdateWatchSnapshot): ServerUpdateNotice {
  if (snapshot.justUpdated) return { kind: 'updated', ...snapshot.justUpdated }
  const status = snapshot.status
  if (snapshot.starting) return { kind: 'updating', to: status?.latestVersion ?? undefined }
  if (!status) return { kind: 'none' }
  if (status.state === 'updating') return { kind: 'updating', to: status.targetVersion }
  if (status.state === 'restart_required') {
    return { kind: 'restart_required', to: status.targetVersion }
  }
  if (status.state === 'failed') {
    return {
      kind: 'failed',
      to: status.targetVersion,
      error: status.error ?? 'The update failed.',
    }
  }
  if (status.updateAvailable && status.latestVersion) {
    return {
      kind: 'available',
      from: status.currentVersion,
      to: status.latestVersion,
      canUpdate: status.canUpdate,
      ...(status.cannotUpdateReason ? { reason: status.cannotUpdateReason } : {}),
    }
  }
  return { kind: 'none' }
}
