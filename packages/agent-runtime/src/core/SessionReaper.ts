import type { HostDeps } from '../host.js'
import { SESSION_IDLE_TIMEOUT_MS, SESSION_REAP_INTERVAL_MS } from '../session/constants.js'
import type { ThreadId } from '../session/lifecycle.js'
import type { SessionRuntimeRegistry } from '../session/SessionRuntimeRegistry.js'

export type SessionReaperDeps = {
  registry: Pick<SessionRuntimeRegistry, 'reapIdle'>
  log: HostDeps['log']
  /** Idle threshold. Defaults to `SESSION_IDLE_TIMEOUT_MS` (30 minutes). */
  idleMs?: number
  /** Sweep cadence. Defaults to `SESSION_REAP_INTERVAL_MS` (5 minutes). */
  sweepMs?: number
  /** Injected in tests to avoid a real interval timer. */
  schedule?: (run: () => void, ms: number) => { cancel: () => void }
}

/** Stops session runtimes that have gone quiet, so one process per session
 * does not mean unbounded memory.
 *
 * At ~141 MB RSS per `cursor-agent`, this is mandatory rather than an
 * optimisation. The policy is copied from the reference architecture — 30
 * minutes idle, swept every 5 — and the one rule it will not bend is
 * invariant 10: a runtime with a turn in flight is never touched, however long
 * that turn has run. The re-check that makes that true across the awaits of a
 * sweep lives in `SessionRuntimeRegistry.reapIdle`.
 *
 * **Reaping is invisible and lossless.** No UI state changes, nothing is
 * closed, no history is dropped: the ACP session id outlives the process (it
 * is already persisted as the Convex `sessions.externalId`) and the thread's
 * next use lazily respawns and resumes. The entire cost of a wrong decision
 * here is a one-off ~10.2s respawn on Cursor, ~5.8s on OpenCode.
 *
 * **On the focused thread** (§9's open question — should the thread the user
 * is currently looking at be exempt?): **no exemption**, deliberately.
 *
 *  - Visibility is not use. A user reading a thread for an hour generates no
 *    agent work, so keeping its CLI resident buys nothing until they type; the
 *    exemption's whole benefit is removing one 10.2s wait, once.
 *  - It inverts the policy exactly where it matters most. The focused thread
 *    is the one most likely to sit idle-but-watched for hours — a window left
 *    open overnight would pin ~141 MB indefinitely, which is the case the
 *    reaper exists for.
 *  - It cannot be made correct cheaply. It needs a renderer→main channel for
 *    "which thread is focused", and any staleness in it (window closed,
 *    renderer reloaded, app backgrounded) pins a process *forever*. Trading a
 *    bounded, recoverable 10.2s cost for an unbounded, silent leak is the
 *    wrong direction.
 *  - `lastActivityAt` already models the real signal. Anything the user does
 *    that the agent can see — prompting, cancelling, changing model — bumps
 *    it. What is left is only reading, and reading survives a respawn intact.
 */
export class SessionReaper {
  private readonly idleMs: number
  private readonly sweepMs: number
  private readonly schedule: (run: () => void, ms: number) => { cancel: () => void }
  private timer: { cancel: () => void } | undefined
  /** One sweep at a time: a slow `stop()` must not let sweeps pile up. */
  private inFlight: Promise<readonly ThreadId[]> | undefined

  constructor(private readonly deps: SessionReaperDeps) {
    this.idleMs = deps.idleMs ?? SESSION_IDLE_TIMEOUT_MS
    this.sweepMs = deps.sweepMs ?? SESSION_REAP_INTERVAL_MS
    this.schedule =
      deps.schedule ??
      ((run, ms) => {
        const timer = setInterval(run, ms)
        timer.unref?.()
        return { cancel: () => clearInterval(timer) }
      })
  }

  start(): void {
    if (this.timer) return
    this.timer = this.schedule(() => void this.sweep(), this.sweepMs)
  }

  stop(): void {
    this.timer?.cancel()
    this.timer = undefined
  }

  /** Reap everything idle past the threshold. Public so the sweep can be
   * driven deterministically instead of through a timer. */
  sweep(now: number = Date.now()): Promise<readonly ThreadId[]> {
    if (this.inFlight) return this.inFlight
    const run = this.runSweep(now).finally(() => {
      if (this.inFlight === run) this.inFlight = undefined
    })
    this.inFlight = run
    return run
  }

  private async runSweep(now: number): Promise<readonly ThreadId[]> {
    try {
      const reaped = await this.deps.registry.reapIdle(this.idleMs, now)
      if (reaped.length > 0)
        this.deps.log({
          scope: 'agent-runtime',
          level: 'info',
          message: 'Reaped idle session runtimes',
          data: { threadIds: [...reaped], idleMs: this.idleMs },
        })
      return reaped
    } catch (error) {
      // A failed sweep must not kill the interval; the next one retries. It is
      // reported rather than swallowed, because a reaper that has silently
      // stopped working looks exactly like a memory leak.
      this.deps.log({
        scope: 'agent-runtime',
        level: 'warn',
        message: 'Idle session sweep failed',
        data: { error: error instanceof Error ? error.message : String(error) },
      })
      return []
    }
  }
}
