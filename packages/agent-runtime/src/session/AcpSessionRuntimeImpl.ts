import type * as acp from '@agentclientprotocol/sdk'
import type {
  AuthMethod,
  ExtensionOutcome,
  PermissionOption,
  PermissionOutcome,
  PlanEntry,
  PlanReviewOutcome,
  PlanTodo,
  PromptInput,
  ProviderId,
  ProviderSessionInfo,
  QuestionOutcome,
  SessionConfigOption,
  SubtaskUpdate,
  ToolCall,
  ToolCallUpdate,
} from '@agentpack/contract'
import type {
  BackendEvent,
  BackendEventListener,
  BackendRoute,
  SessionResult,
} from '../backends/Backend.js'
import { parseAcpFormElicitation, type AcpFormQuestionAdapter } from '../backends/acp/elicitation.js'
import {
  ExtensionRegistry,
  subtaskStatusFromTool,
  type PlanAdapter,
  type PlanSnapshot,
  type QuestionAdapter,
} from '../backends/acp/extensions.js'
import { AuthRequiredError } from '../core/errors.js'
import type { ExtensionBroker } from '../core/ExtensionBroker.js'
import type { PermissionBroker } from '../core/PermissionBroker.js'
import type { HostDeps } from '../host.js'
import {
  OpenCodeQuestions,
  type OpenCodeQuestionRequest,
} from '../providers/opencode-questions.js'
import type { ProviderConfig } from '../providers/index.js'
import type {
  AcpConnection,
  AcpConnectionFactory,
  AcpSessionRuntime,
  SessionRuntimeDeps,
  SessionRuntimeFactory,
  SessionRuntimeSpec,
} from './AcpSessionRuntime.js'
import {
  AppliedConfigCache,
  configValueMatches,
  type AppliedSessionState,
  type ConfigApplyDecision,
} from './AppliedConfigCache.js'
import { DEFAULT_RUNTIME_TIMEOUTS, type RuntimeTimeouts } from './constants.js'
import { RpcTimeoutError, withTimeout } from './timeout.js'
import type {
  DesiredSessionConfig,
  ProcessExit,
  SessionRuntimeExit,
  SessionRuntimePhase,
  TerminationRequest,
  ThreadId,
} from './lifecycle.js'
import {
  ACP_ELICITATION_METHOD,
  PLAN_REVIEW_TIMEOUT_MS,
  agentInfo,
  authMethods,
  contentBlock,
  errorCode,
  errorMessage,
  initialState,
  initializeRequest,
  isAuthRequired,
  isSessionNotFound,
  listSessionsPaged,
  modeListingFromConfig,
  modelListingFromConfig,
  normalizeModeListing,
  normalizeModelListing,
  number,
  object,
  routeEvent,
  sessionIdOf,
  sessionListAdvertised,
  string,
  toolContent,
} from './wire.js'

/** `AcpSessionRuntime` plus the one mutation the registry needs.
 *
 * Invariant 4 keys the registry on the *thread* id, but `create_session`
 * genuinely renames a thread: the job worker creates a session under a
 * provisional uuid and then rebinds it to the ACP session id. The runtime
 * stamps every event with its thread id, so the rename has to reach it. */
export interface ManagedSessionRuntime extends AcpSessionRuntime {
  rebindThread(threadId: ThreadId, workspaceId: string | undefined): void
}

export interface ManagedSessionRuntimeFactory extends SessionRuntimeFactory {
  create(spec: SessionRuntimeSpec): ManagedSessionRuntime
}

type QuestionContext =
  | { adapter: QuestionAdapter; params: unknown }
  | { elicitation: AcpFormQuestionAdapter }
  | { native: string }
  | { plan: PlanAdapter; params: unknown }

/** One child process, one ACP session, one thread.
 *
 * Everything here was `AcpBackend`, minus the multi-session bookkeeping: the
 * `SessionStore`, the provider-wide `promptTail` serialisation and the
 * `correlateSessionlessExtensionsToActivePrompt` quirk all existed only to
 * disambiguate several sessions sharing one process. */
export class AcpSessionRuntimeImpl implements ManagedSessionRuntime {
  readonly providerId: ProviderId
  readonly cwd: string
  readonly exited: Promise<SessionRuntimeExit>

  private threadIdValue: ThreadId
  private workspaceIdValue: string | undefined
  private phaseValue: SessionRuntimePhase = 'created'
  private sessionIdValue: string | undefined
  private resumeCursorValue: string | undefined
  private exitValue: SessionRuntimeExit | undefined
  private resolveExited!: (exit: SessionRuntimeExit) => void

  private transport: AcpConnection | null = null
  private startPromise: Promise<SessionResult> | null = null
  private startResult: SessionResult | undefined
  private stopRequest: TerminationRequest | undefined
  private nativeQuestions: OpenCodeQuestions | null = null
  private sessionListAdvertisedValue = false
  /** Tail of the dispatch gate — see `withDispatchGate`. */
  private dispatchGate: Promise<unknown> = Promise.resolve()

  private readonly config: ProviderConfig
  private readonly host: Pick<HostDeps, 'log' | 'onSessionTitle'>
  private readonly permissions: PermissionBroker
  private readonly extensionRequests: ExtensionBroker
  private readonly connections: AcpConnectionFactory
  private readonly timeouts: RuntimeTimeouts
  private readonly extensions: ExtensionRegistry
  private readonly appliedCache = new AppliedConfigCache()
  private readonly listeners = new Set<BackendEventListener>()
  private readonly exitListeners = new Set<(exit: SessionRuntimeExit) => void>()
  private readonly questionContexts = new Map<string, QuestionContext>()
  /** toolCallIds claimed as subtasks. One session, so the id alone is unique. */
  private readonly subtaskToolIds = new Set<string>()
  private lastPlanTodos: PlanTodo[] = []

  constructor(
    private readonly spec: SessionRuntimeSpec,
    deps: SessionRuntimeDeps & { connections: AcpConnectionFactory },
  ) {
    this.providerId = spec.providerId
    this.cwd = spec.cwd
    this.threadIdValue = spec.threadId
    this.workspaceIdValue = spec.workspaceId
    this.config = deps.config
    this.host = deps.host
    this.permissions = deps.permissions
    this.extensionRequests = deps.extensions
    this.connections = deps.connections
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
    this.extensions = new ExtensionRegistry(deps.config.extensions)
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
  get listSessionsAdvertised(): boolean {
    return this.sessionListAdvertisedValue
  }
  get applied(): AppliedSessionState | undefined {
    return this.appliedCache.state
  }
  get resumeCursor(): string | undefined {
    return this.resumeCursorValue
  }
  get exit(): SessionRuntimeExit | undefined {
    return this.exitValue
  }

  rebindThread(threadId: ThreadId, workspaceId: string | undefined): void {
    const previous = this.threadIdValue
    this.threadIdValue = threadId
    if (workspaceId !== undefined) this.workspaceIdValue = workspaceId
    if (previous === threadId) return
    // Requests parked on the app-wide brokers were tagged with the old thread
    // id. Leaving them there means the `settleThread(providerId, threadId)`
    // this runtime issues when its process dies matches nothing, and the
    // caller waits out the broker's 5-minute timeout for a process that is
    // already gone.
    this.permissions.rekeyThread(this.providerId, previous, threadId, this.workspaceIdValue)
    this.extensionRequests.rekeyThread(this.providerId, previous, threadId, this.workspaceIdValue)
  }

  /** Serialise everything that can change this session's agent-side config
   * against the dispatch of a prompt, on this runtime alone.
   *
   * Cursor binds a turn's model at the moment `session/prompt` is *dispatched*,
   * not when the request object is built, so "apply the desired config, then
   * dispatch" has to be one critical section. Without it: turn A is streaming,
   * prompt B applies model B and queues, prompt C applies model C and queues,
   * A ends and B dispatches on C's model.
   *
   * The gate is per-runtime, so two threads still stream concurrently
   * (invariant 12), and it is released the moment `session/prompt` has been
   * handed to the connection rather than when the turn completes: the SDK
   * appends every outbound message to one write queue synchronously inside the
   * send call, so any config write issued after the gate is released is
   * ordered behind the prompt on the wire and cannot affect it. Releasing at
   * dispatch is what keeps a `set_model` from blocking for the length of a
   * turn. */
  private withDispatchGate<T>(work: () => Promise<T>): Promise<T> {
    const run = this.dispatchGate.then(work, work)
    this.dispatchGate = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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
      throw new Error(`ACP runtime for ${this.providerId} has stopped`)
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

  private async bootstrap(): Promise<SessionResult> {
    await this.connect()
    const transport = this.transport
    if (!transport) throw new Error(`ACP runtime unavailable for ${this.providerId}`)
    // A CLI that dies mid-handshake leaves the RPC unanswered forever, which is
    // how `AcpBackend` hung on a missing binary. Liveness is known from the
    // child's own exit, so race the bootstrap against it.
    const died = transport.exited.then((exit) => {
      throw new Error(
        `${this.providerId} exited during startup (code ${exit.exitCode ?? 'null'}, signal ${exit.signal ?? 'none'})`,
      )
    })
    return Promise.race([this.handshakeAndOpen(), died])
  }

  private async handshakeAndOpen(): Promise<SessionResult> {
    await this.handshake()
    const result = await this.openSession()
    // The session response has just seeded the cache, so this reconciles
    // against freshly read-back state. It matters most on a cold Cursor
    // process, whose model/config state is process-global *and* restored from
    // disk: `session/new` can report a model left behind by an already-exited
    // process, and this is where that gets corrected.
    if (this.spec.desiredConfig) await this.applyDesiredConfig(this.spec.desiredConfig)
    return result
  }

  private async connect(): Promise<void> {
    const command =
      process.env[this.config.command.envOverride] ??
      (this.config.command.fallbackEnvOverride
        ? process.env[this.config.command.fallbackEnvOverride]
        : undefined) ??
      this.config.command.bin
    this.nativeQuestions =
      this.config.quirks.nativeQuestions === 'opencode' ? await OpenCodeQuestions.create() : null
    const args = this.nativeQuestions
      ? this.nativeQuestions.spawnArgs(this.config.command.args)
      : this.config.command.args
    const client: acp.Client = {
      requestPermission: async (params) => this.permissionRequest(params),
      sessionUpdate: async (params) => this.sessionUpdate(params),
      unstable_createElicitation: async (params) => this.elicitationRequest(params),
      extMethod: async (method, params) => this.extensionRequest(method, params),
      extNotification: async (method, params) => this.extensionNotification(method, params),
    }
    try {
      this.transport = await this.connections.connect({
        providerId: this.providerId,
        command,
        args,
        cwd: this.cwd,
        env: environment(this.config.command.env),
        client,
        spawnTimeoutMs: this.timeouts.spawnMs,
        terminateGraceMs: this.timeouts.terminateGraceMs,
      })
    } catch (error) {
      this.emit(
        routeEvent(this.route(), undefined, 'error', 'runtime_error', {
          kind: 'process',
          message: errorMessage(error),
          recoverable: true,
        }),
      )
      throw error
    }
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'process_spawned', {
        cwd: this.cwd,
        command,
        args,
        processId: this.transport.pid,
      }),
    )
    void this.transport.exited.then((exit) => this.settleExit(exit, true))
  }

  private async handshake(): Promise<void> {
    let response
    try {
      response = object(
        await this.rpc(
          'initialize',
          this.timeouts.initializeMs,
          this.connection().initialize(initializeRequest()),
        ),
      )
    } catch (error) {
      if (isAuthRequired(error)) throw this.authRequired(undefined, errorMessage(error))
      throw error
    }
    this.sessionListAdvertisedValue = sessionListAdvertised(
      response,
      this.config.capabilities.canListSessions,
    )
    const methods = authMethods(response)
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'initialized', {
        protocolVersion: string(response.protocolVersion),
        agentInfo: agentInfo(response),
        capabilities: {
          ...this.config.capabilities,
          canListSessions: this.sessionListAdvertisedValue,
        },
        promptCapabilities: object(response.agentCapabilities).promptCapabilities,
        authMethods: methods,
      }),
    )
    this.nativeQuestions?.start(
      (request) => {
        void this.nativeQuestionRequest(request).catch((error) =>
          this.host.log({
            scope: 'acp',
            level: 'error',
            message: 'OpenCode question bridge failed',
            data: { error: errorMessage(error), requestId: request.requestId },
          }),
        )
      },
      (error) =>
        this.host.log({
          scope: 'acp',
          level: 'warn',
          message: 'OpenCode question event stream stopped',
          data: { error: errorMessage(error) },
        }),
    )
    const methodId = this.pickAuthMethod(methods)
    if (!methodId) return
    try {
      await this.rpc(
        'authenticate',
        this.timeouts.authenticateMs,
        this.connection().authenticate({ methodId }),
      )
      this.emit(routeEvent(this.route(), undefined, 'lifecycle', 'authenticated', { methodId }))
    } catch (error) {
      const authError = this.authRequired(methods, errorMessage(error))
      if (!this.config.auth.tolerateAuthenticateFailure) throw authError
    }
  }

  private async openSession(): Promise<SessionResult> {
    if (this.spec.sessionId && this.config.capabilities.canLoadSession) {
      // Agents replay session/update notifications before session/load returns.
      // Adopt the id first so those events are not dropped as unknown.
      this.sessionIdValue = this.spec.sessionId
      this.resumeCursorValue = this.spec.resumeCursor
      try {
        const response = object(
          await this.rpc(
            'session/load',
            this.timeouts.loadSessionMs,
            this.connection().loadSession({
              sessionId: this.spec.sessionId,
              cwd: this.cwd,
              mcpServers: [],
            }),
          ),
        )
        const state = initialState(response)
        this.appliedCache.refresh(state.configOptions, 'session/load')
        this.emit(
          routeEvent(this.route(), this.spec.sessionId, 'lifecycle', 'session_loaded', state),
        )
        return {
          sessionId: this.spec.sessionId,
          state: 'loaded',
          resumeCursor: this.resumeCursorValue,
        }
      } catch (error) {
        if (isAuthRequired(error)) throw this.authRequired(undefined, errorMessage(error))
        // Only "that session id is unknown" may fall through to `session/new`.
        // That case is real and common — `session/load` answers it for a
        // session that was created but never prompted — and creating a fresh
        // session loses nothing, because there was nothing to lose.
        //
        // Every other failure must not. A `session/load` that blew its 90s
        // budget is the dangerous one: the request cannot be withdrawn, so the
        // agent may still complete the load while we open a second session on
        // the same connection, and prompting the blank one silently throws the
        // conversation away. Failing the start instead tears the process down,
        // which is recoverable — the next use respawns and tries the load
        // again — where a lost transcript is not.
        if (!isSessionNotFound(error)) throw error
        this.sessionIdValue = undefined
        this.resumeCursorValue = undefined
        this.host.log({
          scope: 'acp',
          level: 'warn',
          message: 'Stored ACP session is unknown to the agent; creating a new session',
          data: { sessionId: this.spec.sessionId, error: errorMessage(error) },
        })
      }
    }
    try {
      const response = object(
        await this.rpc(
          'session/new',
          this.timeouts.newSessionMs,
          this.connection().newSession({ cwd: this.cwd, mcpServers: [] }),
        ),
      )
      const sessionId = string(response.sessionId)
      if (!sessionId) throw new Error('ACP session/new returned no sessionId')
      const state = initialState(response)
      this.sessionIdValue = sessionId
      this.resumeCursorValue = this.spec.resumeCursor
      this.appliedCache.refresh(state.configOptions, 'session/new')
      this.emit(routeEvent(this.route(), sessionId, 'lifecycle', 'session_created', state))
      return { sessionId, state: 'created', resumeCursor: this.spec.resumeCursor }
    } catch (error) {
      if (isAuthRequired(error)) throw this.authRequired(undefined, errorMessage(error))
      throw error
    }
  }

  async stop(request: TerminationRequest): Promise<SessionRuntimeExit> {
    if (this.exitValue) return this.exitValue
    this.stopRequest = request
    this.phaseValue = 'stopping'
    const transport = this.transport
    if (!transport) {
      // Never spawned: there is no process death to report, only bookkeeping.
      return this.settleExit(
        { exitCode: null, signal: null, forced: false, at: new Date().toISOString() },
        false,
      )
    }
    await transport.terminate(request)
    return this.exited
  }

  dispose(): void {
    void this.stop({ reason: 'disposed' }).catch(() => undefined)
  }

  /** Settle brokers, tell this thread its process is gone, then resolve
   * `exited`. `emitted` is false only when no process was ever spawned. */
  private settleExit(exit: ProcessExit, emitted: boolean): SessionRuntimeExit {
    if (this.exitValue) return this.exitValue
    const expected = this.stopRequest !== undefined
    this.phaseValue = 'exited'
    this.permissions.settleThread(this.providerId, this.threadIdValue)
    this.extensionRequests.settleThread(this.providerId, this.threadIdValue)
    this.nativeQuestions?.dispose()
    this.nativeQuestions = null
    if (emitted)
      this.emit(
        routeEvent(this.route(), this.sessionIdValue, 'lifecycle', 'process_exited', {
          exitCode: exit.exitCode,
          signal: exit.signal ?? undefined,
          expected,
        }),
      )
    const runtimeExit: SessionRuntimeExit = {
      ...exit,
      expected,
      ...(this.stopRequest ? { reason: this.stopRequest.reason } : {}),
      ...(this.resumeCursorValue ? { resumeCursor: this.resumeCursorValue } : {}),
    }
    this.exitValue = runtimeExit
    this.resolveExited(runtimeExit)
    for (const listener of this.exitListeners) listener(runtimeExit)
    return runtimeExit
  }

  // ------------------------------------------------------------------- prompt

  /** Run one turn.
   *
   * `desiredConfig` is applied *here*, inside the dispatch gate, rather than
   * by the caller before queueing — that is the whole point. A caller that
   * reconciles config and then queues a prompt has no way to stop a second
   * caller reconciling different config into the same process while the first
   * prompt is still waiting its turn. Handing the selection to the prompt
   * makes "the model this turn runs on" a property of the turn instead of a
   * property of the process at an unspecified moment. */
  async prompt(args: {
    prompt: PromptInput
    userMessageId?: string
    desiredConfig?: DesiredSessionConfig
  }): Promise<void> {
    const sessionId = await this.ready()
    const userMessageId = args.userMessageId ?? `agent_usr_${crypto.randomUUID()}`
    // The gate closes over apply-then-dispatch and reopens at dispatch; the
    // turn itself streams outside it. `inFlight` is wrapped in an object
    // because returning a bare promise from an async callback would await it,
    // which would hold the gate for the whole turn and serialise the thread's
    // config writes behind a task that can run for minutes.
    const dispatched = await this.withDispatchGate(async () => {
      if (args.desiredConfig) await this.reconcile(sessionId, args.desiredConfig)
      this.emit(
        routeEvent(this.route(), sessionId, 'lifecycle', 'prompt_started', {
          prompt: args.prompt.text,
          userMessageId,
          attachments: args.prompt.attachments,
        }),
      )
      // Deliberately the one RPC with no timeout. A turn legitimately runs for
      // many minutes — a long agent task is indistinguishable from a wedge
      // from out here, and cutting one off would destroy the user's work,
      // which is the exact failure the rest of this file exists to avoid.
      // Liveness still bounds it: the child's own exit rejects this call.
      return {
        inFlight: this.connection().prompt({
          sessionId,
          prompt: args.prompt.blocks as unknown as acp.ContentBlock[],
        }),
      }
    })
    try {
      const result = object(await dispatched.inFlight)
      this.emit(
        routeEvent(this.route(), sessionId, 'lifecycle', 'prompt_completed', {
          stopReason: string(result.stopReason),
          usage: result.usage,
        }),
      )
    } catch (error) {
      throw this.rpcError(sessionId, 'session/prompt', error)
    } finally {
      this.subtaskToolIds.clear()
    }
  }

  async cancel(): Promise<void> {
    const sessionId = await this.ready()
    this.permissions.cancelThread(this.providerId, this.threadIdValue)
    this.extensionRequests.cancelThread(this.providerId, this.threadIdValue)
    try {
      await this.rpc(
        'session/cancel',
        this.timeouts.controlRequestMs,
        this.connection().cancel({ sessionId }),
      )
    } catch (error) {
      throw this.rpcError(sessionId, 'session/cancel', error)
    }
  }

  /** `session/list` on this runtime's own connection.
   *
   * Deliberately does not go through `ready()`: listing is provider metadata,
   * not session state, so it only needs the handshake to have happened. It
   * takes no lock and holds no turn — `session/list` is a read that touches
   * no model or config state, which is what makes borrowing a live process
   * for it safe where a health probe would not be. */
  async listSessions(): Promise<ProviderSessionInfo[]> {
    if (!this.sessionListAdvertisedValue)
      throw new Error(`${this.providerId} does not advertise ACP session/list support`)
    // No `rpc_error` event: a title refresh failing is not something the user
    // asked for and must not surface as a session error. The caller logs it.
    return this.rpc(
      'session/list',
      this.timeouts.controlRequestMs,
      listSessionsPaged(this.connection(), this.cwd),
    )
  }

  // ------------------------------------------------------------------- config

  async setModel(modelId: string): Promise<void> {
    const sessionId = await this.ready()
    await this.withDispatchGate(() => this.writeModel(sessionId, modelId))
  }

  async setMode(modeId: string): Promise<void> {
    const sessionId = await this.ready()
    await this.withDispatchGate(() => this.writeMode(sessionId, modeId))
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    const sessionId = await this.ready()
    await this.withDispatchGate(() => this.applyOption(sessionId, configId, value))
  }

  /** Reconcile a whole desired selection against what this session reported
   * over its own wire: model first, re-plan, then mode and values.
   *
   * On Cursor this replaces a blind 11.5s preamble (`set_model` 2.9s plus one
   * `set_config_option` per remembered key, all re-sent identically on every
   * message) with zero RPCs whenever nothing changed. */
  async applyDesiredConfig(desired: DesiredSessionConfig): Promise<void> {
    const sessionId = await this.ready()
    await this.withDispatchGate(() => this.reconcile(sessionId, desired))
  }

  private async writeModel(sessionId: string, modelId: string): Promise<void> {
    const configId = this.appliedCache.modelConfigId
    if (!configId) {
      await this.legacySetModel(sessionId, modelId)
      return
    }
    await this.applyOption(sessionId, configId, modelId)
    this.emitModel(sessionId, modelId)
  }

  private async writeMode(sessionId: string, modeId: string): Promise<void> {
    const configId = this.appliedCache.modeConfigId
    if (!configId) {
      await this.legacySetMode(sessionId, modeId)
      return
    }
    await this.applyOption(sessionId, configId, modeId)
    this.emitMode(sessionId, modeId)
  }

  /** `applyDesiredConfig` without the gate, for callers that already hold it.
   * Everything that writes config lives below this line and takes the gate as
   * a precondition, so there is exactly one place the gate can be acquired
   * per public entry point and no path can acquire it twice. */
  private async reconcile(sessionId: string, desired: DesiredSessionConfig): Promise<void> {
    if (!this.hasAppliedState()) {
      // The agent advertised no config options on this session's own wire, so
      // there is nothing to compare against and nothing to prune. Apply
      // everything, exactly as the old preamble did: correctness beats latency.
      if (desired.modelId !== undefined) await this.writeModel(sessionId, desired.modelId)
      if (desired.modeId !== undefined) await this.writeMode(sessionId, desired.modeId)
      for (const [configId, value] of Object.entries(desired.values ?? {}))
        await this.writeConfigOption(sessionId, configId, value)
      return
    }

    let plan = this.appliedCache.plan(desired)
    if (desired.modelId !== undefined) {
      if (plan.legacySetModel) await this.legacySetModel(sessionId, desired.modelId)
      else if (await this.applyPlanned(sessionId, plan.model, desired.modelId, 'model'))
        this.emitModel(sessionId, desired.modelId)
    }
    // Applying a model rewrites which options are legal, so everything after it
    // is decided against the refreshed list, never the pre-change one.
    if (plan.staleAfterModelChange) plan = this.appliedCache.plan(desired)

    if (desired.modeId !== undefined) {
      if (plan.legacySetMode) await this.legacySetMode(sessionId, desired.modeId)
      else if (await this.applyPlanned(sessionId, plan.mode, desired.modeId, 'mode'))
        this.emitMode(sessionId, desired.modeId)
    }
    for (const decision of plan.values) {
      const value = desired.values?.[decision.configId]
      if (value === undefined) continue
      await this.applyPlanned(sessionId, decision, value, 'value')
    }
  }

  /** An agent-initiated model/mode change that contradicts what the cache read
   * back. Skipping a write because of a value the agent has since moved away
   * from is exactly the failure this cache exists to prevent, so the notified
   * value — itself wire-sourced — replaces the cached one. The rest of the
   * list may now describe the previous model; applying a model re-plans
   * against the write's response, which repairs it. */
  private noteExternalChange(configId: string | undefined, currentValue: string | undefined): void {
    if (!configId || currentValue === undefined) return
    const state = this.appliedCache.state
    const option = state?.options.get(configId)
    if (!state || !option || configValueMatches(option, currentValue)) return
    this.appliedCache.refresh(
      [...state.options.values()].map((candidate) =>
        candidate.id === configId ? withCurrentValue(candidate, currentValue) : candidate,
      ),
      'config_option_update',
    )
  }

  /** True once this session has reported at least one config option. An empty
   * list means "unknown", not "no options exist": until something has been read
   * back, nothing can be proved satisfied and nothing can be pruned. */
  private hasAppliedState(): boolean {
    const state = this.appliedCache.state
    return state !== undefined && state.options.size > 0
  }

  /** Reconcile one option a caller named directly — a `set_model`, `set_mode`
   * or `set_config_option` job, i.e. a deliberate user action. Asking for
   * something the agent cannot honour is an error here, and saying so locally
   * beats burning ~1.4s on a round trip that fails with "Unknown model config
   * option". */
  private async applyOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    const decision = this.appliedCache.decide(configId, value)
    if (decision.decision === 'satisfied') {
      // Wire-sourced `currentValue` already matches: no RPC. Report the state
      // anyway so the caller's optimistic UI is confirmed rather than left
      // waiting for an update that is never coming.
      this.emitConfigOptions(sessionId)
      return
    }
    // Either the cache proved a write is needed, or it holds nothing at all and
    // cannot prove anything — in which case the write is the correct fallback.
    if (decision.decision === 'apply' || !this.hasAppliedState()) {
      await this.writeConfigOption(sessionId, configId, value)
      return
    }
    throw this.rejected(sessionId, decision.decision, configId, value, 'explicit')
  }

  /** Execute one decision from `plan()`. Returns true when an RPC was sent.
   *
   * Remembered *values* the current model does not expose are pruned and
   * logged: `composer-2.5` advertises mode/model/fast where `claude-opus-5`
   * advertises six, and there is no way to honour an option the agent does not
   * have. Model and mode are not pruned — a prompt running on a model other
   * than the one the composer shows is the bug this whole path exists to
   * prevent, so an unusable one fails loudly. */
  private async applyPlanned(
    sessionId: string,
    decision: ConfigApplyDecision | undefined,
    value: string | boolean,
    kind: 'model' | 'mode' | 'value',
  ): Promise<boolean> {
    if (!decision || decision.decision === 'satisfied') return false
    if (decision.decision === 'apply') {
      await this.writeConfigOption(sessionId, decision.configId, decision.value)
      return true
    }
    if (kind !== 'value')
      throw this.rejected(sessionId, decision.decision, decision.configId, value, 'desired')
    this.host.log({
      scope: 'acp',
      level: 'warn',
      message: 'Skipping a remembered config option the current model does not accept',
      data: {
        providerId: this.providerId,
        configId: decision.configId,
        value,
        reason: decision.decision,
      },
    })
    return false
  }

  /** The one write that refreshes the cache, because its response is the only
   * read-back path the agents offer: `session/set_config_option` returns the
   * full `configOptions` array with `currentValue`, while `session/set_model`
   * returns `{}`. A failure leaves the cache untouched on purpose — recording
   * a value we merely asked for would let the next message skip the write and
   * prompt against unverified state. */
  private async writeConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    try {
      const params =
        typeof value === 'boolean'
          ? { sessionId, configId, type: 'boolean' as const, value }
          : { sessionId, configId, value }
      const response = await this.rpc(
        'session/set_config_option',
        this.timeouts.controlRequestMs,
        this.connection().setSessionConfigOption(params),
      )
      const configOptions = response.configOptions as SessionConfigOption[]
      this.appliedCache.refresh(configOptions, 'session/set_config_option')
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'config_option_update', { configOptions }),
      )
    } catch (error) {
      this.forgetAppliedStateOnTimeout('session/set_config_option', error)
      throw this.rpcError(sessionId, 'session/set_config_option', error)
    }
  }

  /** A control RPC that reported an error changed nothing, so the cache is
   * still true and the next attempt simply retries. A control RPC that never
   * *answered* is a different animal: `withTimeout` cannot withdraw an ACP
   * request, so the write may still be applied by the agent seconds after we
   * gave up on it. The agent's real state is then unknown, and unknown is the
   * one thing the cache must never confuse with known — a stale
   * `currentValue` left skip-eligible is exactly how a prompt ends up
   * dispatching on a model nobody selected.
   *
   * So model it as unknown and drop everything. The cost is that the next
   * reconcile writes blindly (the old preamble: correct, just slower) until a
   * wire response reseeds the cache, which the first successful
   * `set_config_option` does. The alternative — killing the runtime — would
   * destroy a turn that may be streaming on another caller's behalf, since a
   * config write and a turn deliberately do not block each other once the
   * prompt has been dispatched. */
  private forgetAppliedStateOnTimeout(method: string, error: unknown): void {
    if (!(error instanceof RpcTimeoutError)) return
    this.appliedCache.invalidate()
    this.host.log({
      scope: 'acp',
      level: 'warn',
      message: 'Discarding applied config state: a config write timed out and may still land',
      data: { providerId: this.providerId, method, timeoutMs: error.timeoutMs },
    })
  }

  /** `session/set_model` costs ~2.9s on Cursor even when setting the identical
   * value and answers `{}`, so nothing can be cached and every call is sent.
   * Only agents that advertise no `category: 'model'` option come here
   * (OpenCode, at 16ms). */
  private async legacySetModel(sessionId: string, modelId: string): Promise<void> {
    try {
      await this.rpc(
        'session/set_model',
        this.timeouts.controlRequestMs,
        this.connection().request('session/set_model', { sessionId, modelId }),
      )
    } catch (error) {
      this.forgetAppliedStateOnTimeout('session/set_model', error)
      throw this.rpcError(sessionId, 'session/set_model', error)
    }
    this.emit(
      routeEvent(
        this.route(),
        sessionId,
        'session',
        'current_model_update',
        normalizeModelListing({ currentModelId: modelId }),
      ),
    )
  }

  /** `session/set_mode` reads nothing back either; see `legacySetModel`. */
  private async legacySetMode(sessionId: string, modeId: string): Promise<void> {
    try {
      await this.rpc(
        'session/set_mode',
        this.timeouts.controlRequestMs,
        this.connection().setSessionMode({ sessionId, modeId }),
      )
    } catch (error) {
      this.forgetAppliedStateOnTimeout('session/set_mode', error)
      throw this.rpcError(sessionId, 'session/set_mode', error)
    }
  }

  private rejected(
    sessionId: string,
    reason: 'unsupported' | 'invalid',
    configId: string,
    value: string | boolean,
    intent: 'explicit' | 'desired',
  ): Error {
    const message =
      reason === 'unsupported'
        ? `${this.providerId} does not expose config option ${configId} for the current model`
        : `${this.providerId} does not advertise value ${String(value)} for config option ${configId}`
    return this.rpcError(sessionId, `session/set_config_option (${intent})`, new Error(message))
  }

  private emitConfigOptions(sessionId: string): void {
    this.emit(
      routeEvent(this.route(), sessionId, 'session', 'config_option_update', {
        configOptions: this.configOptions(),
      }),
    )
  }
  private emitModel(sessionId: string, modelId: string): void {
    this.emit(
      routeEvent(
        this.route(),
        sessionId,
        'session',
        'current_model_update',
        modelListingFromConfig(this.configOptions()) ??
          normalizeModelListing({ currentModelId: modelId }),
      ),
    )
  }
  private emitMode(sessionId: string, modeId: string): void {
    this.emit(
      routeEvent(
        this.route(),
        sessionId,
        'session',
        'current_mode_update',
        modeListingFromConfig(this.configOptions()) ??
          normalizeModeListing({ currentModeId: modeId }),
      ),
    )
  }

  // ------------------------------------------------------------------ replies

  respondPermission(requestId: string, outcome: PermissionOutcome): boolean {
    return this.permissions.respond(requestId, outcome)
  }
  respondExtension(requestId: string, response: unknown): boolean {
    return this.extensionRequests.respond(requestId, response)
  }
  respondQuestion(requestId: string, outcome: QuestionOutcome): boolean {
    const context = this.questionContexts.get(requestId)
    if (!context) return false
    if ('native' in context) return this.extensionRequests.respond(requestId, outcome)
    if ('elicitation' in context)
      return this.extensionRequests.respond(requestId, context.elicitation.respond(outcome))
    if ('plan' in context) return false
    return this.extensionRequests.respond(
      requestId,
      context.adapter.respond(outcome, context.params),
    )
  }
  respondPlan(requestId: string, outcome: PlanReviewOutcome): boolean {
    const context = this.questionContexts.get(requestId)
    if (!context || !('plan' in context)) return false
    return this.extensionRequests.respond(requestId, context.plan.respond(outcome, context.params))
  }

  // ------------------------------------------------------------------ inbound

  private async permissionRequest(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    this.logInbound('session/request_permission', params)
    const sessionId = sessionIdOf(params)
    if (!sessionId || sessionId !== this.sessionIdValue) return { outcome: { outcome: 'cancelled' } }
    const p = object(params)
    const requestId = crypto.randomUUID()
    const tool = object(p.toolCall)
    const options: PermissionOption[] = (Array.isArray(p.options) ? p.options : []).map((v) => {
      const o = object(v)
      return {
        optionId: string(o.optionId) ?? '',
        name: string(o.name) ?? '',
        kind: (string(o.kind) ?? 'reject_once') as PermissionOption['kind'],
      }
    })
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    this.emit(
      routeEvent(this.route(), sessionId, 'permission', 'permission_request', {
        requestId,
        sessionId,
        toolCall: {
          toolCallId: string(tool.toolCallId) ?? '',
          title: string(tool.title) ?? '',
          kind: string(tool.kind),
          rawInput: tool.rawInput,
        },
        options,
        expiresAt,
      }),
    )
    return new Promise((resolve) =>
      this.permissions.add(requestId, {
        providerId: this.providerId,
        threadId: this.threadIdValue,
        workspaceId: this.workspaceIdValue,
        sessionId,
        options,
        resolve,
      }),
    )
  }

  private async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.logInbound('session/update', params)
    const p = object(params)
    const sessionId = string(p.sessionId)
    if (!sessionId || sessionId !== this.sessionIdValue) {
      this.host.log({
        scope: 'acp',
        level: 'warn',
        message: 'Dropping update for unknown ACP session',
        data: { sessionId },
      })
      return
    }
    const update = object(p.update)
    const cursor = string(update.resumeCursor) ?? string(object(update._meta).cursor)
    if (cursor) this.resumeCursorValue = cursor
    const kind = string(update.sessionUpdate)
    if (
      kind === 'user_message_chunk' ||
      kind === 'agent_message_chunk' ||
      kind === 'agent_thought_chunk'
    ) {
      this.emit(
        routeEvent(this.route(), sessionId, 'stream', kind, {
          messageId: string(update.messageId),
          content: contentBlock(update.content),
        }),
      )
      return
    }
    if (kind === 'tool_call') {
      const tool: ToolCall = {
        toolCallId: string(update.toolCallId) ?? '',
        title: string(update.title) ?? '',
        kind: update.kind as ToolCall['kind'],
        status: update.status as ToolCall['status'],
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: Array.isArray(update.content) ? update.content.map(toolContent) : undefined,
        locations: update.locations as ToolCall['locations'],
        metadata: update._meta as ToolCall['metadata'],
      }
      const subtask = this.subtaskFromTool(tool, 'call')
      this.emit(
        subtask
          ? routeEvent(this.route(), sessionId, 'session', 'subtask_update', subtask)
          : routeEvent(this.route(), sessionId, 'tool', 'tool_call', tool),
      )
      return
    }
    if (kind === 'tool_call_update') {
      const tool: ToolCallUpdate = {
        toolCallId: string(update.toolCallId) ?? '',
        title: string(update.title),
        kind: update.kind as ToolCallUpdate['kind'],
        status: update.status as ToolCallUpdate['status'],
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: Array.isArray(update.content) ? update.content.map(toolContent) : [],
        locations: update.locations as ToolCallUpdate['locations'],
        metadata: update._meta as ToolCallUpdate['metadata'],
      }
      const subtask = this.subtaskFromTool(tool, 'update')
      this.emit(
        subtask
          ? routeEvent(this.route(), sessionId, 'session', 'subtask_update', subtask)
          : routeEvent(this.route(), sessionId, 'tool', 'tool_call_update', tool),
      )
      return
    }
    if (kind === 'plan') {
      if (this.config.quirks.suppressPlanUpdates) {
        /* OpenCode does not expose enough stable tool metadata to identify todo mirrors reliably, so the conservative documented fallback is to suppress every plan update. */ return
      }
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'plan_update', {
          entries: update.entries ?? [],
          explanation: update.explanation,
        }),
      )
      return
    }
    if (kind === 'available_commands_update') {
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'available_commands_update', {
          availableCommands: update.availableCommands ?? [],
        }),
      )
      return
    }
    if (kind === 'current_mode_update') {
      const modes = normalizeModeListing(
        update.modes ?? {
          currentModeId: update.currentModeId,
          availableModes: update.availableModes,
        },
      )
      this.noteExternalChange(this.appliedCache.modeConfigId, modes.currentModeId)
      this.emit(routeEvent(this.route(), sessionId, 'session', 'current_mode_update', modes))
      return
    }
    if (kind === 'current_model_update') {
      const models = normalizeModelListing(
        update.models ?? {
          currentModelId: update.currentModelId,
          availableModels: update.availableModels,
        },
      )
      this.noteExternalChange(this.appliedCache.modelConfigId, models.currentModelId)
      this.emit(routeEvent(this.route(), sessionId, 'session', 'current_model_update', models))
      return
    }
    if (kind === 'config_option_update') {
      const configOptions = (update.configOptions ?? []) as SessionConfigOption[]
      this.appliedCache.refresh(configOptions, 'config_option_update')
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'config_option_update', { configOptions }),
      )
      return
    }
    if (kind === 'session_info_update') {
      const title = string(update.title)?.trim()
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'session_info_update', {
          title: title ?? null,
          updatedAt: string(update.updatedAt) ?? null,
        }),
      )
      if (title)
        this.host.onSessionTitle?.({
          threadId: this.threadIdValue,
          workspaceId: this.workspaceIdValue,
          title,
        })
      return
    }
    if (kind === 'usage_update') {
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'usage_update', {
          used: number(update.used) ?? 0,
          size: number(update.size) ?? 0,
          cost: update.cost,
        }),
      )
      return
    }
    this.emit(
      routeEvent(this.route(), sessionId, 'error', 'rpc_error', {
        source: 'session/update',
        message: `Unknown session update: ${kind ?? 'missing'}`,
        details: update,
      }),
    )
  }

  /** Route a tool call through the provider's subtask classifier. A claimed
   * toolCallId never emits raw tool events again: if the adapter passes on a
   * later update we synthesize a status-only SubtaskUpdate to keep the part
   * consistent. */
  private subtaskFromTool(
    tool: ToolCall | ToolCallUpdate,
    phase: 'call' | 'update',
  ): SubtaskUpdate | undefined {
    const fromToolCall = this.config.subtasks?.fromToolCall
    if (!fromToolCall || !tool.toolCallId) return undefined
    const tracked = this.subtaskToolIds.has(tool.toolCallId)
    const update = fromToolCall(tool, { phase, tracked })
    if (update) {
      this.subtaskToolIds.add(tool.toolCallId)
      return update.status
        ? { ...update, statusSource: update.statusSource ?? 'task_event' }
        : update
    }
    if (!tracked) return undefined
    const status = subtaskStatusFromTool(tool.status)
    return {
      taskId: tool.toolCallId,
      ...(status ? { status, statusSource: 'task_event' as const } : {}),
    }
  }

  /** Cursor extension params often omit sessionId entirely. A process owning
   * exactly one session has an unambiguous correlation target, so the
   * sole-session fallback is always right — which is what let Phase 1 delete
   * the `correlateSessionlessExtensionsToActivePrompt` quirk and, with it, the
   * app-wide serialisation of Cursor prompts. */
  private routable(params: unknown): boolean {
    const sessionId = sessionIdOf(params)
    if (sessionId) return sessionId === this.sessionIdValue
    return this.sessionIdValue !== undefined
  }

  private async elicitationRequest(
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    this.logInbound(ACP_ELICITATION_METHOD, params)
    const sessionId = this.routable(params) ? this.sessionIdValue : undefined
    const adapter = parseAcpFormElicitation(params)
    if (!sessionId || !adapter) {
      this.host.log({
        scope: 'acp',
        level: 'warn',
        message: 'Declining unsupported or unrouteable ACP elicitation',
        data: { providerId: this.providerId, mode: string(object(params).mode) },
      })
      return { action: 'cancel' }
    }

    const requestId = crypto.randomUUID()
    this.questionContexts.set(requestId, { elicitation: adapter })
    const response = this.awaitDeferred(requestId, sessionId, ACP_ELICITATION_METHOD)
    this.emit(
      routeEvent(this.route(), sessionId, 'session', 'question_request', {
        requestId,
        sessionId,
        title: adapter.title,
        questions: adapter.questions,
      }),
    )
    const outcome = await response
    return outcome.outcome === 'responded'
      ? (outcome.response as acp.CreateElicitationResponse)
      : { action: 'cancel' }
  }

  private async extensionRequest(
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    this.logInbound(method, params)
    const sessionId = this.routable(params) ? this.sessionIdValue : undefined
    const requestId = crypto.randomUUID()
    const subtaskParser = this.config.subtasks?.fromExtension?.[method]
    if (subtaskParser && sessionId) {
      const parsed = subtaskParser(params)
      if (parsed) {
        this.emit(routeEvent(this.route(), sessionId, 'session', 'subtask_update', parsed))
        // Metadata-bearing requests (cursor/task) block the provider's turn;
        // ack immediately, there is nothing to review.
        return {}
      }
    }
    const planSnapshot = this.extensions.planSnapshot(method)
    if (planSnapshot && sessionId) {
      const snapshot = planSnapshot(params)
      if (snapshot) {
        const merged = this.mergePlanTodos(snapshot)
        this.emit(
          routeEvent(this.route(), sessionId, 'session', 'plan_update', {
            entries: this.planEntries(merged),
          }),
        )
        // Snapshot requests are acked immediately; the bridge discards the
        // response and they never ride the extension broker.
        return {}
      }
    }
    const planAdapter = this.extensions.planAdapter(method)
    const parsedPlan = planAdapter && sessionId ? planAdapter.parse(params) : undefined
    if (sessionId && planAdapter && parsedPlan) {
      this.questionContexts.set(requestId, { plan: planAdapter, params })
      // Register the broker before the review request reaches UI listeners so a
      // fast local renderer cannot answer before respondPlan has anything to settle.
      const outcomePromise = this.awaitDeferred(
        requestId,
        sessionId,
        method,
        PLAN_REVIEW_TIMEOUT_MS,
      )
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'plan_review_request', {
          ...parsedPlan,
          requestId,
          sessionId,
        }),
      )
      const outcome = await outcomePromise
      if (outcome.outcome === 'responded') return object(outcome.response)
      // Cancelled/timed out: the registry default maps to "User cancelled".
      return object(await this.extensions.request(method, params))
    }
    const adapter = this.extensions.questionAdapter(method)
    const parsed = adapter && sessionId ? adapter.parse(params) : undefined
    if (sessionId && adapter && parsed) {
      this.questionContexts.set(requestId, { adapter, params })
      // The broker must exist before UI listeners see the request; a fast local
      // renderer can otherwise answer before respondQuestion has anything to settle.
      const outcomePromise = this.awaitDeferred(requestId, sessionId, method)
      this.emit(
        routeEvent(this.route(), sessionId, 'session', 'question_request', {
          requestId,
          sessionId,
          title: parsed.title,
          questions: parsed.questions,
        }),
      )
      const outcome = await outcomePromise
      if (outcome.outcome === 'responded') return object(outcome.response)
      return object(await this.extensions.request(method, params))
    }
    if (sessionId)
      this.emit(
        routeEvent(this.route(), sessionId, 'extension', 'extension_request', {
          requestId,
          method,
          params,
        }),
      )
    if (sessionId && this.extensions.isDeferred(method)) {
      const outcome = await this.awaitDeferred(requestId, sessionId, method)
      if (outcome.outcome === 'responded') return object(outcome.response)
      // Cancelled/timed out: fall back to the provider's static response.
      return object(await this.extensions.request(method, params))
    }
    const response = object(await this.extensions.request(method, params))
    if (sessionId)
      this.emit(
        routeEvent(this.route(), sessionId, 'extension', 'extension_resolved', {
          requestId,
          method,
          outcome: { outcome: 'responded', response },
        }),
      )
    return response
  }

  private async extensionNotification(method: string, params: unknown): Promise<void> {
    this.logInbound(method, params)
    // Sessionless notifications (e.g. cursor/*) fall back to this runtime's
    // sole session like requests do, instead of being silently dropped.
    const sessionId = this.routable(params) ? this.sessionIdValue : undefined
    const subtaskParser = this.config.subtasks?.fromExtension?.[method]
    if (subtaskParser && sessionId) {
      const parsed = subtaskParser(params)
      if (parsed) {
        this.emit(routeEvent(this.route(), sessionId, 'session', 'subtask_update', parsed))
        return
      }
    }
    if (sessionId)
      this.emit(
        routeEvent(this.route(), sessionId, 'extension', 'extension_notification', {
          method,
          params,
        }),
      )
    await this.extensions.notification(method, params)
  }

  private async nativeQuestionRequest(request: OpenCodeQuestionRequest): Promise<void> {
    const nativeQuestions = this.nativeQuestions
    if (request.sessionId !== this.sessionIdValue || !nativeQuestions) {
      this.host.log({
        scope: 'acp',
        level: 'warn',
        message: 'Rejecting question for an unknown OpenCode ACP session',
        data: { sessionId: request.sessionId, requestId: request.requestId },
      })
      await nativeQuestions?.respond(request.requestId, {
        outcome: 'cancelled',
        reason: 'session_closed',
      })
      return
    }
    const requestId = `opencode:${request.requestId}`
    if (this.questionContexts.has(requestId)) return
    this.questionContexts.set(requestId, { native: request.requestId })
    const outcomePromise = this.awaitDeferred(requestId, request.sessionId, 'opencode/question')
    this.emit(
      routeEvent(this.route(), request.sessionId, 'session', 'question_request', {
        requestId,
        sessionId: request.sessionId,
        title: request.title,
        questions: request.questions,
      }),
    )
    const outcome = await outcomePromise
    if (outcome.outcome === 'cancelled' && outcome.reason !== 'timeout') return
    const responseOutcome: QuestionOutcome =
      outcome.outcome === 'responded'
        ? (outcome.response as QuestionOutcome)
        : { outcome: 'cancelled', reason: outcome.reason }
    await nativeQuestions.respond(request.requestId, responseOutcome)
  }

  /** Park a request on the app-wide extension broker until the UI answers it.
   * The question context is dropped here rather than in the broker's settle
   * hook, because the broker is shared by every runtime. */
  private awaitDeferred(
    requestId: string,
    sessionId: string,
    method: string,
    timeoutMs?: number,
  ): Promise<ExtensionOutcome> {
    return new Promise<ExtensionOutcome>((resolve) =>
      this.extensionRequests.add(
        requestId,
        {
          providerId: this.providerId,
          threadId: this.threadIdValue,
          workspaceId: this.workspaceIdValue,
          sessionId,
          method,
          resolve,
        },
        timeoutMs,
      ),
    ).finally(() => this.questionContexts.delete(requestId))
  }

  private mergePlanTodos(snapshot: PlanSnapshot): PlanTodo[] {
    if (!snapshot.merge) {
      this.lastPlanTodos = snapshot.todos
      return snapshot.todos
    }
    const incoming = new Map(snapshot.todos.map((todo) => [todo.id, todo]))
    const seen = new Set<string>()
    const merged: PlanTodo[] = []
    for (const todo of this.lastPlanTodos) {
      merged.push(incoming.get(todo.id) ?? todo)
      seen.add(todo.id)
    }
    for (const todo of snapshot.todos) if (!seen.has(todo.id)) merged.push(todo)
    this.lastPlanTodos = merged
    return merged
  }

  private planEntries(todos: readonly PlanTodo[]): PlanEntry[] {
    return todos.flatMap((todo) => {
      if (todo.status === 'cancelled') return []
      const status =
        todo.status === 'in_progress'
          ? 'in_progress'
          : todo.status === 'completed'
            ? 'completed'
            : 'pending'
      return [{ content: todo.content, priority: 'medium' as const, status }]
    })
  }

  // ------------------------------------------------------------------ helpers

  private route(): BackendRoute {
    return { threadId: this.threadIdValue, workspaceId: this.workspaceIdValue }
  }
  private emit(event: BackendEvent): void {
    for (const listener of this.listeners) listener(event)
  }
  private logInbound(method: string, data: unknown): void {
    this.host.log({ scope: 'acp', level: 'info', message: `[event] <- ${method}`, data })
  }
  private connection(): acp.ClientSideConnection {
    if (!this.transport) throw new Error(`ACP runtime unavailable for ${this.providerId}`)
    return this.transport.connection
  }
  /** Bound one RPC. `AcpBackend` enforced none of these: an agent that
   * accepted a request and never answered hung its caller forever, and a
   * hung `set_config_option` hangs the *prompt* behind it, because
   * `ensureSession` reconciles config before prompting. `session/prompt` is
   * the deliberate exception and never comes through here. */
  private rpc<T>(method: string, timeoutMs: number, work: Promise<T>): Promise<T> {
    return withTimeout(
      work,
      timeoutMs,
      () => new RpcTimeoutError(this.providerId, method, timeoutMs),
    )
  }
  private configOptions(): SessionConfigOption[] {
    return [...(this.appliedCache.state?.options.values() ?? [])]
  }
  /** Start if necessary and return this runtime's session id. Config writes
   * issued from `bootstrap` must not re-enter `start`, so an existing session
   * short-circuits. */
  private async ready(): Promise<string> {
    if (this.sessionIdValue) return this.sessionIdValue
    const result = await this.start()
    return result.sessionId
  }
  private pickAuthMethod(methods: AuthMethod[]): string | undefined {
    for (const hint of this.config.auth.methodHints) {
      const match =
        methods.find((m) => m.id === hint) ??
        methods.find((m) => m.id.toLowerCase().includes(hint.toLowerCase()))
      if (match) return match.id
    }
    return methods[0]?.id
  }
  private authRequired(methods: AuthMethod[] | undefined, message: string): AuthRequiredError {
    this.emit(
      routeEvent(this.route(), undefined, 'error', 'auth_required', {
        message,
        authMethods: methods,
        loginHint: this.config.auth.loginInstruction,
      }),
    )
    return new AuthRequiredError(this.providerId, message, this.config.auth.loginInstruction)
  }
  private rpcError(sessionId: string | undefined, source: string, error: unknown): Error {
    if (isAuthRequired(error)) return this.authRequired(undefined, errorMessage(error))
    this.emit(
      routeEvent(this.route(), sessionId, 'error', 'rpc_error', {
        source,
        message: errorMessage(error),
        code: errorCode(error),
        details: object(error).data,
      }),
    )
    return error instanceof Error ? error : new Error(errorMessage(error))
  }
}

/** Cursor exposes some booleans as `"true"`/`"false"` selects, so a notified
 * current value arrives as a string whichever shape the option has. */
function withCurrentValue(option: SessionConfigOption, value: string): SessionConfigOption {
  if (option.type === 'boolean') return { ...option, currentValue: value === 'true' }
  return { ...option, currentValue: value }
}

/** `process.env` merged with the provider's overrides, minus the undefined
 * entries `Record<string, string>` does not allow. */
function environment(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return { ...env, ...overrides }
}

export type AcpSessionRuntimeFactoryDeps = {
  configs: Readonly<Record<ProviderId, ProviderConfig>>
  host: Pick<HostDeps, 'log' | 'onSessionTitle'>
  permissions: PermissionBroker
  extensions: ExtensionBroker
  connections: AcpConnectionFactory
  timeouts?: Partial<RuntimeTimeouts>
}

export class AcpSessionRuntimeFactory implements ManagedSessionRuntimeFactory {
  constructor(private readonly deps: AcpSessionRuntimeFactoryDeps) {}

  create(spec: SessionRuntimeSpec): ManagedSessionRuntime {
    const config = this.deps.configs[spec.providerId]
    if (!config) throw new Error(`Unknown provider: ${spec.providerId}`)
    return new AcpSessionRuntimeImpl(spec, {
      config,
      host: this.deps.host,
      permissions: this.deps.permissions,
      extensions: this.deps.extensions,
      connections: this.deps.connections,
      ...(this.deps.timeouts ? { timeouts: this.deps.timeouts } : {}),
    })
  }
}
