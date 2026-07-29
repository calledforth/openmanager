import type { ProviderId } from '@agentpack/contract'

/** Registry key for a session runtime: the *thread* id everything else routes
 * on, never the ACP session id. The two coincide after `create_session`
 * because the job worker rebinds the provisional thread id to the created
 * session id, but they stay distinct concepts and the key is always the
 * thread. Pseudo-threads (`desktop-bootstrap:*`, `session-metadata:*`) are not
 * valid keys — those callers want a probe runtime, not a session runtime. */
export type ThreadId = string

/** Where a runtime is in its one-way lifecycle. There is no path back from
 * `'exited'`: a dead runtime is replaced, never revived. */
export type SessionRuntimePhase = 'created' | 'starting' | 'ready' | 'stopping' | 'exited'

export function isRuntimeAlive(phase: SessionRuntimePhase): boolean {
  return phase === 'starting' || phase === 'ready'
}

/** Why a runtime was asked to stop. Absent on an exit nobody requested — that
 * is the definition of an unexpected exit. */
export type SessionRuntimeStopReason =
  /** App shutdown or `AgentRuntime.dispose()`. */
  | 'disposed'
  /** Idle reaper: no activity for SESSION_IDLE_TIMEOUT_MS and no active turn. */
  | 'reaped'
  /** The concurrency cap was reached and this was the least recently used
   * runtime without a turn in flight. Same consequence as `'reaped'` — a lazy
   * respawn on next use — reached by memory pressure rather than by time. */
  | 'evicted'
  /** A newer runtime took over this thread. */
  | 'superseded'
  /** The user deleted the session. Unlike `'reaped'` there is no lazy respawn
   * to come: the thread will never be used again. */
  | 'session_deleted'
  /** The thread moved to a different working directory. */
  | 'cwd_changed'
  /** Deliberate restart; the caller intends to respawn and resume. */
  | 'restart'
  /** Spawn/handshake/session bootstrap failed; the half-built process is torn down. */
  | 'start_failed'

export type TerminationRequest = {
  reason: SessionRuntimeStopReason
  /** ms to wait after SIGTERM before SIGKILL. Defaults to
   * DEFAULT_RUNTIME_TIMEOUTS.terminateGraceMs. */
  graceMs?: number
}

/** Raw child-process death, as observed by the transport. */
export type ProcessExit = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** SIGKILL was needed because the grace window elapsed. */
  forced: boolean
  /** ISO timestamp. */
  at: string
}

/** A process death attributed to a cause. `expected: false` is the case the
 * current backend cannot report when no session is bound yet — the whole
 * "UI shows Healthy against a dead process" bug. A runtime owns exactly one
 * thread, so there is always somebody to tell. */
export type SessionRuntimeExit = ProcessExit & {
  expected: boolean
  /** Set iff the exit followed a `stop()` call. */
  reason?: SessionRuntimeStopReason
  /** Last resume cursor seen before death, so a respawn can pick up from it. */
  resumeCursor?: string
}

/** Config the user *wants* applied, as opposed to what the agent reports.
 * Durable: it survives process death and is restored on respawn. Today it
 * comes from the workspace's remembered prefs in electron-store plus per-job
 * overrides. */
export type DesiredSessionConfig = {
  modelId?: string
  modeId?: string
  /** configId -> value, e.g. `{ fast: true, thinking: true, effort: 'high' }`. */
  values?: Readonly<Record<string, string | boolean>>
}

/** Everything needed to rebuild a thread's runtime after its process died.
 * The ACP `sessionId` is the durable anchor (it is already persisted in Convex
 * as the session's `externalId`); `resumeCursor` is an optimisation on top.
 *
 * `session/load` fails with "Session not found" for a session that was created
 * but never prompted, so a resume path must fall back to `session/new`. */
export type SessionResumeRecord = {
  threadId: ThreadId
  providerId: ProviderId
  workspaceId?: string
  cwd: string
  sessionId: string
  resumeCursor?: string
  desiredConfig?: DesiredSessionConfig
}
