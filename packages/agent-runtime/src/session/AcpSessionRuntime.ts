import type * as acp from '@agentclientprotocol/sdk'
import type {
  PermissionOutcome,
  PlanReviewOutcome,
  PromptInput,
  ProviderId,
  ProviderSessionInfo,
  QuestionOutcome,
} from '@agentpack/contract'
import type { BackendEventListener, SessionResult } from '../backends/Backend.js'
import type { ExtensionBroker } from '../core/ExtensionBroker.js'
import type { PermissionBroker } from '../core/PermissionBroker.js'
import type { HostDeps } from '../host.js'
import type { ProviderConfig } from '../providers/index.js'
import type { AppliedSessionState } from './AppliedConfigCache.js'
import type { RuntimeTimeouts } from './constants.js'
import type {
  DesiredSessionConfig,
  ProcessExit,
  SessionRuntimePhase,
  SessionRuntimeExit,
  TerminationRequest,
  ThreadId,
} from './lifecycle.js'

/** Identity and starting conditions of one session runtime. Fixed for the
 * runtime's whole life: a different `cwd` means a different runtime, not a
 * mutated one. `AcpBackend.start()` silently ignores its `cwd` argument after
 * the first spawn; making cwd part of the immutable spec is what removes that
 * failure mode. */
export type SessionRuntimeSpec = {
  threadId: ThreadId
  providerId: ProviderId
  workspaceId?: string
  cwd: string
  /** Existing ACP session to `session/load`. Omitted for a fresh
   * `session/new`. Load may fail ("Session not found" for a session that was
   * created but never prompted) — the runtime falls back to `session/new`. */
  sessionId?: string
  resumeCursor?: string
  /** Applied once, immediately after the session exists, while the cache is
   * warm from the `session/new` response. Not re-applied per prompt. */
  desiredConfig?: DesiredSessionConfig
}

/** What a runtime needs from the outside world.
 *
 * The two brokers are deliberately app-wide, not per-runtime: they are already
 * keyed by requestId and every pending record carries its own
 * providerId/threadId/workspaceId/sessionId, so `respondPermission(requestId,
 * …)` keeps working without a requestId -> thread lookup table. A runtime
 * settles only its own thread's requests when it exits. */
export type SessionRuntimeDeps = {
  config: ProviderConfig
  host: Pick<HostDeps, 'log' | 'onSessionTitle'>
  permissions: PermissionBroker
  extensions: ExtensionBroker
  /** Overrides for DEFAULT_RUNTIME_TIMEOUTS. */
  timeouts?: Partial<RuntimeTimeouts>
  /** Transport seam. Defaults to spawning `config.command`; tests inject a
   * fake so the runtime can be exercised without a CLI, instead of reaching
   * into private fields the way the current AcpBackend tests do. */
  connections?: AcpConnectionFactory
}

export type AcpConnectionSpec = {
  providerId: ProviderId
  command: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  /** Handlers for agent-initiated traffic, installed before the first byte. */
  client: acp.Client
  /** Reject the spawn if the child has not produced a connection in time. */
  spawnTimeoutMs: number
  /** Default grace between SIGTERM and SIGKILL in `terminate`, when the
   * `TerminationRequest` does not name its own. */
  terminateGraceMs: number
}

/** One live child process plus its ACP connection. Owns nothing above the
 * transport: no sessions, no config state, no event fan-out. */
export interface AcpConnection {
  readonly connection: acp.ClientSideConnection
  readonly pid: number | undefined
  /** Resolves when the child is gone, whatever the reason. Watching this is
   * how a dead process is noticed *without* waiting for the next RPC to fail. */
  readonly exited: Promise<ProcessExit>
  /** SIGTERM, then SIGKILL after `graceMs`. Idempotent. */
  terminate(request: TerminationRequest): Promise<ProcessExit>
}

export interface AcpConnectionFactory {
  connect(spec: AcpConnectionSpec): Promise<AcpConnection>
}

/** The per-session runtime: one child process, one ACP session, one applied
 * state cache, one liveness. It replaces `AcpBackend`, which owned one process
 * per *provider* shared by every workspace and session.
 *
 * Because a runtime hosts exactly one session, an incoming sessionless
 * `cursor/*` extension request has exactly one possible correlation target.
 * That is what lets Phase 1 delete `promptTail` and the
 * `correlateSessionlessExtensionsToActivePrompt` quirk, and with them the
 * app-wide serialisation of Cursor prompts. */
export interface AcpSessionRuntime {
  readonly threadId: ThreadId
  readonly providerId: ProviderId
  readonly workspaceId: string | undefined
  readonly cwd: string
  readonly phase: SessionRuntimePhase
  /** Set once `session/new` or `session/load` has answered. */
  readonly sessionId: string | undefined
  /** Whether this process's `initialize` response advertised `session/list`.
   * False until the handshake completes. */
  readonly listSessionsAdvertised: boolean
  /** Undefined until the session's first wire response lands. */
  readonly applied: AppliedSessionState | undefined
  /** Latest cursor seen on `session/update`, for respawn-with-resume. */
  readonly resumeCursor: string | undefined
  /** Set exactly once, when the child process is gone. */
  readonly exit: SessionRuntimeExit | undefined
  /** Resolves with the same value `exit` ends up holding. */
  readonly exited: Promise<SessionRuntimeExit>

  /** Spawn, `initialize`, `authenticate`, then `session/new` or
   * `session/load`, each under its own timeout. Idempotent while alive:
   * concurrent callers share the one in-flight start and later calls resolve
   * `{ state: 'reused' }`. Rejects (and tears the process down with
   * `'start_failed'`) if any step fails. Never restarts an exited runtime. */
  start(): Promise<SessionResult>

  /** Run one turn.
   *
   * `desiredConfig` is reconciled *inside* the runtime, atomically with the
   * dispatch of `session/prompt`. A caller must not apply it beforehand and
   * then call this: the model binds at dispatch, so any window between the two
   * is a window in which another caller's selection can take effect for this
   * turn. Passing it here is what makes "which model this turn ran on" a
   * property of the turn rather than of whatever the process happened to hold. */
  prompt(args: {
    prompt: PromptInput
    userMessageId?: string
    desiredConfig?: DesiredSessionConfig
  }): Promise<void>
  cancel(): Promise<void>

  /** Paginated `session/list` for this runtime's own `cwd`, on this runtime's
   * own connection. ~55ms once the process is up, and it reads no model or
   * config state, so borrowing a live process for it cannot perturb a turn —
   * unlike a health probe, which writes config on Cursor and therefore always
   * gets a throwaway process (invariant 9). */
  listSessions(): Promise<ProviderSessionInfo[]>

  setModel(modelId: string): Promise<void>
  setMode(modeId: string): Promise<void>
  setConfigOption(configId: string, value: string | boolean): Promise<void>
  /** Reconcile a whole desired selection in one pass: model first, re-plan,
   * then mode and values, skipping everything the cache says is already
   * satisfied, unsupported or invalid. This is the call that replaces the
   * blind per-message preamble measured at 11.5s of dead time on Cursor. */
  applyDesiredConfig(desired: DesiredSessionConfig): Promise<void>

  respondPermission(requestId: string, outcome: PermissionOutcome): boolean
  respondExtension(requestId: string, response: unknown): boolean
  respondQuestion(requestId: string, outcome: QuestionOutcome): boolean
  respondPlan(requestId: string, outcome: PlanReviewOutcome): boolean

  /** Emits the same `BackendEvent` shape `AcpBackend` does, already carrying
   * this runtime's `threadId`/`workspaceId`, so `AgentRuntime.forward` is
   * unchanged. Returns an unsubscribe. */
  events(listener: BackendEventListener): () => void
  onExit(listener: (exit: SessionRuntimeExit) => void): () => void

  /** Settle pending permissions/extensions, then SIGTERM -> SIGKILL. */
  stop(request: TerminationRequest): Promise<SessionRuntimeExit>
  /** Fire-and-forget `stop({ reason: 'disposed' })`, for the synchronous
   * `AgentRuntime.dispose()` path. */
  dispose(): void
}

export interface SessionRuntimeFactory {
  create(spec: SessionRuntimeSpec): AcpSessionRuntime
}
