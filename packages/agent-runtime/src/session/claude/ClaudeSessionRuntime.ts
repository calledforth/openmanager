import type {
  CanUseTool,
  EffortLevel,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ModelListing,
  ModelOption,
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
import {
  CLAUDE_CONFIG,
  CLAUDE_DEFAULT_MODE,
  CLAUDE_DEFAULT_MODEL_ID,
  claudeConfigOptions,
  claudeModeListing,
  claudeModelCatalog,
  claudePermissionMode,
} from './claude-catalog.js'
import { claudePromptContent, CLAUDE_PROMPT_CAPABILITIES } from './claude-prompt.js'
import { claudeToolKind } from './claude-tools.js'
import { resolveClaudeExecutable } from './executable.js'
import {
  loadClaudeSdk,
  type ClaudeFlagSettings,
  type ClaudeQuerySession,
  type ClaudeSdk,
} from './sdk.js'

/** The callback's third argument, named once so the routing methods below can
 * take it without re-declaring the SDK's inline option bag. */
type CanUseToolOptions = Parameters<CanUseTool>[2]

/** What a `dontAsk` denial tells Claude Code.
 *
 * `dontAsk` is NOT a quieter `bypassPermissions`, which is how it was first
 * read here. The SDK defines it as "don't prompt for permissions, deny if not
 * pre-approved" — the most restrictive of the no-prompt modes, not the most
 * permissive. Anything the user's rules already allow is resolved by the CLI
 * and never reaches `canUseTool` at all (a refusal arrives as a
 * `permission_denied` system frame instead), so a call that DOES reach the
 * callback under this mode is by definition not pre-approved, and the mode's
 * answer is no. Grouping it with `bypassPermissions` in the auto-allow branch
 * inverted it completely: the user asked to be protected without being
 * interrupted and got allow-all instead. */
const NOT_PRE_APPROVED: PermissionResult = {
  behavior: 'deny',
  message: 'Not pre-approved, and this session is in "dontAsk" mode.',
}

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
  /** This turn's identity AND the `uuid` stamped on the `SDKUserMessage` that
   * opened it — deliberately the same value, because they name the same thing.
   * A `result` comes back carrying `user_message_uuid`, and comparing it to
   * this is the only way to know a result belongs to *this* dispatch rather
   * than to a turn that has already been settled or cancelled. */
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
  /** The model catalog this session's own CLI reported at `initialize`.
   *
   * Kept because every `ModelListing` this runtime emits has to carry the
   * whole catalog, not just the current id: both the chrome reducer and the
   * renderer *replace* their listing from the event rather than merging into
   * it, so a `current_model_update` carrying only `currentModelId` empties the
   * picker. Read off this session's process rather than the probe's, so a
   * catalog that differs between them (a different account, a CLI upgraded
   * mid-run) is the one the session will actually accept. */
  private modelCatalogValue: ModelOption[] = []
  /** Output styles this CLI has installed. Read from the handshake because the
   * set is user-extensible — `~/.claude/output-styles/` — so a hard-coded list
   * would miss the ones that matter most. Also the only defence available:
   * `applyFlagSettings` does NOT validate `outputStyle`, and a typo becomes
   * the session's current style. */
  private outputStylesValue: string[] = []
  private appliedEffort: string | undefined
  private appliedFastMode = false
  private appliedOutputStyle: string | undefined
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
    // Everything past model and mode. Gated on the selected model inside
    // `claudeConfigOptions`, so a model with no effort levels contributes no
    // effort row rather than an empty one.
    for (const option of this.settingConfigOptions()) options.set(option.id, option)
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
        this.startPromise = null
        // A `stop()`, a crash or a `worker_shutting_down` can settle while
        // `bootstrap()` is still awaiting `initializationResult()`. Flipping to
        // 'ready' here would resurrect a runtime whose input queue is already
        // closed and whose query is already gone: the registry dropped its
        // entry on `onExit` and will never reap it again, and the next prompt
        // would park on a turn nothing can settle. A start that lost the race
        // against its own exit failed, however well the handshake went.
        if (this.exitSettlement) {
          this.abandonQuery()
          throw new Error(`${this.providerId} exited during startup`)
        }
        this.startResult = result
        this.phaseValue = 'ready'
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
    const desiredMode = claudePermissionMode(this.spec.desiredConfig?.modeId)
    const desiredValues = this.spec.desiredConfig?.values ?? {}
    const rawEffort = desiredValues[CLAUDE_CONFIG.effort]
    const desiredEffort = typeof rawEffort === 'string' ? (rawEffort as EffortLevel) : undefined
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
      // Effort is the one setting with a launch option, so it travels with the
      // rest of the selection instead of as a write after `initialize` — the
      // first turn would otherwise run at the CLI's default depth. It is not
      // validated against the model here because the catalog is not known
      // until the handshake answers; an effort the model ignores is harmless,
      // an unvalidated *mode* is not.
      ...(desiredEffort ? { effort: desiredEffort } : {}),
      // The SDK requires this alongside `permissionMode: 'bypassPermissions'`
      // — its own words: "a safety measure to ensure intentional bypassing of
      // permissions" — and rejects the mode without it. It is set here rather
      // than only when the launch mode happens to be bypass, because
      // `setPermissionMode('bypassPermissions')` mid-session has to work too
      // and there is no second chance to pass a launch option; a session that
      // accepted the mode only when it started in it would fail a switch the
      // composer openly offers. What this flag grants is narrow: it does not
      // change any other mode's behaviour and it never bypasses anything on
      // its own. It says only that if the user selects bypass — which is an
      // explicit, deliberate choice in our UI, exactly the intent the flag
      // exists to confirm — the CLI should honour it rather than refuse.
      // Removing `bypassPermissions` from `PERMISSION_MODES` is the
      // alternative, and it would mean advertising one fewer mode than the CLI
      // actually has.
      allowDangerouslySkipPermissions: true,
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
    this.modelCatalogValue = claudeModelCatalog(init.models)
    this.outputStylesValue = [...(init.available_output_styles ?? [])]
    this.appliedOutputStyle = init.output_style
    // Applied by the launch itself, so the memo starts warm and
    // `applyDesiredConfig` does not immediately re-send what is already set.
    if (desiredModel || desiredMode)
      this.noteApplied({
        ...(desiredModel ? { modelId: desiredModel } : {}),
        ...(desiredMode ? { modeId: desiredMode } : {}),
      })
    // After `noteApplied`, so the model is known and can gate what applies.
    await this.applyLaunchSettings(desiredValues)

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
          configOptions: [
            ...(this.applied
              ? [...this.applied.options.values()]
              : this.settingConfigOptions()),
          ],
          // Both catalogs, with whatever the launch actually applied as the
          // current selection. Without this the composer has no anchor for a
          // live Claude session: it falls back to the first row of whatever
          // list it can find, which is the CLI's own "Default (recommended)" —
          // so a session launched on Opus reads as Default, and the next
          // prompt is sent with that mislabelled selection.
          models: this.modelListing(),
          modes: claudeModeListing(this.appliedModeId ?? CLAUDE_DEFAULT_MODE, this.currentModel()),
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

  /** Tear down a process the exit path could not have seen.
   *
   * `settleExit` is memoised, so an exit that settled while `bootstrap` was in
   * flight ran its cleanup against a runtime that had no query yet — and
   * `bootstrap` then went on to spawn one. Nothing will ever come back to it:
   * the registry dropped its entry on `onExit` and the reaper only sweeps
   * registered runtimes. This is the one chance to close it. */
  private abandonQuery(): void {
    const query = this.query
    this.query = undefined
    this.input?.close()
    this.input = undefined
    if (!query) return
    this.host.log({
      scope: 'claude',
      level: 'warn',
      message: 'Closing a Claude Code process that finished starting after its runtime exited',
      data: { sessionId: this.sessionIdValue },
    })
    try {
      query.close()
    } catch {
      // Best effort by definition — there is nobody left to report this to.
    }
    void query.return(undefined).catch(() => undefined)
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
    // Ownership is decided BEFORE the translator sees the frame, not after.
    // `result` is the one message type with turn-scoped side effects —
    // `settleTurnUsage` zeroes the accumulated token counters and the
    // dropped-subagent tally on its way past — so a result we are going to
    // discard must not take the next turn's books with it. Translating first
    // and deciding second meant a stray result corrupted a turn it had no
    // business touching even when it was correctly refused.
    if (message.type === 'result' && !this.ownsResult(message)) return
    const translated = this.translator.translate(message)
    for (const event of translated.events) this.emit(event)
    if (translated.completed) this.completeTurn(translated.completed)
  }

  /** Is this terminal result the one the active dispatch is waiting for?
   *
   * Three things disqualify it.
   *
   * A `parent_tool_use_id` means it terminated a subagent's inner loop rather
   * than the user's turn; settling on one would end `prompt()` while the main
   * turn is still streaming. (Live-verified on claude 2.1.220 that a top-level
   * result carries no such key, so this is defensive — but a subagent result
   * that ever grows one must not end the user's turn.)
   *
   * No active dispatch at all means a late frame from a turn that was
   * cancelled or already settled. Guessing which turn it belonged to resolves
   * somebody else's prompt, so it is logged and dropped.
   *
   * And a `user_message_uuid` that names a different dispatch is a late or
   * duplicated result for a turn that is gone. Note the asymmetry in the SDK:
   * `user_message_uuid` is declared only on `SDKResultSuccess`, NOT on
   * `SDKResultError`, and it is optional even there. So this is a one-way
   * check — a mismatch is proof the result is not ours, but its absence proves
   * nothing and falls back to the active-dispatch test above, which is the
   * strongest guard available for a failed turn. */
  private ownsResult(message: Extract<SDKMessage, { type: 'result' }>): boolean {
    const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id
    if (typeof parent === 'string' && parent) return false
    const turn = this.turn
    if (!turn || turn.state !== 'dispatched') {
      this.host.log({
        scope: 'claude',
        level: 'warn',
        message: 'Claude Code result arrived with no turn awaiting it',
        data: { sessionId: message.session_id, turnId: turn?.id, turnState: turn?.state },
      })
      return false
    }
    const correlation = (message as { user_message_uuid?: unknown }).user_message_uuid
    if (typeof correlation === 'string' && correlation && correlation !== turn.id) {
      this.host.log({
        scope: 'claude',
        level: 'warn',
        message: 'Claude Code result named a different user message; ignoring it',
        data: { sessionId: message.session_id, turnId: turn.id, resultFor: correlation },
      })
      return false
    }
    return true
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
    if (args.desiredConfig) await this.applyDesiredConfig(args.desiredConfig)
    // Converted BEFORE `prompt_started` is emitted and before a turn is opened.
    // An unsupported block throws here, which fails `prompt()` visibly; doing it
    // after would leave the UI showing a started turn that never runs.
    const content = claudePromptContent(args.prompt)
    const userMessageId = args.userMessageId ?? `agent_usr_${crypto.randomUUID()}`
    // Re-checked HERE, after the last await and immediately before a turn
    // exists. `ready()` proved the runtime was alive when it answered, but
    // every await since — `applyDesiredConfig`'s two control requests above,
    // and `ready()`'s own — is a window in which the process can die. What
    // makes the window lethal rather than merely unlucky is the order inside
    // `performExit`: it closes the input queue and then fails the active turn,
    // so an exit that lands while there is no turn yet leaves nothing behind to
    // fail. A turn opened afterwards would push into a closed queue, be
    // dropped, and never settle — wedging this thread's entry in
    // `AgentRuntime.promptQueues` for the life of the app, with `SessionReaper`
    // declining to rescue it because a thread with an active turn looks busy.
    const input = this.usableInput()
    this.emit(
      routeEvent(this.route(), sessionId, 'lifecycle', 'prompt_started', {
        prompt: args.prompt.text,
        userMessageId,
        ...(args.prompt.attachments ? { attachments: args.prompt.attachments } : {}),
      }),
    )
    const turn = this.openTurn(sessionId)
    try {
      input.push({
        type: 'user',
        // The correlation token. The SDK sends it back on the turn's terminal
        // result as `user_message_uuid`, which is what lets `ownsResult` tell
        // "this result is mine" from "this result belongs to a turn that was
        // already settled". Without it the only available check is "some turn
        // is active", and a late or duplicated result settles whichever turn
        // happens to be in flight.
        uuid: turn.id as SDKUserMessage['uuid'],
        message: { role: 'user', content },
        // Null, always: this is the user talking to the top-level agent. A
        // non-null parent would make the CLI attribute the message to a subagent
        // loop, and every frame it produced would then be dropped as subagent
        // traffic by the translator.
        parent_tool_use_id: null,
        session_id: sessionId,
      } as SDKUserMessage)
    } catch (error) {
      // The queue closed between the check above and this line — a window of a
      // few synchronous statements, but the failure it produces is permanent,
      // so it is unwound rather than hoped away. The turn is torn back down so
      // the thread is not left holding a dispatch nothing can settle, and the
      // error propagates so the job fails instead of hanging.
      this.failActiveTurn(error)
      throw error instanceof Error ? error : new Error(errorMessage(error))
    }
    return turn.done.then(() => undefined)
  }

  /** The input stream, proving it can still be written to.
   *
   * Separate from `assertUsable` because the queue closing and the phase
   * flipping are not the same instant: `performExit` closes the queue on its
   * way through, and `input` itself is undefined until `bootstrap` builds it. */
  private usableInput(): InputQueue {
    this.assertUsable()
    const input = this.input
    if (!input || input.isClosed)
      throw new Error(`Claude runtime unavailable for ${this.providerId}`)
    return input
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

  /** `dispatched -> completing -> idle`, for a result `ownsResult` has already
   * proved is ours. That proof lives there rather than here because it has to
   * run before the translator does — see `handle`. */
  private completeTurn(completed: NonNullable<TranslatedMessage['completed']>): void {
    // Ownership was settled by `ownsResult` before the translator ran and
    // nothing awaits in between, so the turn is still the one that was checked.
    // Re-read rather than passed so this cannot be called out of that context
    // and silently settle whatever it finds.
    const turn = this.turn
    if (!turn || turn.state !== 'dispatched') return
    turn.state = 'completing'
    this.turn = undefined
    // A failed result is a failure, not a quiet completion.
    //
    // This used to emit `prompt_completed` and settle cleanly for every result
    // the state machine accepted, `error_during_execution`, max-turns, budget
    // and structured-output exhaustion included. The job worker recorded those
    // jobs as completed and the user saw a turn that simply stopped mid-answer,
    // with the failure reported precisely nowhere.
    //
    // `runtime_error` rather than `rpc_error`: `rpc_error` describes a request
    // on a wire failing and requires a `source` naming that request. There is
    // no wire here — the SDK is an in-process API — and this frame is Claude
    // Code itself declaring the turn over, which is what `kind: 'provider'`
    // means. Deliberately NOT accompanied by a `prompt_completed`: both are
    // terminal downstream, and emitting both would finalize the turn twice,
    // the second time against a turn that no longer exists.
    if (completed.isError && !completed.interrupted) {
      const message = completed.errorText ?? 'Claude Code ended the turn with an error'
      this.emit(
        routeEvent(this.route(), completed.sessionId, 'error', 'runtime_error', {
          kind: 'provider',
          message,
          // The counts still happened, and this is the only frame left to carry
          // them; `prompt_completed`'s `usage` field has no failure counterpart.
          details: {
            ...(completed.stopReason ? { stopReason: completed.stopReason } : {}),
            ...(completed.usage ? { usage: completed.usage } : {}),
          },
        }),
      )
      turn.settle(new Error(message))
      void this.publishContextUsage(completed.sessionId)
      return
    }
    // Emitted here rather than by the translator: only a result the state
    // machine accepted means the *user's* turn is over. An interrupted turn
    // reaches this branch on purpose — the user stopping their own turn is not
    // a failure, and reporting it as one would fail every cancelled job.
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
    // Cancelling something already dead is a no-op, not an error: the exit path
    // has already cancelled this thread's interactions and failed its turn, and
    // a Stop button that throws because the process beat it there would surface
    // a failure the user cannot act on. Every other entry point goes through
    // `ready()`, which refuses.
    if (this.exitSettlement) return
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

  /** This session's catalog, plus the model actually in force.
   *
   * When nothing has been applied the answer is the CLI's own `default` row —
   * and that is not a placeholder, it is the truth: launching without
   * `options.model` means the CLI chooses, which is exactly what that row
   * means (`{value: 'default', resolvedModel: 'claude-sonnet-5'}`). Falling
   * back to the catalog's head covers a CLI too old to offer the row, whose
   * list is ordered default-first anyway. */
  private modelListing(): ModelListing {
    const fallback =
      this.modelCatalogValue.find((model) => model.id === CLAUDE_DEFAULT_MODEL_ID)?.id ??
      this.modelCatalogValue[0]?.id
    const currentModelId = this.appliedModelId ?? fallback
    return {
      availableModels: [...this.modelCatalogValue],
      ...(currentModelId ? { currentModelId } : {}),
    }
  }

  /** The catalog row the session is actually on, which is what gates effort,
   * fast mode and the `auto` permission mode. */
  private currentModel(): ModelOption | undefined {
    const id = this.appliedModelId ?? CLAUDE_DEFAULT_MODEL_ID
    return (
      this.modelCatalogValue.find((model) => model.id === id) ?? this.modelCatalogValue[0]
    )
  }

  private settingConfigOptions(): SessionConfigOption[] {
    return claudeConfigOptions({
      model: this.currentModel(),
      effort: this.appliedEffort,
      fastMode: this.appliedFastMode,
      outputStyle: this.appliedOutputStyle,
      outputStyles: this.outputStylesValue,
    })
  }

  /** Republish the settings block.
   *
   * Emitted on model changes as well as on its own writes, because the *shape*
   * depends on the model: switching to Haiku has to remove the effort row and
   * the fast-mode switch, not leave stale ones behind pointing at settings
   * that model ignores. */
  private publishConfigOptions(sessionId: string): void {
    this.emit(
      routeEvent(this.route(), sessionId, 'session', 'config_option_update', {
        configOptions: this.settingConfigOptions(),
      }),
    )
  }

  async setModel(modelId: string): Promise<void> {
    const sessionId = await this.ready()
    await this.queryOrThrow().setModel(modelId)
    // Only after the control request resolves: emitting first would show the
    // composer a selection the session may have refused.
    this.noteApplied({ modelId })
    // Catalog included for the same reason as `current_mode_update`: consumers
    // replace their listing wholesale, so a bare id blanks the picker.
    this.emit(
      routeEvent(this.route(), sessionId, 'session', 'current_model_update', this.modelListing()),
    )
    // The new model may support a different set of effort levels — or none —
    // and may or may not take fast mode.
    this.publishConfigOptions(sessionId)
    // A mode that the old model allowed and this one does not cannot be left
    // in force: the CLI rejects `auto` outright on a model without classifier
    // support, so the session would fail its next mode write instead of ours.
    if (this.appliedModeId === 'auto' && !this.currentModel()?.supportsAutoMode) {
      await this.setMode(CLAUDE_DEFAULT_MODE)
    } else {
      this.emit(
        routeEvent(
          this.route(),
          sessionId,
          'session',
          'current_mode_update',
          claudeModeListing(this.appliedModeId ?? CLAUDE_DEFAULT_MODE, this.currentModel()),
        ),
      )
    }
  }

  async setMode(modeId: string): Promise<void> {
    const sessionId = await this.ready()
    const mode = claudePermissionMode(modeId)
    if (!mode) throw new Error(`${this.providerId} has no permission mode "${modeId}"`)
    await this.queryOrThrow().setPermissionMode(mode)
    this.noteApplied({ modeId: mode })
    this.emit(
      // The catalog rides along with every update. Consumers replace their
      // whole `ModeListing` from this payload rather than merging into it, so
      // sending only `currentModeId` would blank the picker's options the
      // first time the user switched mode.
      routeEvent(
        this.route(),
        sessionId,
        'session',
        'current_mode_update',
        claudeModeListing(mode, this.currentModel()),
      ),
    )
  }

  /** Effort, fast mode and output style — the three settings that have no
   * dedicated control request and go through the flag-settings layer instead.
   *
   * Validated here rather than at the CLI, because the CLI does not validate
   * either: `applyFlagSettings({outputStyle: 'NotAStyle'})` is accepted and
   * becomes the session's current style. Effort is checked against the
   * *selected model's* levels for the same reason — the write succeeds on a
   * model with no effort support and simply does nothing. */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    const sessionId = await this.ready()
    switch (configId) {
      case CLAUDE_CONFIG.effort: {
        const levels = this.currentModel()?.effortLevels ?? []
        if (typeof value !== 'string' || !levels.includes(value))
          throw new Error(
            `${this.providerId} does not accept effort "${String(value)}" on this model`,
          )
        await this.queryOrThrow().applyFlagSettings({ effortLevel: value as EffortLevel })
        this.appliedEffort = value
        break
      }
      case CLAUDE_CONFIG.fastMode: {
        const enabled = value === true || value === 'true'
        if (enabled && !this.currentModel()?.supportsFastMode)
          throw new Error(`${this.providerId} has no fast mode on this model`)
        await this.queryOrThrow().applyFlagSettings({ fastMode: enabled })
        this.appliedFastMode = enabled
        break
      }
      case CLAUDE_CONFIG.outputStyle: {
        if (typeof value !== 'string' || !this.outputStylesValue.includes(value))
          throw new Error(`${this.providerId} has no output style "${String(value)}"`)
        await this.queryOrThrow().applyFlagSettings({ outputStyle: value })
        this.appliedOutputStyle = value
        break
      }
      default:
        throw new Error(`${this.providerId} has no "${configId}" config option`)
    }
    this.appliedAt = new Date().toISOString()
    this.publishConfigOptions(sessionId)
  }

  /** Push the launch's remembered settings onto a freshly started process.
   *
   * Only `effort` can ride `Options` at launch; fast mode and output style are
   * `Settings` keys with no launch equivalent, so they go out as one
   * flag-settings write immediately after `initialize`. Best-effort by design
   * — a rejected *setting* must not fail a session that is otherwise ready,
   * and the composer re-publishes what actually landed either way. */
  private async applyLaunchSettings(values: Readonly<Record<string, string | boolean>>): Promise<void> {
    const model = this.currentModel()
    const effort = values[CLAUDE_CONFIG.effort]
    if (typeof effort === 'string' && (model?.effortLevels ?? []).includes(effort))
      this.appliedEffort = effort
    const fastMode = values[CLAUDE_CONFIG.fastMode] === true
    const outputStyle = values[CLAUDE_CONFIG.outputStyle]
    const settings: ClaudeFlagSettings = {
      // Fast mode is off unless asked for, and asking is what clears the
      // CLI's `sdk_opt_in_required` block — an SDK consumer never inherits the
      // user's interactive preference, so silence here means off.
      ...(fastMode && model?.supportsFastMode ? { fastMode: true } : {}),
      ...(typeof outputStyle === 'string' && this.outputStylesValue.includes(outputStyle)
        ? { outputStyle }
        : {}),
    }
    if (fastMode && model?.supportsFastMode) this.appliedFastMode = true
    if (typeof outputStyle === 'string' && this.outputStylesValue.includes(outputStyle))
      this.appliedOutputStyle = outputStyle
    if (Object.keys(settings).length === 0) return
    try {
      await this.queryOrThrow().applyFlagSettings(settings)
    } catch (error) {
      this.host.log({
        scope: 'claude',
        level: 'warn',
        message: 'Claude Code refused a remembered session setting',
        data: { settings, error: String(error) },
      })
    }
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
    const mode = claudePermissionMode(desired.modeId)
    if (mode !== undefined && mode !== this.appliedModeId) await this.setMode(mode)
    // Settings last, so they land against the model and mode that will
    // actually run. Each is best-effort: a remembered effort level that this
    // model dropped must not fail the prompt it was attached to.
    for (const [configId, value] of Object.entries(desired.values ?? {})) {
      try {
        await this.setConfigOption(configId, value)
      } catch (error) {
        this.host.log({
          scope: 'claude',
          level: 'warn',
          message: 'Claude Code refused a remembered session setting',
          data: { configId, value, error: String(error) },
        })
      }
    }
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
      // Both mode short circuits sit AFTER the two interactive tools above:
      // `AskUserQuestion` and `ExitPlanMode` are not permission prompts, they
      // are the model asking the user something and proposing a plan, and
      // answering them from a permission mode would speak for the user.
      const mode = this.appliedModeId as PermissionMode | undefined
      // The only mode that means "allow everything", and the only one the SDK
      // makes us opt into with `allowDangerouslySkipPermissions` — see
      // `bootstrap`.
      if (mode === 'bypassPermissions') return { behavior: 'allow' }
      if (mode === 'dontAsk') return NOT_PRE_APPROVED
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
    const outcome = await this.awaitInteraction({
      requestId,
      sessionId,
      kind: 'question',
      signal: options.signal,
      emitRequest: () =>
        this.emit(
          routeEvent(this.route(), sessionId, 'session', 'question_request', {
            requestId,
            sessionId,
            ...(parsed.title ? { title: parsed.title } : {}),
            questions: parsed.questions,
          }),
        ),
    })
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
    const outcome = await this.awaitInteraction({
      requestId,
      sessionId,
      kind: 'plan_review',
      signal: options.signal,
      // A plan is read, not clicked through; the default interaction timeout is
      // far too short for one.
      timeoutMs: PLAN_REVIEW_TIMEOUT_MS,
      emitRequest: () =>
        this.emit(
          routeEvent(this.route(), sessionId, 'session', 'plan_review_request', {
            ...planFromExitPlanMode(input),
            requestId,
            sessionId,
          }),
        ),
    })
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
    // The same rule `awaitInteraction` documents, and for the same reason: an
    // already-aborted call registers nothing and emits nothing, so a permission
    // row can never appear after the settlement that closes it.
    const abortedCancellation: PermissionOutcome = {
      outcome: 'cancelled',
      reason: 'tool_cancelled',
    }
    if (options.signal.aborted) return USER_CANCELLED
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
    let detach: () => void = () => undefined
    try {
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
      // Subscribed only once the request is out — see `awaitInteraction`.
      detach = this.onAbort(options.signal, () =>
        this.permissions.respond(requestId, abortedCancellation),
      )
    } catch (error) {
      // Registration and announcement settle together. A listener that threw
      // here used to leave the row pending for the full five-minute permission
      // timeout, and — because `response.finally(detach)` below was never
      // reached — with its abort listener still attached to a signal the SDK
      // keeps alive for the rest of the turn.
      this.permissions.respond(requestId, abortedCancellation)
      throw error
    }
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
   * simply reports `false`.
   *
   * The request is emitted from here rather than by the caller because the
   * order of the three steps is the whole correctness argument, and a caller
   * that owns the middle one can get it wrong. Register, THEN announce, THEN
   * subscribe to the abort:
   *
   * - Registering first is what lets a fast local renderer answer the instant
   *   it sees the request; announcing first leaves `respond` nothing to settle.
   * - Subscribing LAST is what stops a settlement from being published before
   *   the request it settles. `onAbort` fires synchronously on a signal that
   *   has already aborted, so subscribing first turned an already-dead call
   *   into `*_resolved` followed by `*_request` — leaving every consumer
   *   holding a pending interaction whose deferred no longer exists, which
   *   nobody can answer and whose timeout died with it. */
  private awaitInteraction(args: {
    requestId: string
    sessionId: string
    kind: InteractionKind
    signal: AbortSignal
    emitRequest: () => void
    timeoutMs?: number
  }): Promise<InteractionOutcome> {
    // Already cancelled before any of it exists. Nothing is registered and
    // nothing is announced: the strongest form of "a request is never emitted
    // after its settlement" is not emitting one at all.
    if (args.signal.aborted) {
      this.forgetInteraction(args.requestId)
      return Promise.resolve({ outcome: 'cancelled', reason: 'tool_cancelled' })
    }
    const settlement = new Promise<InteractionOutcome>((resolve) =>
      this.interactions.add(
        args.requestId,
        {
          kind: args.kind,
          providerId: this.providerId,
          threadId: this.threadIdValue,
          workspaceId: this.workspaceIdValue,
          sessionId: args.sessionId,
          resolve,
        },
        args.timeoutMs,
      ),
    )
    let detach: () => void = () => undefined
    try {
      args.emitRequest()
      detach = this.onAbort(args.signal, () => this.interactions.cancel(args.requestId))
    } catch (error) {
      // Registration and announcement settle together or not at all. A listener
      // that throws mid-emit used to leave the record parked for its full
      // timeout — five minutes for a question, an hour for a plan review —
      // because `canUseTool`'s outer catch returns a denial to the SDK without
      // ever touching the broker. The tool was denied and the row stayed up.
      this.interactions.cancel(args.requestId)
      this.forgetInteraction(args.requestId)
      throw error
    }
    return settlement.finally(() => {
      detach()
      this.forgetInteraction(args.requestId)
    })
  }

  /** Drop whatever this runtime was holding for a requestId. Safe to call for
   * a kind that owns neither map — both deletes are no-ops on a miss. */
  private forgetInteraction(requestId: string): void {
    this.questionContexts.delete(requestId)
    this.planRequestIds.delete(requestId)
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
  /** The session id, proving the runtime is alive at the moment it answers.
   *
   * The liveness check is not decoration. `sessionIdValue` and `startResult`
   * both survive the process dying — they are memos of a successful start, not
   * of a running child — so trusting them alone answers "did this runtime ever
   * start" when every caller is asking "can I use it now". A dead runtime that
   * answers the first question sends `prompt()` on to push into a closed input
   * queue and `setModel()` on to a query that no longer exists. */
  private async ready(): Promise<string> {
    this.assertUsable()
    if (this.sessionIdValue && this.startResult) return this.sessionIdValue
    const result = await this.start()
    // `start()` memoises, so this can be somebody else's in-flight bootstrap
    // that resolved after an exit settled; the same window the success
    // continuation above closes, re-checked from the other side.
    this.assertUsable()
    return result.sessionId
  }

  /** Throw unless this runtime is still usable.
   *
   * `exitSettlement` rather than `exitValue`: `performExit` closes the input
   * queue and clears the query on its first await, long before `exitValue` is
   * assigned, so a caller that only checked the settled exit would be waved
   * through into exactly the window this exists to close. */
  private assertUsable(): void {
    if (
      this.exitSettlement ||
      this.phaseValue === 'stopping' ||
      this.phaseValue === 'exited'
    )
      throw new Error(`Claude runtime for ${this.providerId} has stopped`)
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

  get isClosed(): boolean {
    return this.closed
  }

  /** Throws on a closed queue rather than returning.
   *
   * Dropping the message silently is what made a lost prompt invisible: the
   * caller had already opened a turn, nothing would ever deliver the message,
   * and nothing would ever produce the `result` that settles it. A closed queue
   * is not a condition a caller can usefully ignore, so it is not one it is
   * allowed to miss. */
  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error('the Claude Code input stream is closed')
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
