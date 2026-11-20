import { randomUUID } from 'node:crypto'
import type {
  ModelListing,
  PermissionOutcome,
  PlanReviewOutcome,
  PromptCapabilities,
  PromptInput,
  ProviderId,
  ProviderSessionInfo,
  QuestionOutcome,
} from '@agentpack/contract'
import type { v2 } from '@openmanager/codex-app-server-protocol'
import type { BackendEvent, BackendEventListener, BackendRoute, SessionResult } from '../../backends/Backend.js'
import { CapabilityMissingError, SessionUnknownError } from '../../core/errors.js'
import type { InteractionBroker } from '../../core/InteractionBroker.js'
import type { PermissionBroker } from '../../core/PermissionBroker.js'
import type { HostDeps } from '../../host.js'
import type { CodexProviderConfig } from '../../providers/index.js'
import type { AppliedSessionState } from '../AppliedConfigCache.js'
import type { ManagedSessionRuntime } from '../AcpSessionRuntimeImpl.js'
import { DEFAULT_RUNTIME_TIMEOUTS, type RuntimeTimeouts } from '../constants.js'
import type {
  DesiredSessionConfig,
  ProcessExit,
  SessionRuntimeExit,
  SessionRuntimePhase,
  TerminationRequest,
  ThreadId,
} from '../lifecycle.js'
import type { SessionRuntimeSpec } from '../SessionRuntime.js'
import { routeEvent } from '../wire.js'
import { codexAccess, defaultCodexAccessPreset, type CodexAccess } from './codex-access.js'
import { codexModelListing, readCodexModels } from './codex-catalog.js'
import {
  codexNotificationScope,
  CodexSubagents,
  isCodexCollabItem,
  isCodexSubagentThread,
  type CodexSubagentOutput,
} from './codex-subagents.js'
import { CodexTurn, type CodexTurnOutput } from './codex-turn.js'
import type { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexConnectionClosedError, CodexRpcError } from './CodexRpcPeer.js'
import { startRealCodex, type CodexStarter } from './start.js'

export const CODEX_PROMPT_CAPABILITIES: PromptCapabilities = { image: true }

/** Settings every thread gets on top of the user's own `~/.codex`
 * (docs/decisions/codex-app-server.md, "The user's Codex home"): their
 * `notify` program would fire for every turn we run, doubling openmanager's
 * own notifications. */
const THREAD_CONFIG = { notify: [] as string[] }

/** How long a stop keeps interrupting subagents. Interrupting the parent's
 * turn leaves its children running (probed on 0.170), and a child spawned
 * just before the stop announces itself after it, so the stop looks again
 * until none is running or this runs out. */
export const CODEX_SUBAGENT_STOP_MS = 10_000

export type CodexSessionRuntimeDeps = {
  config: CodexProviderConfig
  host: Pick<HostDeps, 'log'>
  permissions: PermissionBroker
  interactions: InteractionBroker
  /** Starts the app-server. The real binary when absent. */
  start?: CodexStarter
  timeouts?: Partial<RuntimeTimeouts>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** `CODEX_SUBAGENT_STOP_MS` when absent. */
  subagentStopMs?: number
}

type ActiveTurn = {
  turn: CodexTurn
  resolve: () => void
  reject: (error: unknown) => void
  done: Promise<void>
  settled: boolean
}

/** One Codex thread in its own `codex app-server` process
 * (docs/decisions/codex-app-server.md, "One app-server per session").
 *
 * The openmanager session id *is* the Codex thread id: durable, persisted by
 * the server as `provider_session_id`, and what `thread/resume` takes back.
 *
 * Covered here: start and resume, prompts that resolve on the turn's own
 * `turn/completed`, assistant text and reasoning summaries, usage, interrupt,
 * subagents (child threads on this connection, kept apart by
 * `CodexSubagents` and stopped with the parent), and exit. Tool items, approvals and questions are later changes; until
 * approvals exist, every approval Codex asks for is declined, so nothing runs
 * outside the sandbox without a person having said yes. */
export class CodexSessionRuntime implements ManagedSessionRuntime {
  readonly providerId: ProviderId
  readonly cwd: string
  readonly exited: Promise<SessionRuntimeExit>
  readonly listSessionsAdvertised = false

  private threadIdValue: ThreadId
  private workspaceIdValue: string | undefined
  private phaseValue: SessionRuntimePhase = 'created'
  private client: CodexAppServerClient | undefined
  private sessionIdValue: string | undefined
  private startPromise: Promise<SessionResult> | undefined
  private startResult: SessionResult | undefined
  private active: ActiveTurn | undefined
  private exitValue: SessionRuntimeExit | undefined
  private resolveExited!: (exit: SessionRuntimeExit) => void
  private stopRequest: TerminationRequest | undefined
  private spawned = false
  private readonly listeners = new Set<BackendEventListener>()
  private readonly exitListeners = new Set<(exit: SessionRuntimeExit) => void>()
  private readonly timeouts: RuntimeTimeouts
  private readonly access: CodexAccess
  private models: ModelListing | undefined
  /** The model the next turn runs on: what the user picked, else Codex's. */
  private modelId: string | undefined
  private appliedAt: string | undefined
  /** Turns this runtime already finished, including one it closed itself
   * after an interrupt timed out. Anything Codex later says about them (its
   * own late `turn/completed`) must never be taken for the next turn's. */
  private readonly finishedTurnIds = new Set<string>()
  /** The thread's cumulative token counts before the turn in flight, so a
   * turn reports its own usage rather than the last model request's. */
  private tokenBaseline: v2.TokenUsageBreakdown | undefined
  /** The session's subagents: child threads whose stream arrives on this
   * connection and is kept out of this thread's. */
  private readonly subagents = new CodexSubagents(
    () => this.sessionIdValue,
    () => this.active !== undefined,
    (output) => this.emitSubagentOutput(output),
  )
  /** Bumped by every prompt and stop, so a stop still sweeping subagents
   * leaves alone the children of a turn that started after it. */
  private stopGeneration = 0
  /** Notifications that are nobody's: for a thread that is neither ours nor
   * a known child, or thread-scoped and naming no thread. Counted, logged
   * once, and never applied to this thread. */
  private dropped = 0

  constructor(
    private readonly spec: SessionRuntimeSpec,
    private readonly deps: CodexSessionRuntimeDeps,
  ) {
    this.providerId = spec.providerId
    this.cwd = spec.cwd
    this.threadIdValue = spec.threadId
    this.workspaceIdValue = spec.workspaceId
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
    this.access = codexAccess(defaultCodexAccessPreset(deps.platform))
    this.exited = new Promise((resolve) => {
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
  get exit(): SessionRuntimeExit | undefined {
    return this.exitValue
  }
  /** Codex resumes by thread id alone. */
  get resumeCursor(): string | undefined {
    return undefined
  }
  /** Running subagents live in this process: reaping or evicting it would
   * kill them (docs/decisions/codex-app-server.md, "Children count"). */
  get busy(): boolean {
    return this.subagents.running
  }

  /** What was last written, never a guess: undefined until a model has been
   * chosen explicitly. */
  get applied(): AppliedSessionState | undefined {
    if (!this.appliedAt || this.modelId === undefined) return undefined
    return {
      modelConfigId: 'model',
      options: new Map([
        [
          'model',
          {
            type: 'select',
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: this.modelId,
            options: [],
          },
        ],
      ]),
      refreshedAt: this.appliedAt,
      source: 'write_through',
    }
  }

  rebindThread(threadId: ThreadId, workspaceId: string | undefined): void {
    const from = this.threadIdValue
    this.threadIdValue = threadId
    if (workspaceId !== undefined) this.workspaceIdValue = workspaceId
    if (from === threadId) return
    this.deps.permissions.rekeyThread(this.providerId, from, threadId, this.workspaceIdValue)
    this.deps.interactions.rekeyThread(this.providerId, from, threadId, this.workspaceIdValue)
  }

  // ---------------------------------------------------------------------------
  // Start

  start(): Promise<SessionResult> {
    if (this.phaseValue === 'stopping' || this.phaseValue === 'exited')
      return Promise.reject(new Error('Codex session runtime has exited'))
    if (this.startResult) return Promise.resolve({ ...this.startResult, state: 'reused' })
    this.startPromise ??= this.bootstrap().then(
      (result) => {
        this.startResult = result
        // A stop that landed while the start was finishing wins: the phase
        // must not go back from `stopping` to `ready`.
        if (this.exitValue || this.stopRequest)
          throw new Error('codex app-server exited during startup')
        this.phaseValue = 'ready'
        return result
      },
      async (error: unknown) => {
        // The process died on its own: that is a crash, and its exit says so.
        // Calling `stop` here would relabel it as an expected shutdown.
        if (error instanceof CodexConnectionClosedError && this.client) await this.exited
        else await this.stop({ reason: 'start_failed' })
        throw error
      },
    )
    return this.startPromise
  }

  private async bootstrap(): Promise<SessionResult> {
    this.phaseValue = 'starting'
    const client = await (this.deps.start ?? startRealCodex)({
      cwd: this.cwd,
      env: this.deps.env ?? process.env,
      timeouts: this.timeouts,
      log: this.deps.host.log,
    })
    if (this.stopRequest || this.exitValue) {
      // Stopped while the process was still starting (a session deleted or
      // moved mid-start, app shutdown): nobody will ever stop this one if we
      // don't, so it goes now.
      await client.terminate(this.stopRequest ?? { reason: 'disposed' }).catch(() => undefined)
      throw new Error('Codex session runtime was stopped while starting')
    }
    this.client = client
    this.spawned = true
    void client.exited.then((exit) => this.settleExit(exit))
    client.onAny((message) => this.onNotification(message.method, message.params))
    this.installServerRequestHandlers(client)

    const catalog = readCodexModels(client)
    catalog.catch(() => undefined)
    const opened = await this.openThread(client)
    // Known as soon as Codex names it, so this thread's own notifications are
    // never mistaken for another's while the catalog is still on its way.
    this.sessionIdValue = opened.threadId
    this.models = codexModelListing(await catalog)
    this.modelId ??= opened.model
    if (this.exitValue || this.stopRequest) throw new Error('Codex session runtime stopped while starting')

    const info = client.info
    const agentInfo = {
      name: 'Codex',
      ...(info?.version.version ? { version: info.version.version } : {}),
    }
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'process_spawned', {
        cwd: this.cwd,
        command: 'codex',
        args: ['app-server'],
        ...(client.pid !== undefined ? { processId: client.pid } : {}),
      }),
    )
    this.emit(
      routeEvent(this.route(), undefined, 'lifecycle', 'initialized', {
        agentInfo,
        capabilities: this.deps.config.capabilities,
        promptCapabilities: CODEX_PROMPT_CAPABILITIES,
        authMethods: [],
      }),
    )
    this.emit(
      routeEvent(
        this.route(),
        opened.threadId,
        'lifecycle',
        opened.state === 'loaded' ? 'session_loaded' : 'session_created',
        { models: { ...this.models, ...(opened.model ? { currentModelId: opened.model } : {}) } },
      ),
    )
    return { sessionId: opened.threadId, state: opened.state }
  }

  /** `thread/resume` for a stored thread, `thread/start` otherwise. A thread
   * Codex no longer has falls back to a fresh one, unless the caller requires
   * the old one (`load: 'require'`). */
  private async openThread(
    client: CodexAppServerClient,
  ): Promise<{ threadId: string; model: string | undefined; state: 'created' | 'loaded' }> {
    const settings = {
      cwd: this.cwd,
      approvalPolicy: this.access.approvalPolicy,
      approvalsReviewer: this.access.approvalsReviewer,
      sandbox: this.access.sandbox,
      config: THREAD_CONFIG,
      ...(this.spec.desiredConfig?.modelId ? { model: this.spec.desiredConfig.modelId } : {}),
    }
    const existing = this.spec.sessionId
    if (existing) {
      try {
        const resumed = await client.request(
          'thread/resume',
          { ...settings, threadId: existing, excludeTurns: true },
          { timeoutMs: this.timeouts.loadSessionMs },
        )
        // A subagent's thread is its parent's, never a session of its own:
        // treated as one this session does not have.
        if (isCodexSubagentThread(resumed.thread)) {
          // Resuming subscribed this connection to it; let it go again.
          await this.unsubscribe(client, resumed.thread.id)
          throw new CodexSubagentThreadError(existing)
        }
        return { threadId: resumed.thread.id, model: resumed.model, state: 'loaded' }
      } catch (error) {
        if (!isMissingThread(error) && !(error instanceof CodexSubagentThreadError)) throw error
        if (this.spec.load === 'require') throw new SessionUnknownError(this.providerId, existing)
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Codex no longer has this thread; starting a fresh one',
          data: { threadId: existing, error: String(error) },
        })
      }
    } else if (this.spec.load === 'require') {
      throw new SessionUnknownError(this.providerId, undefined)
    }
    const started = await client.request(
      'thread/start',
      {
        ...settings,
        historyMode: 'paginated',
        ...(this.spec.instructions ? { developerInstructions: this.spec.instructions } : {}),
      },
      { timeoutMs: this.timeouts.newSessionMs },
    )
    return { threadId: started.thread.id, model: started.model, state: 'created' }
  }

  private async unsubscribe(client: CodexAppServerClient, threadId: string): Promise<void> {
    try {
      await client.request('thread/unsubscribe', { threadId }, { timeoutMs: this.timeouts.controlRequestMs })
    } catch (error) {
      this.deps.host.log({
        scope: 'codex',
        level: 'info',
        message: 'Codex refused to unsubscribe from a subagent thread',
        data: { threadId, error: errorMessage(error) },
      })
    }
  }

  /** Until approvals have a UI (CAL-258), every one is declined: nothing
   * leaves the sandbox without a person having said yes. */
  private installServerRequestHandlers(client: CodexAppServerClient): void {
    client.handle('item/commandExecution/requestApproval', () => ({ decision: 'decline' }), {
      immediate: true,
    })
    client.handle('item/fileChange/requestApproval', () => ({ decision: 'decline' }), {
      immediate: true,
    })
  }

  // ---------------------------------------------------------------------------
  // Turns

  async prompt(args: {
    prompt: PromptInput
    userMessageId?: string
    desiredConfig?: DesiredSessionConfig
  }): Promise<void> {
    await this.ready()
    if (this.active) throw new Error('A Codex turn is already running in this session')
    if (args.desiredConfig) await this.applyDesiredConfig(args.desiredConfig)
    const input = codexInput(args.prompt)
    this.assertUsable()
    const client = this.client!
    const threadId = this.sessionIdValue!
    const userMessageId = args.userMessageId ?? `agent_usr_${randomUUID()}`
    this.stopGeneration++

    this.emit(
      routeEvent(this.route(), threadId, 'lifecycle', 'prompt_started', {
        prompt: args.prompt.text,
        userMessageId,
        ...(args.prompt.attachments?.length ? { attachments: args.prompt.attachments } : {}),
      }),
    )
    const active = this.openTurn()
    try {
      // Every setting, every turn: overrides are sticky, so one left out is
      // whatever the last turn set, not the default.
      const response = await client.request(
        'turn/start',
        {
          threadId,
          input,
          clientUserMessageId: userMessageId,
          approvalPolicy: this.access.approvalPolicy,
          approvalsReviewer: this.access.approvalsReviewer,
          sandboxPolicy: this.access.sandboxPolicy,
          summary: 'detailed',
          ...(this.modelId ? { model: this.modelId } : {}),
        },
        { timeoutMs: this.timeouts.controlRequestMs },
      )
      // `turn/started` may have named it already.
      this.identifyTurn(active, response.turn.id)
      if (active.turn.interruptRequested) void this.sendInterrupt(active)
    } catch (error) {
      this.failTurn(active, error)
    }
    // The RPC only says the turn began; the turn ends on `turn/completed`.
    return active.done
  }

  private openTurn(): ActiveTurn {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const done = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const active: ActiveTurn = {
      turn: new CodexTurn((output) => this.emitTurnOutput(output), this.tokenBaseline),
      resolve,
      reject,
      done,
      settled: false,
    }
    // Nobody may be listening yet if the caller dropped the promise.
    done.catch(() => undefined)
    this.active = active
    return active
  }

  /** Stop: the turn in flight and every subagent turn, children included,
   * since interrupting a parent's turn leaves its children running. Never
   * starts a process to do it: with no live runtime there is nothing to stop.
   * Resolves once the parent's turn has ended and every running child has
   * been sent its interrupt; the host holds the session busy until then, so
   * the bounded look for late children carries on detached. */
  async cancel(): Promise<void> {
    if (this.exitValue || this.phaseValue !== 'ready') return
    this.deps.permissions.cancelThread(this.providerId, this.threadIdValue)
    this.deps.interactions.cancelThread(this.providerId, this.threadIdValue)
    // The parent's interrupt goes out first, then the children's.
    const turn = this.cancelTurn()
    this.sweepSubagents(++this.stopGeneration)
    await turn
  }

  private async cancelTurn(): Promise<void> {
    const active = this.active
    if (!active) return
    active.turn.interruptRequested = true
    // The grace starts now, not after `turn/interrupt` answers: Codex answers
    // it only once the turn has actually stopped, so waiting for the answer
    // first would add a whole control timeout on top of the grace.
    const grace = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.timeouts.interruptGraceMs)
      timer.unref?.()
    })
    if (active.turn.turnId) void this.sendInterrupt(active)
    const outcome = await Promise.race([active.done.then(() => 'done' as const, () => 'done' as const), grace])
    if (outcome === 'timeout' && !active.settled) {
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Codex did not finish an interrupted turn in time; closing it',
        data: { turnId: active.turn.turnId, graceMs: this.timeouts.interruptGraceMs },
      })
      this.completeTurn(active, 'cancelled')
    }
  }

  /** Sends the first round of interrupts now, and looks again detached. */
  private sweepSubagents(generation: number, under?: string): void {
    void this.stopSubagents(generation, under).catch((error: unknown) =>
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Stopping Codex subagents failed',
        data: { error: errorMessage(error) },
      }),
    )
  }

  /** Interrupt every running subagent turn, and keep looking for children
   * that start a turn late until none runs, the bound runs out or a new
   * prompt begins. A spawn the parent made just before the stop announces
   * its child after it, and only the parent's turn ending says no more can
   * come, so the parent's turn in flight keeps the stop looking too. `under`
   * limits it to one child and its own children. */
  private async stopSubagents(generation: number, under?: string): Promise<void> {
    const deadline = Date.now() + (this.deps.subagentStopMs ?? CODEX_SUBAGENT_STOP_MS)
    const sent = new Set<string>()
    const running = () =>
      under === undefined
        ? this.subagents.running || this.active !== undefined
        : this.subagents.runningWithin(under)
    while (!this.exitValue && generation === this.stopGeneration) {
      // The change this waits for may come while interrupts are being sent.
      const changed = this.subagents.changed()
      for (const { threadId, turnId } of this.subagents.activeTurns(under)) {
        const key = `${threadId}\n${turnId}`
        if (sent.has(key)) continue
        sent.add(key)
        void this.interruptThread(threadId, turnId)
      }
      if (!running()) return
      const left = deadline - Date.now()
      if (left <= 0) {
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Codex subagents were still running when the stop gave up on them',
          data: { boundMs: this.deps.subagentStopMs ?? CODEX_SUBAGENT_STOP_MS },
        })
        return
      }
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        changed,
        ...(under === undefined && this.active ? [this.active.done.catch(() => undefined)] : []),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left)
          timer.unref?.()
        }),
      ])
      clearTimeout(timer)
    }
  }

  /** A child's turn may end on its own before this lands; Codex then
   * refuses, which is not worth showing. */
  private async interruptThread(threadId: string, turnId: string): Promise<void> {
    if (!this.client) return
    try {
      await this.client.request('turn/interrupt', { threadId, turnId }, { timeoutMs: this.timeouts.controlRequestMs })
    } catch (error) {
      this.deps.host.log({
        scope: 'codex',
        level: 'info',
        message: 'Codex refused to interrupt a subagent turn',
        data: { threadId, turnId, error: errorMessage(error) },
      })
    }
  }

  /** Stop one subagent from its card, with the subagents it started.
   * Resolves once their interrupts are sent, as `cancel` does. */
  async stopSubtask(taskId: string): Promise<void> {
    if (this.exitValue || !this.subagents.has(taskId)) return
    this.sweepSubagents(this.stopGeneration, taskId)
  }

  private async sendInterrupt(active: ActiveTurn): Promise<void> {
    const turnId = active.turn.turnId
    if (!turnId || active.settled || !this.client || active.turn.interruptSent) return
    // Once per turn: a second cancel, or `turn/started` racing the
    // `turn/start` answer, must not send it again.
    active.turn.interruptSent = true
    try {
      await this.client.request(
        'turn/interrupt',
        { threadId: this.sessionIdValue!, turnId },
        { timeoutMs: this.timeouts.controlRequestMs },
      )
    } catch (error) {
      this.emit(
        routeEvent(this.route(), this.sessionIdValue, 'error', 'rpc_error', {
          source: 'turn/interrupt',
          message: errorMessage(error),
          recoverable: true,
        }),
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Notifications

  /** Every notification goes to exactly one place: this thread, one of its
   * subagents, the connection (nothing acts on those yet), or nowhere. A
   * thread-scoped one never falls through to this thread. */
  private onNotification(method: string, params: unknown): void {
    const scope = codexNotificationScope(method, params)
    if (scope.kind === 'global') return
    if (scope.kind === 'unscoped') return this.drop(method, undefined)
    // Before Codex has named this session's thread there is nothing to apply
    // a thread-scoped notification to, ours or a child's.
    if (this.sessionIdValue === undefined) return
    if (scope.threadId !== this.sessionIdValue) {
      if (!this.subagents.notification(method, scope.threadId, params)) this.drop(method, scope.threadId)
      return
    }
    this.onOwnNotification(method, params)
  }

  private drop(method: string, threadId: string | undefined): void {
    if (++this.dropped > 1) return
    this.deps.host.log({
      scope: 'codex',
      level: 'info',
      message: 'Ignoring notifications for no thread this session owns',
      data: { method, ...(threadId ? { threadId } : {}) },
    })
  }

  private onOwnNotification(method: string, params: unknown): void {
    const record = (params ?? {}) as { turnId?: unknown; turn?: { id?: unknown } }
    const namedTurn =
      typeof record.turnId === 'string'
        ? record.turnId
        : typeof record.turn?.id === 'string'
          ? record.turn.id
          : undefined
    if (namedTurn !== undefined && this.finishedTurnIds.has(namedTurn)) return
    const active = this.active
    switch (method) {
      case 'turn/started': {
        const { turn } = params as v2.TurnStartedNotification
        if (active && !active.turn.turnId) {
          this.identifyTurn(active, turn.id)
          if (active.turn.interruptRequested) void this.sendInterrupt(active)
        }
        return
      }
      case 'turn/completed': {
        const { turn } = params as v2.TurnCompletedNotification
        if (active && (!active.turn.turnId || active.turn.turnId === turn.id)) {
          this.identifyTurn(active, turn.id)
          this.finishTurn(active, turn)
        }
        return
      }
      case 'error': {
        const notice = params as v2.ErrorNotification
        if (notice.willRetry) {
          this.emit(
            routeEvent(this.route(), this.sessionIdValue, 'error', 'rpc_error', {
              source: 'codex',
              message: notice.error.message,
              recoverable: true,
            }),
          )
        } else if (active && this.ownsTurn(active, notice.turnId)) {
          active.turn.error = notice.error
        }
        return
      }
    }
    // Everything below belongs to the turn in flight; a late one for a turn
    // already finished is dropped.
    const turnId = (params as { turnId?: unknown }).turnId
    const owned = active !== undefined && (typeof turnId !== 'string' || this.ownsTurn(active, turnId))
    // Subagent items are the subagents' to track whenever they come: a
    // child that outlives the turn that started it still reports here.
    if (method === 'item/started' || method === 'item/completed') {
      const { item } = params as v2.ItemStartedNotification
      if (isCodexCollabItem(item)) {
        const phase = method === 'item/started' ? 'started' : 'completed'
        this.subagents.item(this.sessionIdValue!, item, phase, owned)
        return
      }
    }
    if (!active || !owned) return
    switch (method) {
      case 'item/started':
        active.turn.itemStarted((params as v2.ItemStartedNotification).item)
        return
      case 'item/completed':
        active.turn.itemCompleted((params as v2.ItemCompletedNotification).item)
        return
      case 'item/agentMessage/delta':
        active.turn.agentMessageDelta(params as v2.AgentMessageDeltaNotification)
        return
      case 'item/reasoning/summaryPartAdded':
        active.turn.reasoningPartAdded(params as v2.ReasoningSummaryPartAddedNotification)
        return
      case 'item/reasoning/summaryTextDelta':
        active.turn.reasoningSummaryDelta(params as v2.ReasoningSummaryTextDeltaNotification)
        return
      case 'thread/tokenUsage/updated':
        active.turn.tokenUsageUpdated((params as v2.ThreadTokenUsageUpdatedNotification).tokenUsage)
        return
      default:
        return
    }
  }

  /** Take Codex's id for the turn, from whichever of `turn/start` and
   * `turn/started` names it first, and report it once: the host keeps it
   * beside its own turn (revert and fork address turns by it). */
  private identifyTurn(active: ActiveTurn, turnId: string): void {
    if (active.turn.turnId) return
    active.turn.turnId = turnId
    if (active.settled) return
    this.emit(
      routeEvent(this.route(), this.sessionIdValue, 'lifecycle', 'turn_identified', {
        providerTurnId: turnId,
      }),
    )
  }

  private ownsTurn(active: ActiveTurn, turnId: string): boolean {
    return active.turn.turnId === undefined || active.turn.turnId === turnId
  }

  private finishTurn(active: ActiveTurn, turn: v2.Turn): void {
    switch (turn.status) {
      case 'completed':
        this.completeTurn(active, 'end_turn')
        return
      case 'interrupted':
        this.completeTurn(active, 'cancelled')
        return
      case 'failed':
        this.failTurn(
          active,
          new CodexTurnFailedError(turn.error?.message ?? active.turn.error?.message ?? 'Codex turn failed'),
        )
        return
      case 'inProgress':
        return
    }
  }

  private completeTurn(active: ActiveTurn, stopReason: string): void {
    if (active.settled) return
    active.settled = true
    this.rememberFinished(active)
    active.turn.finish()
    if (this.active === active) this.active = undefined
    // Children that run on past a turn that ended normally are in the
    // background; a stopped turn's are being interrupted.
    if (stopReason === 'end_turn') this.subagents.parentTurnEnded()
    const usage = active.turn.usage
    this.emit(
      routeEvent(this.route(), this.sessionIdValue, 'lifecycle', 'prompt_completed', {
        stopReason,
        ...(usage ? { usage } : {}),
      }),
    )
    const context = active.turn.contextUsage
    if (context) this.emit(routeEvent(this.route(), this.sessionIdValue, 'session', 'usage_update', context))
    active.resolve()
  }

  /** One terminal error, no `prompt_completed` (both end the turn
   * downstream), and the prompt rejects. */
  private failTurn(active: ActiveTurn, error: unknown): void {
    if (active.settled) return
    active.settled = true
    this.rememberFinished(active)
    active.turn.finish()
    if (this.active === active) this.active = undefined
    // Children run on past a failed turn too; not past the process.
    if (this.phaseValue !== 'exited') this.subagents.parentTurnEnded()
    const message = errorMessage(error)
    this.emit(
      routeEvent(this.route(), this.sessionIdValue, 'error', 'runtime_error', {
        kind: error instanceof CodexTurnFailedError ? 'provider' : 'transport',
        message,
      }),
    )
    active.reject(error)
  }

  private rememberFinished(active: ActiveTurn): void {
    if (active.turn.turnId) this.finishedTurnIds.add(active.turn.turnId)
    const totals = active.turn.threadTotals
    if (totals) this.tokenBaseline = totals
  }

  private emitTurnOutput(output: CodexTurnOutput): void {
    this.emit(routeEvent(this.route(), this.sessionIdValue, 'stream', output.event, output.data))
  }

  private emitSubagentOutput(output: CodexSubagentOutput): void {
    const category = output.event === 'subtask_update' ? 'session' : 'tool'
    this.emit(routeEvent(this.route(), this.sessionIdValue, category, output.event, output.data))
  }

  // ---------------------------------------------------------------------------
  // Settings

  async setModel(modelId: string): Promise<void> {
    await this.ready()
    if (modelId === this.modelId && this.appliedAt) return
    if (this.models?.availableModels && !this.models.availableModels.some((m) => m.id === modelId))
      throw new Error(`Codex does not offer the model ${modelId}`)
    // Applied with the next `turn/start`, which always names the model.
    this.modelId = modelId
    this.appliedAt = new Date().toISOString()
    this.emit(
      routeEvent(this.route(), this.sessionIdValue, 'session', 'current_model_update', {
        ...this.models,
        currentModelId: modelId,
      }),
    )
  }

  setMode(_modeId: string): Promise<void> {
    return Promise.reject(new CapabilityMissingError(this.providerId, 'canSetMode', 'setting the access mode'))
  }

  setConfigOption(_configId: string, _value: string | boolean): Promise<void> {
    return Promise.reject(
      new CapabilityMissingError(this.providerId, 'canSetConfigOption', 'setting a config option'),
    )
  }

  async applyDesiredConfig(desired: DesiredSessionConfig): Promise<void> {
    if (desired.modelId && desired.modelId !== this.modelId) {
      try {
        await this.setModel(desired.modelId)
      } catch (error) {
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Codex refused the desired model; keeping the current one',
          data: { modelId: desired.modelId, error: errorMessage(error) },
        })
      }
    }
  }

  listSessions(): Promise<ProviderSessionInfo[]> {
    return Promise.reject(
      new CapabilityMissingError(this.providerId, 'canListSessions', 'listing sessions'),
    )
  }

  respondPermission(requestId: string, outcome: PermissionOutcome): boolean {
    return this.deps.permissions.respond(requestId, outcome)
  }
  respondExtension(_requestId: string, _response: unknown): boolean {
    return false
  }
  respondQuestion(_requestId: string, _outcome: QuestionOutcome): boolean {
    return false
  }
  respondPlan(_requestId: string, _outcome: PlanReviewOutcome): boolean {
    return false
  }

  // ---------------------------------------------------------------------------
  // Events and exit

  events(listener: BackendEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onExit(listener: (exit: SessionRuntimeExit) => void): () => void {
    if (this.exitValue) {
      listener(this.exitValue)
      return () => undefined
    }
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  async stop(request: TerminationRequest): Promise<SessionRuntimeExit> {
    if (this.exitValue) return this.exitValue
    this.stopRequest ??= request
    if (this.phaseValue !== 'exited') this.phaseValue = 'stopping'
    const client = this.client
    if (client) await client.terminate(request).catch(() => undefined)
    else this.settleExit({ exitCode: null, signal: null, forced: false, at: new Date().toISOString() })
    return this.exited
  }

  dispose(): void {
    void this.stop({ reason: 'disposed' })
  }

  private settleExit(processExit: ProcessExit): void {
    if (this.exitValue) return
    this.phaseValue = 'exited'
    const active = this.active
    if (active) this.failTurn(active, new Error('codex app-server exited during the turn'))
    this.subagents.clear()
    this.deps.permissions.settleThread(this.providerId, this.threadIdValue)
    this.deps.interactions.settleThread(this.providerId, this.threadIdValue)
    const expected = this.stopRequest !== undefined
    if (this.spawned)
      this.emit(
        routeEvent(this.route(), this.sessionIdValue, 'lifecycle', 'process_exited', {
          exitCode: processExit.exitCode,
          ...(processExit.signal ? { signal: processExit.signal } : {}),
          expected,
        }),
      )
    this.exitValue = {
      ...processExit,
      expected,
      ...(this.stopRequest ? { reason: this.stopRequest.reason } : {}),
    }
    this.resolveExited(this.exitValue)
    for (const listener of this.exitListeners) listener(this.exitValue)
    this.exitListeners.clear()
  }

  private async ready(): Promise<void> {
    this.assertUsable()
    if (this.phaseValue !== 'ready') await this.start()
    this.assertUsable()
  }

  private assertUsable(): void {
    if (this.exitValue || this.phaseValue === 'stopping' || this.phaseValue === 'exited')
      throw new Error('Codex session runtime has exited')
  }

  private route(): BackendRoute {
    return {
      threadId: this.threadIdValue,
      ...(this.workspaceIdValue ? { workspaceId: this.workspaceIdValue } : {}),
    }
  }

  private emit(event: BackendEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** `thread/resume` found a subagent's thread where a session's was stored. */
class CodexSubagentThreadError extends Error {
  constructor(threadId: string) {
    super(`Codex thread ${threadId} belongs to a subagent, not a session`)
    this.name = 'CodexSubagentThreadError'
  }
}

/** A turn Codex itself reported as failed. */
export class CodexTurnFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexTurnFailedError'
  }
}

/** The prompt as Codex input. Text blocks join into one text input; images
 * go as data URLs. (`localImage` server paths need the prompt to carry a
 * path, which it does not yet.) Audio and resources are refused before the
 * turn starts. */
export function codexInput(prompt: PromptInput): v2.UserInput[] {
  const input: v2.UserInput[] = []
  const text: string[] = []
  for (const block of prompt.blocks) {
    switch (block.type) {
      case 'text':
        text.push(block.text)
        break
      case 'image':
        input.push({ type: 'image', url: `data:${block.mimeType};base64,${block.data}` })
        break
      default:
        throw new Error(`Codex cannot take a ${block.type} block in a prompt`)
    }
  }
  const joined = text.length > 0 ? text.join('\n\n') : prompt.text
  if (joined) input.unshift({ type: 'text', text: joined, text_elements: [] })
  return input
}

/** `thread/resume` for a thread Codex does not have: `-32600` with "no
 * rollout found" (probed on 0.170), or an id it cannot parse. Nothing
 * broader: any other resume failure (a model, cwd or config problem) must
 * fail the start rather than quietly replace the user's thread. */
export function isMissingThread(error: unknown): boolean {
  if (!(error instanceof CodexRpcError) || error.code !== -32600) return false
  return /no rollout found|invalid session id/i.test(error.message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
