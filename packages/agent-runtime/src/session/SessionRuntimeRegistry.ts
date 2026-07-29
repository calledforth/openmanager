import type { ProviderId } from '@agentpack/contract'
import type { AcpSessionRuntime, SessionRuntimeSpec } from './AcpSessionRuntime.js'
import type { SessionRuntimeExit, TerminationRequest, ThreadId } from './lifecycle.js'

/** A prompt in flight. The idle reaper must never touch a runtime with one,
 * however long the turn has been running. */
export type ActiveTurn = {
  userMessageId: string
  /** epoch ms. */
  startedAt: number
}

/** Bookkeeping the registry keeps *about* a runtime; the runtime itself owns
 * its process, session and applied state. Everything here is in-memory and
 * dies with the app — nothing in this record is persisted. */
export type SessionRuntimeEntry = {
  readonly threadId: ThreadId
  readonly providerId: ProviderId
  readonly workspaceId: string | undefined
  readonly cwd: string
  readonly runtime: AcpSessionRuntime
  /** epoch ms. */
  readonly startedAt: number
  /** epoch ms of the last prompt, cancel, config write or inbound event. The
   * reaper's 30-minute threshold is measured from here. */
  lastActivityAt: number
  /** Non-null while a `session/prompt` is in flight. */
  activeTurn: ActiveTurn | null
}

/** The single owner of live session runtimes, keyed by thread.
 *
 * One key, one runtime, one process, one ACP session. Reuse requires the spec's
 * `providerId` and `cwd` to match the entry's; a mismatch supersedes the
 * existing runtime (stop, then respawn with resume) rather than silently
 * reusing a process pointed at the wrong directory. */
export interface SessionRuntimeRegistry {
  get(threadId: ThreadId): SessionRuntimeEntry | undefined
  entries(): readonly SessionRuntimeEntry[]
  forProvider(providerId: ProviderId): readonly SessionRuntimeEntry[]
  forWorkspace(workspaceId: string): readonly SessionRuntimeEntry[]

  /** Create-or-reuse, starting the runtime if it is not already started.
   * Concurrent callers for the same thread share one in-flight start. */
  ensure(spec: SessionRuntimeSpec): Promise<SessionRuntimeEntry>

  /** Bump `lastActivityAt`. No-op for an unknown thread. */
  touch(threadId: ThreadId, at?: number): void
  beginTurn(threadId: ThreadId, turn: ActiveTurn): void
  endTurn(threadId: ThreadId): void

  /** Reap candidates: no active turn and idle for at least `idleMs`. */
  idleSince(idleMs: number, now?: number): readonly SessionRuntimeEntry[]

  /** Stop every `idleSince` candidate with reason `'reaped'`, re-checking each
   * one immediately before it is stopped.
   *
   * The re-check is the whole point of doing this in the registry rather than
   * in the reaper: stopping a runtime awaits the child's death, and a prompt
   * can arrive for a later candidate during that await. Invariant 10 is only
   * upheld if "no active turn" is true at the moment of the kill, not at the
   * moment the list was taken. Resolves with the threads actually reaped. */
  reapIdle(idleMs: number, now?: number): Promise<readonly ThreadId[]>

  /** Stop and forget. Resolves once the child is gone. */
  remove(threadId: ThreadId, request: TerminationRequest): Promise<SessionRuntimeExit | undefined>

  /** Called by the registry itself when a runtime exits unexpectedly, so the
   * entry never outlives its process — the bug that lets the UI report
   * "Healthy" against a dead child today. */
  onRuntimeExit(
    listener: (entry: SessionRuntimeEntry, exit: SessionRuntimeExit) => void,
  ): () => void

  /** Stop everything and wait for every child to be gone, for app shutdown.
   * Terminates runtimes mid-turn too — quitting is not negotiable, and a
   * process that outlives the app is an orphan. */
  shutdown(request: TerminationRequest): Promise<void>

  /** Fire-and-forget `shutdown`, for callers with no place to await. Signals
   * are delivered synchronously; only the reaping of the corpses is not
   * awaited. */
  disposeAll(): void
}
