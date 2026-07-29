import type { ProviderId } from '@agentpack/contract'
import type { BackendEvent, SessionResult } from '../backends/Backend.js'
import type { HostDeps } from '../host.js'
import type { SessionRuntimeSpec } from './AcpSessionRuntime.js'
import type { ManagedSessionRuntime, ManagedSessionRuntimeFactory } from './AcpSessionRuntimeImpl.js'
import { MAX_SESSION_RUNTIMES } from './constants.js'
import {
  isRuntimeAlive,
  type SessionRuntimeExit,
  type TerminationRequest,
  type ThreadId,
} from './lifecycle.js'
import type {
  ActiveTurn,
  SessionRuntimeEntry,
  SessionRuntimeRegistry,
} from './SessionRuntimeRegistry.js'

/** The registry's own copy of an entry. Phase 0's `SessionRuntimeEntry`
 * declares `threadId`/`workspaceId` readonly, which is right for consumers;
 * the registry mutates them for the `create_session` rebind (invariant 4). */
type MutableEntry = {
  threadId: ThreadId
  providerId: ProviderId
  workspaceId: string | undefined
  cwd: string
  runtime: ManagedSessionRuntime
  startedAt: number
  lastActivityAt: number
  activeTurn: ActiveTurn | null
  /** Bumped by every activity, so a sweep can tell "nothing happened" from
   * "something happened in the same millisecond". Deliberately a counter and
   * not `lastActivityAt`: `Date.now()` has millisecond resolution, and the one
   * thing `reapIdle` must never do is mistake a prompt that arrived during its
   * own await for no activity at all. Same reasoning as the health monitor's
   * `healthySeq`. */
  activitySeq: number
}

export type SessionRuntimeRegistryDeps = {
  runtimes: ManagedSessionRuntimeFactory
  /** Every event a runtime emits, already stamped with its thread route. */
  onEvent: (providerId: ProviderId, event: BackendEvent) => void
  log: HostDeps['log']
  /** Soft LRU ceiling on live runtimes. Defaults to `MAX_SESSION_RUNTIMES`;
   * `0` disables eviction entirely. */
  limit?: number
}

/** Sole owner of live session runtimes, keyed by thread.
 *
 * One key, one runtime, one process, one ACP session. An entry never outlives
 * its process: the runtime's exit listener removes it in the same tick. */
export class SessionRuntimeRegistryImpl implements SessionRuntimeRegistry {
  private readonly byThread = new Map<ThreadId, MutableEntry>()
  /** In-flight starts, with the spec each one is starting *for*. The spec is
   * the point: a start is only shareable by a caller that wants the same
   * process, and "same process" means the same provider in the same
   * directory. */
  private readonly starting = new Map<ThreadId, InFlightStart>()
  private readonly exitListeners = new Set<
    (entry: SessionRuntimeEntry, exit: SessionRuntimeExit) => void
  >()

  private readonly limit: number
  /** Serialises capacity decisions; see `reserveCapacity`. */
  private capacityGate: Promise<void> = Promise.resolve()
  /** Runtimes that have been admitted under the cap but are not in `byThread`
   * yet. Without counting them, N concurrent creates all measure a map that
   * contains none of the others and all conclude there is room. */
  private reserved = 0
  /** Set by `shutdown`/`disposeAll`. A registry that has been told the app is
   * going away must never spawn again: a job that resumes after the shutdown
   * snapshot was taken would otherwise create a child nothing is left to kill. */
  private closed = false

  constructor(private readonly deps: SessionRuntimeRegistryDeps) {
    this.limit = deps.limit ?? MAX_SESSION_RUNTIMES
  }

  get(threadId: ThreadId): SessionRuntimeEntry | undefined {
    return this.byThread.get(threadId)
  }
  entries(): readonly SessionRuntimeEntry[] {
    return [...this.byThread.values()]
  }
  forProvider(providerId: ProviderId): readonly SessionRuntimeEntry[] {
    return this.entries().filter((entry) => entry.providerId === providerId)
  }
  forWorkspace(workspaceId: string): readonly SessionRuntimeEntry[] {
    return this.entries().filter((entry) => entry.workspaceId === workspaceId)
  }

  /** The entry that owns an ACP session id, for the `create_session` rebind. */
  findBySession(providerId: ProviderId, sessionId: string): SessionRuntimeEntry | undefined {
    return this.entries().find(
      (entry) => entry.providerId === providerId && entry.runtime.sessionId === sessionId,
    )
  }

  /** Move a live runtime from a provisional thread id to its permanent one.
   * No-op when the source is unknown or the target is already taken. */
  rekey(from: ThreadId, to: ThreadId, workspaceId: string | undefined): SessionRuntimeEntry | undefined {
    const entry = this.byThread.get(from)
    if (!entry || from === to || this.byThread.has(to)) return undefined
    this.byThread.delete(from)
    entry.threadId = to
    if (workspaceId !== undefined) entry.workspaceId = workspaceId
    entry.runtime.rebindThread(to, workspaceId)
    this.byThread.set(to, entry)
    return entry
  }

  async ensure(spec: SessionRuntimeSpec): Promise<SessionRuntimeEntry> {
    return (await this.ensureStarted(spec)).entry
  }

  /** `ensure` plus the `SessionResult` of the start it triggered. `ensure`
   * alone cannot report created-vs-loaded, which `AgentRuntime.ensureSession`
   * has to return to its callers.
   *
   * Concurrent callers share one start **only when they are asking for the
   * same process.** Keying the in-flight map on the thread id alone let an
   * ensure for thread T in directory B join an in-flight start for thread T in
   * directory A and receive A's process — a coding agent rooted in the wrong
   * workspace, for a whole ~10s start window. A conflicting caller now queues
   * behind the start it cannot share and supersedes it, which is exactly what
   * `createOrReuse` does for a cwd change that arrives a moment later.
   *
   * The comparison is against the *latest queued* spec, not the running one:
   * a third caller that wants what the first wanted must supersede again
   * rather than inherit the second's directory. */
  async ensureStarted(spec: SessionRuntimeSpec): Promise<StartedEntry> {
    if (this.closed) throw new Error('The session runtime registry is shutting down')
    const inFlight = this.starting.get(spec.threadId)
    if (inFlight && sharesProcess(inFlight.spec, spec)) return inFlight.run
    const previous = inFlight?.run
    const run = (
      previous ? previous.then(noop, noop) : Promise.resolve()
    ).then(() => this.createOrReuse(spec))
    const record: InFlightStart = { spec, run }
    // Cleanup after the map is populated, so a synchronous rejection cannot
    // delete an entry that has not been written yet.
    void run.then(
      () => this.clearStart(spec.threadId, record),
      () => this.clearStart(spec.threadId, record),
    )
    this.starting.set(spec.threadId, record)
    return run
  }

  private clearStart(threadId: ThreadId, record: InFlightStart): void {
    if (this.starting.get(threadId) === record) this.starting.delete(threadId)
  }

  private async createOrReuse(spec: SessionRuntimeSpec): Promise<StartedEntry> {
    if (this.closed) throw new Error('The session runtime registry is shutting down')
    const existing = this.byThread.get(spec.threadId)
    let resume: { sessionId?: string; resumeCursor?: string } = {}
    if (existing) {
      if (
        existing.providerId === spec.providerId &&
        existing.cwd === spec.cwd &&
        isRuntimeAlive(existing.runtime.phase)
      ) {
        this.noteActivity(existing)
        return { entry: existing, result: await existing.runtime.start() }
      }
      // A different provider or directory supersedes the runtime rather than
      // silently reusing a process pointed at the wrong place. Carry the
      // session forward so history survives the respawn.
      resume = {
        sessionId: existing.runtime.sessionId,
        resumeCursor: existing.runtime.resumeCursor,
      }
      await this.remove(spec.threadId, {
        reason: existing.providerId === spec.providerId ? 'cwd_changed' : 'superseded',
      })
    }

    await this.reserveCapacity(spec.threadId)
    let entry: MutableEntry
    let runtime: ManagedSessionRuntime
    try {
      runtime = this.deps.runtimes.create({
        ...spec,
        sessionId: spec.sessionId ?? resume.sessionId,
        resumeCursor: spec.resumeCursor ?? resume.resumeCursor,
      })
      const now = Date.now()
      entry = {
        threadId: spec.threadId,
        providerId: spec.providerId,
        workspaceId: spec.workspaceId,
        cwd: spec.cwd,
        runtime,
        startedAt: now,
        lastActivityAt: now,
        activeTurn: null,
        activitySeq: 0,
      }
      this.byThread.set(spec.threadId, entry)
    } finally {
      // The reservation exists only to cover the gap between being admitted
      // and being countable in `byThread`; once the entry is in the map (or
      // creation has failed) it is over.
      this.reserved -= 1
    }
    const unsubscribe = runtime.events((event) => {
      this.noteActivity(entry)
      this.deps.onEvent(entry.providerId, event)
    })
    runtime.onExit((exit) => {
      unsubscribe()
      if (this.byThread.get(entry.threadId) === entry) this.byThread.delete(entry.threadId)
      entry.activeTurn = null
      for (const listener of this.exitListeners) listener(entry, exit)
    })
    try {
      return { entry, result: await runtime.start() }
    } catch (error) {
      // start() already tore the half-built process down; drop the entry so a
      // retry gets a fresh runtime rather than a permanently dead one.
      if (this.byThread.get(entry.threadId) === entry) this.byThread.delete(entry.threadId)
      throw error
    }
  }

  touch(threadId: ThreadId, at: number = Date.now()): void {
    const entry = this.byThread.get(threadId)
    if (entry) this.noteActivity(entry, at)
  }
  beginTurn(threadId: ThreadId, turn: ActiveTurn): void {
    const entry = this.byThread.get(threadId)
    if (!entry) return
    entry.activeTurn = turn
    this.noteActivity(entry)
  }
  endTurn(threadId: ThreadId): void {
    const entry = this.byThread.get(threadId)
    if (!entry) return
    entry.activeTurn = null
    this.noteActivity(entry)
  }

  private noteActivity(entry: MutableEntry, at: number = Date.now()): void {
    entry.lastActivityAt = at
    entry.activitySeq += 1
  }

  idleSince(idleMs: number, now: number = Date.now()): readonly SessionRuntimeEntry[] {
    return this.idleEntries(idleMs, now)
  }

  private idleEntries(idleMs: number, now: number): MutableEntry[] {
    return [...this.byThread.values()].filter(
      (entry) =>
        entry.activeTurn === null &&
        !isStarting(entry) &&
        now - entry.lastActivityAt >= idleMs,
    )
  }

  async reapIdle(idleMs: number, now: number = Date.now()): Promise<readonly ThreadId[]> {
    // Snapshot each candidate's activity counter alongside it. Stopping the
    // first candidate awaits a child's death, and anything that happens on
    // another thread during that await — a prompt, a config write, an inbound
    // event — bumps that entry's counter. Comparing against the snapshot is
    // how the sweep notices, and it stays correct under an injected clock in a
    // way that re-reading `Date.now()` would not.
    const candidates = this.idleEntries(idleMs, now).map((entry) => ({
      entry,
      activitySeq: entry.activitySeq,
    }))
    const reaped: ThreadId[] = []
    for (const candidate of candidates) {
      const current = this.byThread.get(candidate.entry.threadId)
      if (!current || current !== candidate.entry) continue
      // Invariant 10, re-proved at the moment of the kill.
      if (current.activeTurn !== null) continue
      if (isStarting(current)) continue
      if (current.activitySeq !== candidate.activitySeq) continue
      await this.remove(current.threadId, { reason: 'reaped' })
      reaped.push(current.threadId)
    }
    return reaped
  }

  /** Admit one runtime under the cap.
   *
   * Serialised, and it counts the admissions it has already granted. Both
   * halves are needed: two concurrent creates otherwise select the *same*
   * least-recently-used victim, the second `remove` finds it already gone and
   * the loop's anti-spin guard gives up, so both creates proceed and the map
   * ends up over the cap. Deciding one at a time, against a count that
   * includes creates still in flight, is what makes the cap mean something
   * under concurrency. */
  private async reserveCapacity(exempt: ThreadId): Promise<void> {
    const admit = async (): Promise<void> => {
      await this.evictForCapacity(exempt)
      this.reserved += 1
    }
    const run = this.capacityGate.then(admit, admit)
    this.capacityGate = run.then(noop, noop)
    return run
  }

  /** Make room for one more runtime by stopping the least recently used one,
   * repeatedly, until the map is below the cap.
   *
   * Never evicts a runtime with a turn in flight, or one still starting: if
   * every live runtime is busy there is nothing safe to stop, and exceeding
   * the cap is strictly better than destroying a turn or failing somebody
   * else's ~10s handshake. The cap is therefore soft by construction, which
   * is the correct shape — the same reasoning as invariant 10. */
  private async evictForCapacity(exempt: ThreadId): Promise<void> {
    if (this.limit <= 0) return
    while (this.byThread.size + this.reserved >= this.limit) {
      const victim = this.evictionCandidate(exempt)
      if (!victim) return
      const size = this.byThread.size
      this.deps.log({
        scope: 'agent-runtime',
        level: 'info',
        message: 'Evicting the least recently used session runtime to stay under the cap',
        data: {
          providerId: victim.providerId,
          threadId: victim.threadId,
          idleMs: Date.now() - victim.lastActivityAt,
          limit: this.limit,
        },
      })
      await this.remove(victim.threadId, { reason: 'evicted' })
      // Defensive: a `remove` that did not shrink the map would spin forever.
      if (this.byThread.size >= size) return
    }
  }

  private evictionCandidate(exempt: ThreadId): MutableEntry | undefined {
    let oldest: MutableEntry | undefined
    for (const entry of this.byThread.values()) {
      if (entry.threadId === exempt || entry.activeTurn !== null) continue
      // A runtime mid-`start()` looks maximally idle — `lastActivityAt` only
      // advances on events, and the authenticate step is a silent multi-second
      // gap — so it is the *first* thing an LRU scan picks. Killing it fails
      // its caller with "exited during startup".
      if (isStarting(entry)) continue
      if (!oldest || entry.lastActivityAt < oldest.lastActivityAt) oldest = entry
    }
    return oldest
  }

  async remove(
    threadId: ThreadId,
    request: TerminationRequest,
  ): Promise<SessionRuntimeExit | undefined> {
    const entry = this.byThread.get(threadId)
    if (!entry) return undefined
    const exit = await entry.runtime.stop(request)
    if (this.byThread.get(threadId) === entry) this.byThread.delete(threadId)
    return exit
  }

  onRuntimeExit(
    listener: (entry: SessionRuntimeEntry, exit: SessionRuntimeExit) => void,
  ): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Terminate every runtime and wait for every child to actually be gone.
   *
   * `Promise.allSettled`, not `Promise.all`: one runtime that cannot be
   * stopped must not leave the other seven un-awaited and orphaned. Failures
   * are logged rather than thrown, because there is no caller left to handle
   * them — this runs while the app is quitting. */
  async shutdown(request: TerminationRequest): Promise<void> {
    // Closing first is what makes the snapshot below complete. Taking it while
    // `ensureStarted` is still callable leaves a window in which a job that
    // resumes mid-shutdown spawns a ~230 MB CLI that this call has already
    // walked past — an orphan with no parent left to reap it.
    this.closed = true
    // Starts already in flight are awaited rather than dropped: each one owns
    // a child process that is being spawned right now, and forgetting the
    // promise would not stop it. Their entries are in `byThread` from the
    // moment the runtime is created, so stopping every entry after they settle
    // covers them.
    const pending = [...this.starting.values()].map((start) => start.run.then(noop, noop))
    this.starting.clear()
    if (pending.length > 0) await Promise.all(pending)
    const entries = [...this.byThread.values()]
    const results = await Promise.allSettled(
      entries.map((entry) => entry.runtime.stop(request)),
    )
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') continue
      this.deps.log({
        scope: 'agent-runtime',
        level: 'error',
        message: 'Session runtime did not stop cleanly on shutdown',
        data: {
          providerId: entries[index]?.providerId,
          threadId: entries[index]?.threadId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
      })
    }
    this.byThread.clear()
  }

  disposeAll(): void {
    // `stop()` sends the signal synchronously before its first await, so a
    // caller with no place to await still gets SIGTERM delivered. Only the
    // SIGKILL escalation and the exit bookkeeping happen after this returns —
    // which is why app quit uses `shutdown()` instead.
    this.closed = true
    for (const entry of this.byThread.values()) entry.runtime.dispose()
    void this.shutdown({ reason: 'disposed' })
    this.byThread.clear()
    this.starting.clear()
  }
}

const noop = (): void => undefined

/** Whether two specs describe the same process. `cwd` and `providerId` are
 * immutable on a runtime (invariant 3), so they are exactly the fields that
 * decide whether a caller may share somebody else's start. `sessionId` is not
 * one of them: a runtime owns one session for life, so a caller naming a
 * different session for a live thread is asking to reuse, which is what
 * `createOrReuse` already does. */
function sharesProcess(a: SessionRuntimeSpec, b: SessionRuntimeSpec): boolean {
  return a.providerId === b.providerId && a.cwd === b.cwd
}

/** A runtime whose `start()` has not finished. Neither the reaper nor LRU
 * eviction may touch one: it has an owner waiting on it, and its idleness is
 * an artefact of a handshake that emits nothing for seconds at a time. */
function isStarting(entry: MutableEntry): boolean {
  return entry.runtime.phase === 'created' || entry.runtime.phase === 'starting'
}

type InFlightStart = { spec: SessionRuntimeSpec; run: Promise<StartedEntry> }

export type StartedEntry = { entry: SessionRuntimeEntry; result: SessionResult }
