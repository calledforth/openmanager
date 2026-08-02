import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  PermissionOption,
  PermissionOutcome,
  PlanReviewOutcome,
  PromptInput,
  ProviderId,
  ProviderSessionInfo,
  QuestionOutcome,
  SessionConfigOption,
} from '@agentpack/contract'
import type {
  BackendEvent,
  BackendEventListener,
  BackendRoute,
  SessionResult,
} from '../../backends/Backend.js'
import { CapabilityMissingError } from '../../core/errors.js'
import type {
  InteractionBroker,
  InteractionKind,
  InteractionOutcome,
} from '../../core/InteractionBroker.js'
import { PERMISSION_TIMEOUT_MS, type PermissionBroker } from '../../core/PermissionBroker.js'
import type { HostDeps } from '../../host.js'
import type { ClaudeProviderConfig } from '../../providers/index.js'
import type { AppliedSessionState } from '../AppliedConfigCache.js'
import { DEFAULT_RUNTIME_TIMEOUTS, type RuntimeTimeouts } from '../constants.js'
import type {
  DesiredSessionConfig,
  ProcessExit,
  SessionRuntimeExit,
  SessionRuntimePhase,
  TerminationRequest,
  ThreadId,
} from '../lifecycle.js'
import type { ManagedSessionRuntime } from '../AcpSessionRuntimeImpl.js'
import type { SessionRuntimeSpec } from '../SessionRuntime.js'
import { RpcTimeoutError, withTimeout } from '../timeout.js'
import { errorMessage, PLAN_REVIEW_TIMEOUT_MS, routeEvent } from '../wire.js'
import { ClaudeMessageTranslator, type TranslatedMessage } from './ClaudeMessageTranslator.js'
import {
  claudeQuestionAnswers,
  parseAskUserQuestion,
  planFromExitPlanMode,
  type PendingClaudeQuestions,
} from './claude-interactions.js'
import { claudePromptContent, CLAUDE_PROMPT_CAPABILITIES } from './claude-prompt.js'
import { claudeToolKind } from './claude-tools.js'
import { resolveClaudeExecutable } from './executable.js'
import { loadClaudeSdk, type ClaudeQuerySession, type ClaudeSdk } from './sdk.js'

/** The callback's third argument, named once so the routing methods below can
 * take it without re-declaring the SDK's inline option bag. */
type CanUseToolOptions = Parameters<CanUseTool>[2]

/** The two permission modes in which the user has said, up front, that they do
 * not want to be asked. Both must be checked AFTER the two interactive tools:
 * `AskUserQuestion` and `ExitPlanMode` are not permission prompts, they are the
 * model asking the user a question and proposing a plan, and short-circuiting
 * them here would silently answer both on the user's behalf. */
const FULL_ACCESS_MODES: readonly PermissionMode[] = ['bypassPermissions', 'dontAsk']

/** What a cancelled, timed-out or rejected interaction tells Claude Code. The
 * SDK treats this as an ordinary tool denial and lets the model continue, which
 * is what should happen when a user dismisses a question. */
const USER_CANCELLED: PermissionResult = {
  behavior: 'deny',
  message: 'User cancelled tool execution.',
}

/** `PermissionBroker`'s reply shape, restated structurally because the broker
 * does not export it. Kept exact so a change there is a compile error here. */
type PermissionProtocolResponse = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}

export type ClaudeSessionRuntimeDeps = {
  config: ClaudeProviderConfig
  host: Pick<HostDeps, 'log' | 'onSessionTitle'>
  permissions: PermissionBroker
  interactions: InteractionBroker
  timeouts?: Partial<RuntimeTimeouts>
  /** The SDK module, injectable for the same reason `AcpConnectionFactory` is:
   * tests drive real startup, real turn binding and real exit rather than
   * overwriting private fields. Defaults to the published module, loaded on
   * first start. */
  sdk?: ClaudeSdk
  /** Environment the executable is resolved against. Injectable so a test can
   * exercise both branches of `CLAUDE_CODE_BIN` without mutating the real
   * process environment. */
  env?: NodeJS.ProcessEnv
}

/** The permission modes Claude Code accepts. Ours are opaque strings from the
 * composer, so an unknown one is refused here rather than sent to the CLI,
 * which would reject it asynchronously with the turn already dispatched. */
const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]

/** Which SDK `system` subtypes carry a session id that is NOT the durable one.
 *
 * We pass `settingSources: ['user', 'project', 'local']` so the user's own
 * `~/.claude/settings.json` hooks run — that is the point of driving the real
 * CLI. Hook frames are emitted from the hook's own short-lived context and
 * carry its transient id. Adopting one as the session id persists it to Convex
 * as the thread's `externalId`, and the next launch resumes a transcript that
 * never existed. */
const TRANSIENT_SESSION_ID_SUBTYPES = new Set(['hook_started', 'hook_progress', 'hook_response'])

type ActiveTurn = {
  id: string
  sessionId: string
  state: 'dispatched' | 'completing'
  settle: (error?: unknown) => void
  /** Resolves when this turn leaves the state machine, however it leaves. */
  done: Promise<void>
}

/** One Claude Code subprocess, one transcript, one thread.
 *
 * The shape mirrors `AcpSessionRuntimeImpl` because everything above this
 * interface — the registry, the reaper, `AgentRuntime.forward` — is written
 * against `SessionRuntime` and must not learn that a second transport exists.
 * What differs is entirely below the surface: there is no request/response
 * wire here. A single `query()` stays open for the runtime's whole life with a
 * never-ending input stream feeding it, every turn rides that one query, and
 * correlation is done by matching a terminal `result` against the dispatch
 * that is currently active rather than by an RPC id. */
export class ClaudeSessionRuntime implements ManagedSessionRuntime {
  readonly providerId: ProviderId
  readonly cwd: string
  readonly exited: Promise<SessionRuntimeExit>

  private threadIdValue: ThreadId
  private workspaceIdValue: string | undefined
  private phaseValue: SessionRuntimePhase = 'created'
  private sessionIdValue: string | undefined
  private exitValue: SessionRuntimeExit | undefined
  private resolveExited!: (exit: SessionRuntimeExit) => void

  private sdk: ClaudeSdk | undefined
  private query: ClaudeQuerySession | undefined
  private input: InputQueue | undefined
  private startPromise: Promise<SessionResult> | null = null
  private startResult: SessionResult | undefined
  private stopRequest: TerminationRequest | undefined
  private exitSettlement: Promise<SessionRuntimeExit> | undefined
  private spawned = false
  private turn: ActiveTurn | undefined
  private appliedModelId: string | undefined
  private appliedModeId: string | undefined
  private appliedAt: string | undefined

  private readonly config: ClaudeProviderConfig
  private readonly host: Pick<HostDeps, 'log' | 'onSessionTitle'>
  private readonly permissions: PermissionBroker
  private readonly interactions: InteractionBroker
  private readonly timeouts: RuntimeTimeouts
  private readonly env: NodeJS.ProcessEnv
  private readonly translator: ClaudeMessageTranslator
  private readonly listeners = new Set<BackendEventListener>()
  private readonly exitListeners = new Set<(exit: SessionRuntimeExit) => void>()
  /** Parked `AskUserQuestion` calls, by requestId. Holds the original question
   * texts and option labels, which is the only way the composer's answers —
   * keyed by a synthetic `${requestId}:${index}` — can be translated back into
   * the `{[questionText]: string}` map the SDK looks answers up in. */
  private readonly questionContexts = new Map<string, PendingClaudeQuestions>()
  /** Parked plan reviews, by requestId. A set rather than a map because the
   * review needs no context to answer — but `respondPlan` must still be able to
   * refuse a requestId that belongs to a question, and vice versa. */
  private readonly planRequestIds = new Set<string>()
  /** Decisions already made for an `ExitPlanMode` tool call, by `toolUseID`.
   *
   * The SDK may invoke `canUseTool` more than once for the same tool call (a
   * retry after an API error re-runs the turn's tail). Asking the user to
   * review the same plan twice is at best confusing and at worst re-runs an
   * approved plan, so the first answer is reused. */
  private readonly planDecisions = new Map<string, PermissionResult>()

  constructor(
    private readonly spec: SessionRuntimeSpec,
    deps: ClaudeSessionRuntimeDeps,
  ) {
    this.providerId = spec.providerId
    this.cwd = spec.cwd
    this.threadIdValue = spec.threadId
    this.workspaceIdValue = spec.workspaceId
    this.config = deps.config
    this.host = deps.host
    this.permissions = deps.permissions
    this.interactions = deps.interactions
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
    this.sdk = deps.sdk
    this.env = deps.env ?? process.env
    this.translator = new ClaudeMessageTranslator({
      route: () => this.route(),
      log: this.host.log,
      ...(this.config.subtasks ? { subtasks: this.config.subtasks } : {}),
    })
    this.exited = new Promise<SessionRuntimeExit>((resolve) => {
      this.resolveExited = resolve
    })
  }

  get threadId(): ThreadId {
    return this.threadIdValue
  }
  get workspaceId(): string | undefined {
    return this.workspaceIdValue
  }
  get phase(): SessionRuntimePhase {
    return this.phaseValue
  }
  get sessionId(): string | undefined {
    return this.sessionIdValue
  }
  /** Always false. `listSessions` is a deliberate v1 omission for this
   * provider (see `providers/claude.ts`), not something a handshake could
   * turn on, so there is nothing for a process to advertise. */
  get listSessionsAdvertised(): boolean {
    return false
  }
  /** What this runtime last successfully wrote, never a guess.
   *
   * Undefined until something has actually been applied — a fabricated
   * "current" model would either make `applyDesiredConfig` skip a write the
   * session never received, or make the composer show a selection that was
   * never in force. */
  get applied(): AppliedSessionState | undefined {
    if (!this.appliedAt) return undefined
    const options = new Map<string, SessionConfigOption>()
    if (this.appliedModelId !== undefined)
      options.set('model', {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: this.appliedModelId,
        options: [],
      })
    if (this.appliedModeId !== undefined)
      options.set('mode', {
        type: 'select',
        id: 'mode',
        name: 'Permission mode',
        category: 'mode',
        currentValue: this.appliedModeId,
        options: [],
      })
    return {
      ...(this.appliedModelId !== undefined ? { modelConfigId: 'model' } : {}),
      ...(this.appliedModeId !== undefined ? { modeConfigId: 'mode' } : {}),
      options,
      refreshedAt: this.appliedAt,
      source: 'write_through',
    }
  }
  /** Claude Code resumes by session id alone; there is no per-notification
   * cursor to carry, so advertising one would invite a caller to persist a
   * value that means nothing. */
  get resumeCursor(): string | undefined {
    return undefined
  }
  get exit(): SessionRuntimeExit | undefined {
    return this.exitValue
  }

  rebindThread(threadId: ThreadId, workspaceId: string | undefined): void {
    const previous = this.threadIdValue
    this.threadIdValue = threadId
    if (workspaceId !== undefined) this.workspaceIdValue = workspaceId
    if (previous === threadId) return
    // Identical reasoning to the ACP runtime: requests parked on the app-wide
    // brokers carry the old thread id, and the `settleThread` this runtime
    // issues on exit would match none of them.
    this.permissions.rekeyThread(this.providerId, previous, threadId, this.workspaceIdValue)
    this.interactions.rekeyThread(this.providerId, previous, threadId, this.workspaceIdValue)
    // The runtime's own interaction stores — `questionContexts`,
    // `planRequestIds`, `planDecisions` — deliberately need no rekey: they are
    // keyed by requestId and toolUseID, both globally unique and both
    // thread-independent. Keying any of them by thread would have made a
    // rebind lose a parked question's option labels, which is the one thing
    // that cannot be reconstructed after the fact.
  }

  events(listener: BackendEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onExit(listener: (exit: SessionRuntimeExit) => void): () => void {
    if (this.exitValue) listener(this.exitValue)
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<SessionResult> {
    if (this.phaseValue === 'stopping' || this.phaseValue === 'exited')
      throw new Error(`Claude runtime for ${this.providerId} has stopped`)
    if (this.startPromise) return this.startPromise
    if (this.startResult) return { ...this.startResult, state: 'reused' }
    this.phaseValue = 'starting'
    const run = this.bootstrap().then(
      (result) => {
        this.startResult = result
        this.phaseValue = 'ready'
        this.startPromise = null
        return result
      },
      async (error: unknown) => {
        this.startPromise = null
        await this.stop({ reason: 'start_failed' })
        throw error
      },
    )
    this.startPromise = run
    return run
  }

  /** Start the process, prove it initialized, and only then say so.
   *
   * The ordering here is the whole point of this method. Everything that
   * announces the session — `process_spawned`, `initialized`, and the
   * `session_created` / `session_loaded` that carries the id — is emitted
   * *after* `initializationResult()` has resolved. Emitting on spawn instead
   * would be the natural translation of the ACP path, and it is wrong: the
   * desktop persists the id from `session_created` as the thread's durable
   * `externalId`, so a launch that fails at authentication or at a bad
   * `--model` flag would leave behind a resumable pointer to a transcript
   * Claude never wrote, and every later start would try to resume it. A
   * session that never existed must leave no trace. */
  private async bootstrap(): Promise<SessionResult> {
    const executable = resolveClaudeExecutable(this.config, this.env)
    this.sdk ??= await loadClaudeSdk()
    const resumeId = await this.resolvableSessionId()
    // A fresh transcript gets its id from us rather than from the CLI, so the
    // id is known before the process exists and is the same one the caller
    // will persist. `sessionId` and `resume` are mutually exclusive in the SDK
    // — passing both throws at option intake — which is why this is a branch
    // and not two spreads.
    const sessionId = resumeId ?? crypto.randomUUID()
    const desiredModel = this.spec.desiredConfig?.modelId
    const desiredMode = permissionMode(this.spec.desiredConfig?.modeId)
    const options: Options = {
      cwd: this.cwd,
      pathToClaudeCodeExecutable: executable,
      ...(resumeId ? { resume: resumeId } : { sessionId }),
      // The user's real settings, hooks and CLAUDE.md files. This is what
      // makes driving the CLI worth doing at all instead of calling the API,
      // and it is why hook frames have to be filtered out of session-id
      // capture below.
      settingSources: ['user', 'project', 'local'],
      // Token-level assistant text. Without it the first thing the UI sees is
      // a whole finished message.
      includePartialMessages: true,
      persistSession: true,
      // The initial selection travels as launch options rather than as two
      // control requests after the fact: the first turn can start before a
      // post-hoc `setModel` would have landed, and it would run on the wrong
      // model.
      ...(desiredModel ? { model: desiredModel } : {}),
      ...(desiredMode ? { permissionMode: desiredMode } : {}),
      // Every tool the CLI wants to run comes back through here — permission
      // prompts, but also the two tools that are really user interactions.
      canUseTool: (toolName, input, callbackOptions) =>
        this.canUseTool(toolName, input, callbackOptions),
      stderr: (data: string) =>
        this.host.log({ scope: 'claude', level: 'warn', message: '[stderr]', data }),
    }

    const input = new InputQueue()
    this.input = input
    const query = this.sdk.query({ prompt: input.stream(), options })
    this.query = query
    this.spawned = true
    // The pump starts before initialization is awaited: the SDK's message
    // stream is the only place a `worker_shutting_down` or an early crash
    // shows up, and a start that hangs waiting for `initializationResult()`
    // while the child is already dying is the failure mode the ACP runtime
    // races the child's exit to avoid.
    const pump = this.consume(query)

    const init = await withTimeout(
      Promise.race([
        query.initializationResult(),
        // A pump that ends before initialization means the process is gone.
        pump.then(() => {
          throw new Error(`${this.providerId} exited during startup`)
        }),
      ]),
      this.timeouts.initializeMs,
      () => new RpcTimeoutError(this.providerId, 'initialize', this.timeouts.initializeMs),
    )

    this.sessionIdValue = sessionId
    // Applied by the launch itself, so the memo starts warm and
    // `applyDesiredConfig` does not immediately re-send what is already set.
    if (desiredModel || desiredMode)
      this.noteApplied({
        ...(desiredModel ? { modelId: desiredModel } : {}),
        ...(desiredMode ? { modeId: desiredMode } : {}),
      })

    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'process_spawned', {
        cwd: this.cwd,
        command: executable,
        args: [],
      }),
    )
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'initialized', {
        agentInfo: { name: 'Claude Code' },
        capabilities: this.config.capabilities,
        promptCapabilities: CLAUDE_PROMPT_CAPABILITIES,
        // No auth step exists — the CLI owns the credentials and a successful
        // initialize *is* the proof. Reporting an empty list is the honest
        // answer, not a missing one.
        authMethods: [],
      }),
    )
    this.emit(
      routeEvent(
        this.route(),
        sessionId,
        'lifecycle',
        resumeId ? 'session_loaded' : 'session_created',
        {
          ...(this.applied ? { configOptions: [...this.applied.options.values()] } : {}),
        },
      ),
    )
    this.host.log({
      scope: 'claude',
      level: 'info',
      message: resumeId ? 'Resumed Claude Code session' : 'Created Claude Code session',
      data: { sessionId, commands: init.commands.length, models: init.models.length },
    })
    return { sessionId, state: resumeId ? 'loaded' : 'created' }
  }

  /** Classify a requested resume before committing to it.
   *
   * `getSessionInfo` reads the one transcript file rather than the whole
   * project, and returns undefined when it is not there. Distinguishing that
   * case matters: a genuinely-unknown session is safe to replace with a fresh
   * one (there was nothing to lose), while a resume that failed for any other
   * reason must not silently become a blank transcript wearing the old id —
   * that is how a conversation gets thrown away. */
  private async resolvableSessionId(): Promise<string | undefined> {
    const requested = this.spec.sessionId
    if (!requested || !this.config.capabilities.canLoadSession) return undefined
    const sdk = this.sdk
    if (!sdk) return undefined
    const info = await withTimeout(
      sdk.getSessionInfo(requested, { dir: this.cwd }),
      this.timeouts.controlRequestMs,
      () => new RpcTimeoutError(this.providerId, 'getSessionInfo', this.timeouts.controlRequestMs),
    )
    if (info) return requested
    this.host.log({
      scope: 'claude',
      level: 'warn',
      message: 'Stored Claude Code session is unknown to the CLI; creating a new session',
      data: { sessionId: requested, cwd: this.cwd },
    })
    return undefined
  }

  /** Drain the query for the runtime's whole life.
   *
   * Both outcomes are terminal and both funnel into `settleExit`: the stream
   * ending means the CLI closed its side, and the stream throwing means it
   * died. Neither is recoverable — there is no reconnect — so the runtime is
   * replaced rather than repaired. */
  private async consume(query: ClaudeQuerySession): Promise<void> {
    try {
      for await (const message of query) this.handle(message)
    } catch (error) {
      await this.settleExit(unobservedExit(), error)
      return
    }
    await this.settleExit(unobservedExit())
  }

  private handle(message: SDKMessage): void {
    this.noteSessionId(message)
    if (message.type === 'system' && message.subtype === 'worker_shutting_down') {
      // The CLI announcing its own shutdown. Acting on it here rather than
      // waiting for the stream to end means pending interactions are settled
      // while there is still somebody to tell.
      this.host.log({
        scope: 'claude',
        level: 'warn',
        message: 'Claude Code worker is shutting down',
        data: { reason: message.reason },
      })
      void this.settleExit(unobservedExit())
      return
    }
    const translated = this.translator.translate(message)
    for (const event of translated.events) this.emit(event)
    if (translated.completed) this.completeTurn(message, translated.completed)
  }

  /** Adopt the durable session id, ignoring the transient ones.
   *
   * Every frame carries a `session_id`, but hook frames carry the hook's own.
   * See `TRANSIENT_SESSION_ID_SUBTYPES`. A change on any other frame is
   * adopted and logged — the CLI reassigning an id (a forked resume, a
   * compaction boundary) is rare enough to be worth a line in the log and
   * dangerous enough that silently keeping the stale one would break resume. */
  private noteSessionId(message: SDKMessage): void {
    if (message.type === 'system' && TRANSIENT_SESSION_ID_SUBTYPES.has(message.subtype)) return
    const observed = (message as { session_id?: unknown }).session_id
    if (typeof observed !== 'string' || !observed) return
    if (this.sessionIdValue === observed) return
    if (this.sessionIdValue)
      this.host.log({
        scope: 'claude',
        level: 'warn',
        message: 'Claude Code reported a different session id',
        data: { from: this.sessionIdValue, to: observed, messageType: message.type },
      })
    this.sessionIdValue = observed
  }

  // ------------------------------------------------------------------- prompt

  async prompt(args: {
    prompt: PromptInput
    userMessageId?: string
    desiredConfig?: DesiredSessionConfig
  }): Promise<void> {
    const sessionId = await this.ready()
    if (this.turn)
      throw new Error(
        `${this.providerId} already has a turn in flight on thread ${this.threadIdValue}`,
      )
    const input = this.input
    if (!input) throw new Error(`Claude runtime unavailable for ${this.providerId}`)
    if (args.desiredConfig) await this.applyDesiredConfig(args.desiredConfig)
    // Converted BEFORE `prompt_started` is emitted and before a turn is opened.
    // An unsupported block throws here, which fails `prompt()` visibly; doing it
    // after would leave the UI showing a started turn that never runs.
    const content = claudePromptContent(args.prompt)
    const userMessageId = args.userMessageId ?? `agent_usr_${crypto.randomUUID()}`
    this.emit(
      routeEvent(this.route(), sessionId, 'lifecycle', 'prompt_started', {
        prompt: args.prompt.text,
        userMessageId,
        ...(args.prompt.attachments ? { attachments: args.prompt.attachments } : {}),
      }),
    )
    const turn = this.openTurn(sessionId)
    input.push({
      type: 'user',
      message: { role: 'user', content },
      // Null, always: this is the user talking to the top-level agent. A
      // non-null parent would make the CLI attribute the message to a subagent
      // loop, and every frame it produced would then be dropped as subagent
      // traffic by the translator.
      parent_tool_use_id: null,
      session_id: sessionId,
    } as SDKUserMessage)
    return turn.done.then(() => undefined)
  }

  /** Move `idle -> dispatched`. The returned promise is what `prompt()` hands
   * its caller, and only `completeTurn` (with a matching terminal result) or
   * an exit may settle it. */
  private openTurn(sessionId: string): ActiveTurn {
    let settle!: (error?: unknown) => void
    const done = new Promise<void>((resolve, reject) => {
      settle = (error?: unknown) => (error === undefined ? resolve() : reject(error))
    })
    // Nothing else awaits this promise until `prompt()` returns it, and an
    // exit can reject it first; without this the rejection is unhandled.
    done.catch(() => undefined)
    const turn: ActiveTurn = {
      id: crypto.randomUUID(),
      sessionId,
      state: 'dispatched',
      settle,
      done,
    }
    this.turn = turn
    return turn
  }

  /** `dispatched -> completing -> idle`, for a result that is genuinely ours.
   *
   * Two things disqualify a result. A `parent_tool_use_id` means it terminated
   * a subagent's inner loop, not the user's turn — settling on one would end
   * `prompt()` while the main turn is still streaming. And a result arriving
   * with no active turn at all is a late frame from a cancelled or already
   * settled turn; v1 logs and drops it rather than guessing which turn it
   * belonged to, because guessing wrong resolves somebody else's prompt. */
  private completeTurn(
    message: SDKMessage,
    completed: NonNullable<TranslatedMessage['completed']>,
  ): void {
    // Live-verified (claude 2.1.220): a top-level `result` carries no
    // `parent_tool_use_id` key at all, so this guard is defensive rather than
    // load-bearing — but a subagent result that ever grows one must not end
    // the user's turn, and the check costs nothing.
    const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id
    if (typeof parent === 'string' && parent) return
    const turn = this.turn
    if (!turn || turn.state !== 'dispatched') {
      this.host.log({
        scope: 'claude',
        level: 'warn',
        message: 'Claude Code result arrived with no turn awaiting it',
        data: { sessionId: completed.sessionId, turnId: turn?.id, turnState: turn?.state },
      })
      return
    }
    turn.state = 'completing'
    this.turn = undefined
    // Emitted here rather than by the translator: only a result the state
    // machine accepted means the *user's* turn is over.
    this.emit(
      routeEvent(this.route(), completed.sessionId, 'lifecycle', 'prompt_completed', {
        ...(completed.stopReason ? { stopReason: completed.stopReason } : {}),
        // `TokenUsage` — what this turn cost. NOT `usage_update`, which is
        // `SessionUsage` and answers a different question entirely.
        ...(completed.usage ? { usage: completed.usage } : {}),
      }),
    )
    turn.settle()
    // Deliberately not awaited. A control request that hangs or is not
    // implemented by an older CLI must not delay the turn's settlement, and a
    // missing context meter is a cosmetic loss next to a wedged prompt queue.
    void this.publishContextUsage(completed.sessionId)
  }

  /** `usage_update` — how full the context window is, straight from the only
   * thing that knows.
   *
   * `getContextUsage()` is the ONLY correct source for this event. The stream's
   * token counts (`message_delta.usage`, `result.usage`) are per-turn totals
   * with no window size attached, so deriving occupancy from them means
   * inventing the denominator. Polled once per completed turn rather than
   * streamed, because the number only meaningfully changes when a turn ends. */
  private async publishContextUsage(sessionId: string): Promise<void> {
    const query = this.query
    if (!query) return
    try {
      const usage = await withTimeout(
        query.getContextUsage(),
        this.timeouts.controlRequestMs,
        () =>
          new RpcTimeoutError(this.providerId, 'getContextUsage', this.timeouts.controlRequestMs),
      )
      // Both halves or nothing: a meter with a zero denominator renders as
      // either 0% or NaN%, and both are worse than no meter.
      if (!usage || !usage.maxTokens) return
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'usage_update', {
          used: usage.totalTokens,
          size: usage.maxTokens,
        }),
      )
    } catch (error) {
      this.host.log({
        scope: 'claude',
        level: 'warn',
        message: 'Could not read Claude Code context usage',
        data: { error: errorMessage(error) },
      })
    }
  }

  /** Reject whatever turn is in flight. Used by every terminal path; a turn
   * left pending outlives its process and wedges `AgentRuntime.promptQueues`,
   * which is the failure this runtime exists to make impossible. */
  private failActiveTurn(error: unknown): void {
    const turn = this.turn
    if (!turn) return
    this.turn = undefined
    this.host.log({
      scope: 'claude',
      level: 'warn',
      message: 'Failing a Claude Code turn that will never complete',
      data: { turnId: turn.id, sessionId: turn.sessionId, error: errorMessage(error) },
    })
    turn.settle(error instanceof Error ? error : new Error(errorMessage(error)))
  }

  /** Interrupt, then verify.
   *
   * `interrupt()` resolving only means the CLI received the request; the turn
   * ends with its own `result` message, separately and possibly never. The
   * watchdog is what turns "possibly never" into a bounded failure: if
   * neither a terminal result nor an exit lands inside the grace, the process
   * is no longer trustworthy and is replaced. */
  async cancel(): Promise<void> {
    const sessionId = await this.ready()
    this.permissions.cancelThread(this.providerId, this.threadIdValue)
    this.interactions.cancelThread(this.providerId, this.threadIdValue)
    const query = this.query
    const turn = this.turn
    if (!query) return
    try {
      await withTimeout(
        query.interrupt(),
        this.timeouts.controlRequestMs,
        () => new RpcTimeoutError(this.providerId, 'interrupt', this.timeouts.controlRequestMs),
      )
    } catch (error) {
      this.emit(
        routeEvent(this.route(), sessionId, 'error', 'rpc_error', {
          source: 'interrupt',
          message: errorMessage(error),
        }),
      )
      throw error instanceof Error ? error : new Error(errorMessage(error))
    }
    if (!turn) return
    const outcome = await Promise.race([
      turn.done.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      this.exited.then(() => 'exited' as const),
      sleep(this.timeouts.interruptGraceMs).then(() => 'wedged' as const),
    ])
    if (outcome !== 'wedged') return
    this.host.log({
      scope: 'claude',
      level: 'error',
      message: 'Claude Code did not end the interrupted turn; replacing the runtime',
      data: { sessionId, graceMs: this.timeouts.interruptGraceMs },
    })
    await this.stop({ reason: 'restart' })
  }

  // ------------------------------------------------------------------- config

  async setModel(modelId: string): Promise<void> {
    const sessionId = await this.ready()
    await this.queryOrThrow().setModel(modelId)
    // Only after the control request resolves: emitting first would show the
    // composer a selection the session may have refused.
    this.noteApplied({ modelId })
    this.emit(
      routeEvent(this.route(), sessionId, 'session', 'current_model_update', {
        currentModelId: modelId,
      }),
    )
  }

  async setMode(modeId: string): Promise<void> {
    const sessionId = await this.ready()
    const mode = permissionMode(modeId)
    if (!mode) throw new Error(`${this.providerId} has no permission mode "${modeId}"`)
    await this.queryOrThrow().setPermissionMode(mode)
    this.noteApplied({ modeId: mode })
    this.emit(
      routeEvent(this.route(), sessionId, 'session', 'current_mode_update', {
        currentModeId: mode,
      }),
    )
  }

  setConfigOption(configId: string, _value: string | boolean): Promise<void> {
    return Promise.reject(
      new CapabilityMissingError(
        this.providerId,
        'canSetConfigOption',
        `setting the "${configId}" config option`,
      ),
    )
  }

  /** Model then mode, skipping what is already applied.
   *
   * There is deliberately no `AppliedConfigCache` here. That cache exists to
   * reconcile against state an agent *reported*, and Claude Code reports none:
   * `setModel`/`setPermissionMode` resolve with nothing. Memoising our own
   * writes is the strongest claim available, so that is exactly what this
   * makes — and why `applied.source` says `write_through` rather than
   * borrowing one of the wire-confirmed sources. */
  async applyDesiredConfig(desired: DesiredSessionConfig): Promise<void> {
    await this.ready()
    if (desired.modelId !== undefined && desired.modelId !== this.appliedModelId)
      await this.setModel(desired.modelId)
    const mode = permissionMode(desired.modeId)
    if (mode !== undefined && mode !== this.appliedModeId) await this.setMode(mode)
    // `desired.values` is silently ignored: this provider advertises
    // `canSetConfigOption: false`, so nothing upstream should be sending any,
    // and throwing on a leftover remembered preference would break a prompt
    // over a setting that cannot apply either way.
  }

  private noteApplied(applied: { modelId?: string; modeId?: string }): void {
    if (applied.modelId !== undefined) this.appliedModelId = applied.modelId
    if (applied.modeId !== undefined) this.appliedModeId = applied.modeId
    this.appliedAt = new Date().toISOString()
  }

  listSessions(): Promise<ProviderSessionInfo[]> {
    return Promise.reject(
      new CapabilityMissingError(this.providerId, 'canListSessions', 'listing sessions'),
    )
  }

  // ------------------------------------------------------------------ replies

  respondPermission(requestId: string, outcome: PermissionOutcome): boolean {
    return this.permissions.respond(requestId, outcome)
  }
  /** There is no extension channel to respond on — the SDK is an in-process
   * API with no provider-specific method surface. Returning false is the
   * contract's "nobody was waiting for this". */
  respondExtension(_requestId: string, _response: unknown): boolean {
    return false
  }
  /** The wire response handed to the broker is the `QuestionOutcome` itself:
   * unlike ACP, there is no provider-native payload to build here, because the
   * answer is turned into Claude's `{questions, answers}` shape by the parked
   * `canUseTool` callback — which is the only place the original question texts
   * and option labels are still available. The guard matters: request ids are
   * globally unique across kinds, and answering a plan review as if it were a
   * question would settle it with a payload the plan branch cannot read. */
  respondQuestion(requestId: string, outcome: QuestionOutcome): boolean {
    if (!this.questionContexts.has(requestId)) return false
    return this.interactions.respond(requestId, outcome, { kind: 'question', outcome })
  }
  respondPlan(requestId: string, outcome: PlanReviewOutcome): boolean {
    if (!this.planRequestIds.has(requestId)) return false
    return this.interactions.respond(requestId, outcome, { kind: 'plan_review', outcome })
  }

  // -------------------------------------------------------------- canUseTool

  /** Everything the CLI wants to run, in a precedence that is load-bearing.
   *
   * The order is the whole design. `AskUserQuestion` and `ExitPlanMode` are not
   * permission prompts — they are the model asking the user something and the
   * model proposing a plan — and they arrive through the same callback only
   * because that is the SDK's one hook for "before this tool runs". Putting the
   * full-access short circuit ahead of them would silently answer every
   * question and approve every plan the moment a user picks `bypassPermissions`
   * or `dontAsk`, which are statements about *permission*, not about whether
   * the user wants to be talked to.
   *
   * Returning `null` is never correct here: the SDK reads it as "the host
   * already answered out of band" and, if we have not, the tool stays blocked
   * with no deadline. Every path below returns an explicit allow or deny. */
  private async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    const sessionId = this.sessionIdValue
    if (!sessionId)
      return { behavior: 'deny', message: `${this.providerId} has no session for this tool call` }
    try {
      if (toolName === 'AskUserQuestion') {
        const answered = await this.askUserQuestion(sessionId, input, options)
        // Undefined only when the input was not a recognisable question set, in
        // which case it falls through and is treated as an ordinary tool.
        if (answered) return answered
      }
      if (toolName === 'ExitPlanMode') return await this.reviewPlan(sessionId, input, options)
      if (FULL_ACCESS_MODES.includes(this.appliedModeId as PermissionMode))
        return { behavior: 'allow' }
      return await this.requestPermission(sessionId, toolName, input, options)
    } catch (error) {
      // A throw out of this callback is swallowed by the SDK and leaves the
      // tool parked forever. Denying is the only safe failure.
      this.host.log({
        scope: 'claude',
        level: 'error',
        message: 'Claude Code permission routing failed',
        data: { toolName, error: errorMessage(error) },
      })
      return { behavior: 'deny', message: `Permission routing failed: ${errorMessage(error)}` }
    }
  }

  /** The model asking the user a multiple-choice question.
   *
   * The response REPLACES the tool input rather than extending it — `{questions,
   * answers}`, not a spread — because that is the shape `AskUserQuestionOutput`
   * describes, and `answers` is keyed by the FULL ORIGINAL QUESTION TEXT: the
   * SDK looks each answer up by the question string it sent. */
  private async askUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult | undefined> {
    const requestId = crypto.randomUUID()
    const parsed = parseAskUserQuestion(requestId, input)
    if (!parsed) return undefined
    if (parsed.pending.duplicateTexts.length > 0)
      // Not survivable in the SDK's shape: `answers` is one string per question
      // text, so two questions sharing a text share a key. The answers are
      // merged rather than one silently overwriting the other.
      this.host.log({
        scope: 'claude',
        level: 'warn',
        message: 'AskUserQuestion repeated a question text; answers will be merged',
        data: { texts: parsed.pending.duplicateTexts },
      })
    this.questionContexts.set(requestId, parsed.pending)
    // Registered before the request reaches any listener: a fast local renderer
    // can otherwise answer before `respondQuestion` has anything to settle.
    const settlement = this.awaitInteraction(requestId, sessionId, 'question', options.signal)
    this.emit(
      routeEvent(this.route(), sessionId, 'session', 'question_request', {
        requestId,
        sessionId,
        ...(parsed.title ? { title: parsed.title } : {}),
        questions: parsed.questions,
      }),
    )
    const outcome = await settlement
    if (outcome.outcome !== 'responded') return USER_CANCELLED
    const answer = outcome.response as QuestionOutcome
    if (answer.outcome !== 'answered') return USER_CANCELLED
    return {
      behavior: 'allow',
      updatedInput: {
        questions: input.questions,
        answers: claudeQuestionAnswers(parsed.pending, answer),
      },
    }
  }

  /** The model proposing a plan and waiting to be released into implementation.
   *
   * `continuation: 'same_turn'` is the field that makes this correct: approval
   * releases THIS turn to carry on, so the host must not dispatch a follow-up
   * prompt. Without it `build_plan` sends a second turn and the entire plan runs
   * twice — every edit, every command, duplicated. */
  private async reviewPlan(
    sessionId: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    const memo = this.planDecisions.get(options.toolUseID)
    if (memo) return memo
    const requestId = crypto.randomUUID()
    this.planRequestIds.add(requestId)
    const settlement = this.awaitInteraction(
      requestId,
      sessionId,
      'plan_review',
      options.signal,
      // A plan is read, not clicked through; the default interaction timeout is
      // far too short for one.
      PLAN_REVIEW_TIMEOUT_MS,
    )
    this.emit(
      routeEvent(this.route(), sessionId, 'session', 'plan_review_request', {
        ...planFromExitPlanMode(input),
        requestId,
        sessionId,
      }),
    )
    const outcome = await settlement
    const review = outcome.outcome === 'responded' ? (outcome.response as PlanReviewOutcome) : undefined
    const result: PermissionResult =
      review?.outcome === 'accepted'
        ? // No `updatedInput`: the plan is unchanged and the SDK treats an
          // omitted `updatedInput` as "use what I sent".
          { behavior: 'allow' }
        : review?.outcome === 'rejected'
          ? { behavior: 'deny', message: review.reason ?? 'User rejected the plan.' }
          : USER_CANCELLED
    this.planDecisions.set(options.toolUseID, result)
    return result
  }

  /** Everything else: an ordinary permission prompt.
   *
   * The prompt text comes from the SDK's own `title` ("Claude wants to read
   * foo.txt"), which the bridge renders with the same wording the CLI uses.
   * Reconstructing a sentence from `toolName` + `input` would drift from it and
   * would be wrong for MCP tools we know nothing about. `displayName` is the
   * compact noun phrase and becomes the row's label. */
  private async requestPermission(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ): Promise<PermissionResult> {
    const requestId = crypto.randomUUID()
    const permissionOptions: PermissionOption[] = [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ]
    const response = new Promise<PermissionProtocolResponse>((resolve) =>
      this.permissions.add(requestId, {
        providerId: this.providerId,
        threadId: this.threadIdValue,
        workspaceId: this.workspaceIdValue,
        sessionId,
        options: permissionOptions,
        resolve,
      }),
    )
    const abort = () => this.permissions.respond(requestId, { outcome: 'cancelled', reason: 'tool_cancelled' })
    const detach = this.onAbort(options.signal, abort)
    this.emit(
      routeEvent(this.route(), sessionId, 'permission', 'permission_request', {
        requestId,
        sessionId,
        toolCall: {
          toolCallId: options.toolUseID,
          // The compact label. `convex-projector.upsertPermission` reads this as
          // the tool name for the prompt's heading.
          title: options.displayName ?? toolName,
          kind: claudeToolKind(toolName),
          rawInput: input,
        },
        options: permissionOptions,
        expiresAt: new Date(Date.now() + PERMISSION_TIMEOUT_MS).toISOString(),
        metadata: {
          toolName,
          // Read as the prompt's description downstream, which is exactly what
          // the SDK says this field is for.
          ...(options.title ? { title: options.title } : {}),
          ...(options.description ? { description: options.description } : {}),
          ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
          ...(options.blockedPath ? { filepath: options.blockedPath } : {}),
        },
      }),
    )
    const outcome = await response.finally(detach)
    if (outcome.outcome.outcome !== 'selected') return USER_CANCELLED
    if (outcome.outcome.optionId === 'reject_once')
      return { behavior: 'deny', message: 'User denied permission for this tool call.' }
    // `updatedInput` is deliberately omitted: the input is unchanged, and the
    // SDK's allow arm treats an absent one as "run what you asked to run".
    // `updatedPermissions` carries ONLY what the SDK itself suggested, and only
    // for "always" — synthesizing a rule would write a permission the CLI never
    // proposed into the user's settings.
    if (outcome.outcome.optionId === 'allow_always' && options.suggestions?.length)
      return { behavior: 'allow', updatedPermissions: [...options.suggestions] }
    return { behavior: 'allow' }
  }

  /** Park an interaction on the app-wide broker until the UI answers it, with
   * the callback's abort as a second way out.
   *
   * There is exactly ONE settlement point — the broker's record, which is
   * deleted before its `resolve` runs — so an abort arriving at the same
   * instant as the user's answer produces one outcome, not two, and the loser
   * simply reports `false`. */
  private awaitInteraction(
    requestId: string,
    sessionId: string,
    kind: InteractionKind,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<InteractionOutcome> {
    const settlement = new Promise<InteractionOutcome>((resolve) =>
      this.interactions.add(
        requestId,
        {
          kind,
          providerId: this.providerId,
          threadId: this.threadIdValue,
          workspaceId: this.workspaceIdValue,
          sessionId,
          resolve,
        },
        timeoutMs,
      ),
    )
    const detach = this.onAbort(signal, () => this.interactions.cancel(requestId))
    return settlement.finally(() => {
      detach()
      this.questionContexts.delete(requestId)
      this.planRequestIds.delete(requestId)
    })
  }

  /** Subscribe to an abort that may already have happened. Returns the detach,
   * so a settled interaction stops holding a listener on a signal the SDK keeps
   * alive for the rest of the turn. */
  private onAbort(signal: AbortSignal, onAbort: () => void): () => void {
    if (signal.aborted) {
      onAbort()
      return () => undefined
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }

  // ------------------------------------------------------------------- teardown

  async stop(request: TerminationRequest): Promise<SessionRuntimeExit> {
    if (this.exitValue) return this.exitValue
    // First reason wins. Teardown is racy by nature — the reaper and a
    // shutdown can both fire on the same tick — and the exit's `reason` is
    // read as the *cause* of the death. Letting the second caller overwrite
    // it would attribute a reaped runtime to whatever ran last.
    this.stopRequest ??= request
    this.phaseValue = 'stopping'
    return this.settleExit(unobservedExit())
  }

  dispose(): void {
    void this.stop({ reason: 'disposed' }).catch(() => undefined)
  }

  /** The one exit path. Idempotent by memoisation, so the output pump ending,
   * the output pump throwing, a start failure, a requested `stop()` and a
   * `worker_shutting_down` frame all converge on a single settlement that
   * fires `onExit` exactly once.
   *
   * That "exactly once" is load-bearing beyond tidiness:
   * `SessionRuntimeRegistryImpl` removes its entry only from `onExit`, so a
   * settlement that resolves before the child is really gone drops the
   * registry's handle on a live Claude process and the next start spawns a
   * second one against the same transcript. */
  private settleExit(exit: ProcessExit, cause?: unknown): Promise<SessionRuntimeExit> {
    this.exitSettlement ??= this.performExit(exit, cause)
    return this.exitSettlement
  }

  private async performExit(exit: ProcessExit, cause: unknown): Promise<SessionRuntimeExit> {
    const expected = this.stopRequest !== undefined
    this.phaseValue = 'exited'
    this.failActiveTurn(cause ?? new Error(`${this.providerId} exited before the turn completed`))
    this.permissions.settleThread(this.providerId, this.threadIdValue)
    this.interactions.settleThread(this.providerId, this.threadIdValue)
    this.input?.close()
    const query = this.query
    this.query = undefined
    if (query) {
      // `close()` is synchronous and fire-and-forget — it starts the SDK's
      // cleanup and returns. `return()` awaits the same memoised cleanup,
      // which ends with the SDK's own bounded wait on the child's exit. That
      // bound is the SDK's, not ours, and it is why the registry's "an entry
      // never outlives its process" invariant is best-effort here rather than
      // guaranteed; see the commit notes.
      try {
        query.close()
      } catch (error) {
        this.host.log({
          scope: 'claude',
          level: 'warn',
          message: 'Closing the Claude Code query threw',
          data: { error: errorMessage(error) },
        })
      }
      await query.return(undefined).catch(() => undefined)
    }
    if (this.spawned)
      this.emit(
        routeEvent(this.route(), this.sessionIdValue, 'lifecycle', 'process_exited', {
          exitCode: exit.exitCode,
          ...(exit.signal ? { signal: exit.signal } : {}),
          expected,
        }),
      )
    const runtimeExit: SessionRuntimeExit = {
      ...exit,
      expected,
      ...(this.stopRequest ? { reason: this.stopRequest.reason } : {}),
    }
    this.exitValue = runtimeExit
    this.resolveExited(runtimeExit)
    for (const listener of this.exitListeners) listener(runtimeExit)
    return runtimeExit
  }

  // ------------------------------------------------------------------ helpers

  private route(): BackendRoute {
    return { threadId: this.threadIdValue, workspaceId: this.workspaceIdValue }
  }
  private emit(event: BackendEvent): void {
    for (const listener of this.listeners) listener(event)
  }
  private queryOrThrow(): ClaudeQuerySession {
    if (!this.query) throw new Error(`Claude runtime unavailable for ${this.providerId}`)
    return this.query
  }
  private async ready(): Promise<string> {
    if (this.sessionIdValue && this.startResult) return this.sessionIdValue
    const result = await this.start()
    return result.sessionId
  }
}

/** A process death we did not observe.
 *
 * The SDK gives no exit code and no signal — `close()` returns void and the
 * child's status is never surfaced — so every field here is genuinely unknown
 * and reported as unknown. Inventing `exitCode: 0` would make every Claude
 * exit look clean, including the crashes.
 *
 * `forced` is false because we never escalate to SIGKILL ourselves; the SDK
 * owns the kill. */
function unobservedExit(): ProcessExit {
  return { exitCode: null, signal: null, forced: false, at: new Date().toISOString() }
}

function permissionMode(modeId: string | undefined): PermissionMode | undefined {
  if (!modeId) return undefined
  return PERMISSION_MODES.find((mode) => mode === modeId)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** The runtime's input side: one stream, open for the runtime's whole life.
 *
 * `query()` takes the prompt as an `AsyncIterable`, and the CLI ends the
 * session when that iterable completes. Yielding one message and returning
 * would therefore give one turn per subprocess — a ~10s spawn and a full
 * context reload before every message. Keeping the generator parked on an
 * unresolved promise between turns is what lets every turn on a thread ride
 * the same query and the same warm process. */
class InputQueue {
  private readonly buffered: SDKUserMessage[] = []
  private waiting: ((message: SDKUserMessage | undefined) => void) | undefined
  private closed = false

  push(message: SDKUserMessage): void {
    if (this.closed) return
    const waiting = this.waiting
    if (waiting) {
      this.waiting = undefined
      waiting(message)
      return
    }
    this.buffered.push(message)
  }

  /** Ends the stream, which is how the CLI is told there is no more input.
   * Only `settleExit` calls it, so the stream closing and the runtime exiting
   * are the same event. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const waiting = this.waiting
    this.waiting = undefined
    waiting?.(undefined)
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const buffered = this.buffered.shift()
      if (buffered) {
        yield buffered
        continue
      }
      if (this.closed) return
      const next = await new Promise<SDKUserMessage | undefined>((resolve) => {
        this.waiting = resolve
      })
      if (next === undefined) return
      yield next
    }
  }
}
