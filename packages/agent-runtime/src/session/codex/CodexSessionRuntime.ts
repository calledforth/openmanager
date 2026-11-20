import { randomUUID } from 'node:crypto'
import type {
  ModelListing,
  ModeListing,
  PermissionOutcome,
  PlanReviewOutcome,
  PromptCapabilities,
  PromptInput,
  ProviderId,
  ProviderNotice,
  ProviderProblem,
  ProviderSessionInfo,
  QuestionOutcome,
  SessionConfigOption,
  TurnOperation,
  UsageLimitObservation,
} from '@agentpack/contract'
import type { v2, WebSearchMode } from '@openmanager/codex-app-server-protocol'
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
  SessionRuntimeStopReason,
  TerminationRequest,
  ThreadId,
} from '../lifecycle.js'
import type { SessionRuntimeSpec } from '../SessionRuntime.js'
import { routeEvent } from '../wire.js'
import {
  CODEX_ACCESS_PRESETS,
  codexAccess,
  codexAccessPresetOf,
  codexModeListing,
  defaultCodexAccessPreset,
  isCodexAccessPreset,
  type CodexAccess,
  type CodexAccessPreset,
} from './codex-access.js'
import {
  CODEX_CONFIG,
  CODEX_STANDARD_SERVICE_TIER,
  codexConfiguredWebSearch,
  codexModelConfigOptions,
  codexModelListing,
  codexPolicy,
  codexServiceTiers,
  codexWebSearchModes,
  isCodexWebSearchMode,
  readCodexFeatures,
  readCodexModels,
  readCodexPermissionProfiles,
  type CodexCatalogContext,
  type CodexRequester,
} from './codex-catalog.js'
import {
  codexFreshThreadNotice,
  codexNotice,
  codexProblem,
  codexRetryProblem,
  codexRpcProblem,
  codexThreadChangeNotice,
  type CodexThreadChange,
} from './codex-problems.js'
import {
  codexNotificationScope,
  CodexSubagents,
  isCodexCollabItem,
  isCodexSubagentThread,
  type CodexSubagentOutput,
} from './codex-subagents.js'
import { CodexTurn, type CodexTurnOutput } from './codex-turn.js'
import { CodexBackgroundTerminals } from './codex-background.js'
import type { CodexAppServerClient } from './CodexAppServerClient.js'
import { CodexConnectionClosedError, CodexRpcError } from './CodexRpcPeer.js'
import { startRealCodex, type CodexStarter } from './start.js'

export const CODEX_PROMPT_CAPABILITIES: PromptCapabilities = { image: true }

/** Settings every thread gets on top of the user's own `~/.codex`
 * (docs/decisions/codex-app-server.md, "The user's Codex home"): their
 * `notify` program would fire for every turn we run, doubling openmanager's
 * own notifications; and the `update_plan` tool, off unless a client turns it
 * on (probed on 0.170), is what keeps the todo checklist. The session's web
 * search mode joins them when one was chosen: it is per-thread `config`, so
 * it is given each time the thread is opened. */
function threadConfig(
  webSearch: WebSearchMode | undefined,
): Record<string, string | string[] | boolean> {
  return {
    notify: [],
    'tools.update_plan.enabled': true,
    ...(webSearch ? { web_search: webSearch } : {}),
  }
}

/** What the next turn runs with: the user's picks, else what Codex read
 * back. `turn/start` sends all of it (overrides are sticky). */
type CodexDesiredSettings = {
  preset: CodexAccessPreset
  effort?: string
  serviceTier?: string
  /** Undefined: whatever the user's own config says. */
  webSearch?: WebSearchMode
}

/** A thread's settings as Codex reads them back: from `thread/start` or
 * `thread/resume`, then every `thread/settings/updated`. */
type CodexReadBack = {
  model: string
  effort: string | null
  /** `default` (standard speed) when Codex names none. */
  serviceTier: string
  preset: CodexAccessPreset | undefined
}

/** The settings a composer change can move between turns. */
type CodexSettingField = 'model' | 'effort' | 'serviceTier' | 'preset'

/** How long a stop keeps interrupting subagents. Interrupting the parent's
 * turn leaves its children running (probed on 0.170), and a child spawned
 * just before the stop announces itself after it, so the stop looks again
 * until none is running or this runs out. */
export const CODEX_SUBAGENT_STOP_MS = 10_000

export type CodexSessionRuntimeDeps = {
  config: CodexProviderConfig
  host: Pick<HostDeps, 'log' | 'onSessionTitle' | 'sessionHistory'>
  permissions: PermissionBroker
  interactions: InteractionBroker
  /** Starts the app-server. The real binary when absent. */
  start?: CodexStarter
  timeouts?: Partial<RuntimeTimeouts>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** `CODEX_SUBAGENT_STOP_MS` when absent. */
  subagentStopMs?: number
  /** Takes this connection's `account/rateLimits/updated` (the account's,
   * not the thread's) into the provider's limits, and answers with the
   * windows to announce as `usage_limits_update`. Dropped when absent. */
  rateLimits?: (update: v2.AccountRateLimitsUpdatedNotification) => UsageLimitObservation[]
}

type ActiveTurn = {
  turn: CodexTurn
  /** A turn Codex began by itself (goal continuation, automatic
   * compaction): nobody's prompt waits on it. */
  background: boolean
  /** The host stopped the process under this turn (shutdown, an update, a
   * move, an eviction), not the user: the turn fails and can be sent again,
   * rather than reading as the user's own Stop. */
  stoppedBy?: SessionRuntimeStopReason
  resolve: () => void
  reject: (error: unknown) => void
  done: Promise<void>
  settled: boolean
  /** Resolves once Codex has named the turn, or the turn is over: a steer
   * names the turn it is for (`expectedTurnId`). */
  identified: Promise<void>
  markIdentified: () => void
}

/** How many finished turn ids a runtime remembers, newest kept: only a
 * recent turn can still have Codex talking about it. */
const FINISHED_TURNS_MAX = 64

/** How many notices said while no turn ran are kept for the next one. */
const PENDING_NOTICES_MAX = 16

/** How long a stop lets a running turn end on its own interrupt before the
 * process goes, so Codex records the turn as interrupted. */
const STOP_INTERRUPT_MAX_MS = 2_000

/** How long a stop waits for Codex to end the background terminals the
 * thread retains before the process goes. */
const STOP_TERMINALS_MAX_MS = 2_000

/** What a fresh thread is handed of the conversation a lost one held. */
const HANDOVER_MESSAGE_MAX_CHARS = 8_000
const HANDOVER_TOTAL_MAX_CHARS = 60_000

/** One Codex thread in its own `codex app-server` process
 * (docs/decisions/codex-app-server.md, "One app-server per session").
 *
 * The openmanager session id *is* the Codex thread id: durable, persisted by
 * the server as `provider_session_id`, and what `thread/resume` takes back.
 *
 * Covered here: start and resume, prompts that resolve on the turn's own
 * `turn/completed`, assistant text and reasoning summaries, usage, steer,
 * interrupt, subagents (child threads on this connection, kept apart by
 * `CodexSubagents` and stopped with the parent), exit, and the thread's name
 * and archive (docs/decisions/codex-app-server.md, "Threads: archive on
 * delete, no import"). So are a thread that changed outside openmanager
 * (closed, archived, deleted, rewound, a system error), turns Codex begins by
 * itself, operation turns (`/review`, `/compact`: `runOperation`), Codex's
 * typed errors and its notices (`codex-problems.ts`; the
 * decisions doc's "Errors and notices"). Tool items, approvals and questions are later changes;
 * until approvals exist, every approval Codex asks for is declined, so nothing
 * runs outside the sandbox without a person having said yes. */
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
  private models: ModelListing | undefined
  /** Codex's catalog as this session read it, and what it is read against
   * (the managed policy, the flags, the user's web search mode). */
  private catalog: v2.Model[] = []
  private catalogContext: CodexCatalogContext = {}
  /** The model the next turn runs on: what the user picked, else Codex's. */
  private modelId: string | undefined
  private appliedAt: string | undefined
  /** Everything else the next turn runs with. */
  private readonly desired: CodexDesiredSettings
  /** Changes made while a turn ran: the next `turn/start` carries them, and
   * a read-back in the meantime (the running turn's own) must not undo
   * them. */
  private readonly queued = new Set<CodexSettingField>()
  /** The thread's settings as Codex last read them back. */
  private readBack: CodexReadBack | undefined
  /** Bumped by every `thread/settings/updated` for this thread. */
  private settingsVersion = 0
  private readonly settingsWaiters = new Set<() => void>()
  /** The web search mode the open thread was opened with; undefined is the
   * user's own config. A different one waits for the thread to be opened
   * again (`reopenThread`). */
  private openedWebSearch: WebSearchMode | undefined
  /** What the composer was last told, so a change is reported once. */
  private shown: { model?: string; mode?: string; options?: string } = {}
  /** `permissionProfile/list` for this directory, when Codex answered: a
   * profile it disallows rules out the presets that need it. */
  private permissionProfiles: v2.PermissionProfileSummary[] | undefined
  /** Composer changes run one at a time, so each waits for its own
   * read-back and none is undone by another's. */
  private settingsChain: Promise<unknown> = Promise.resolve()
  /** Fields a `thread/settings/update` is out for: a read-back meanwhile
   * (an earlier change's) must not undo them. */
  private readonly inFlight = new Set<CodexSettingField>()
  /** Values the user set through the composer that the host's own desired
   * config may not know yet: a prompt sent meanwhile carries the old ones,
   * which must not undo the change. Dropped once the host sends the same. */
  private readonly pinned = new Map<CodexSettingField | 'webSearch', string>()
  /** The tier the thread runs at as far as this runtime knows: Codex's
   * read-back, or what it last sent (an older CLI reads nothing back), so
   * Standard can clear a Fast it never saw read back. */
  private threadTier: string | undefined
  /** The thread being opened again, for whoever must wait for it. */
  private reopenRun: Promise<void> | undefined
  /** A turn may have run on the open thread (one ran here, or the thread
   * was resumed): reopening it fresh must then hand the conversation over. */
  private threadRanTurn = false
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
  /** Commands turns left running: the session's background tasks. */
  private readonly terminals: CodexBackgroundTerminals
  /** Bumped by every prompt and stop, so a stop still sweeping subagents
   * leaves alone the children of a turn that started after it. */
  private stopGeneration = 0
  /** Bumped by every stop only: a prompt that waited for settings or a
   * reopen starts no turn once the user has stopped. */
  private cancels = 0
  /** Notifications that are nobody's: for a thread that is neither ours nor
   * a known child, or thread-scoped and naming no thread. Counted, logged
   * once, and never applied to this thread. */
  private dropped = 0
  /** Steers waiting for Codex to name their turn, not sent yet, by
   * `steerId`. One taken back meanwhile is marked and never sent. */
  private readonly preparingSteers = new Map<string, { withdrawn: boolean }>()
  /** The title openmanager shows for the session, when the user or the title
   * model wrote it: what the thread's name should be. */
  private title: string | undefined
  /** The thread's name as Codex last said it, or as we last set it. */
  private codexName: string | undefined
  /** Names we set whose `thread/name/updated` has not come back yet. Codex
   * echoes every `thread/name/set` to the connection that sent it (_probed_,
   * 0.170), and our own title coming back is not the agent naming the
   * session. */
  private readonly nameEchoes = new Map<string, number>()
  /** `thread/name/set` requests not answered yet. */
  private nameSetsInFlight = 0
  /** The last `thread/name/set` failed: tried again after the next turn. */
  private nameRetry = false
  /** Notices said while no turn ran (MCP startup, config warnings, a change
   * made to the thread outside openmanager), shown at the next turn's start:
   * the host files a notice under a turn. */
  private readonly pendingNotices: ProviderNotice[] = []
  /** The thread must be opened again before the next turn: Codex closed,
   * archived or deleted it outside openmanager, or hit a system error on it. */
  private reopen: Exclude<CodexThreadChange, 'unarchived' | 'reverted'> | undefined
  /** Set while this runtime reopens the thread, whose unarchive is its own. */
  private reopening = false
  /** Set once this runtime archives its own thread (the session was deleted):
   * that archive, and the close it brings, are not outside changes. */
  private ownArchive = false
  /** The thread Codex had for the session was gone and a fresh one took its
   * place: the next turn hands the earlier conversation over first. */
  private handover: { from: string } | undefined
  /** Codex's last word on the thread's status. */
  private threadStatus: v2.ThreadStatus['type'] | undefined
  /** A `turn/start` is out: a `turn/started` with no turn open is then that
   * one's (closed early), never a turn Codex began by itself. */
  private turnStarting = false
  /** A `/compact` this runtime closed because Codex never started it: a
   * turn Codex begins before the next prompt is that compaction. */
  private compactionOwed = false
  /** A review's working turns not tied to an open review, by the review's
   * turn id (the extra `turn/started` came first), and reviews closed before
   * Codex named them: either way the working turn is what an interrupt names. */
  private readonly workingTurns = new Map<string, string>()
  private readonly orphanedReviews = new Set<string>()

  constructor(
    private readonly spec: SessionRuntimeSpec,
    private readonly deps: CodexSessionRuntimeDeps,
  ) {
    this.providerId = spec.providerId
    this.cwd = spec.cwd
    this.threadIdValue = spec.threadId
    this.workspaceIdValue = spec.workspaceId
    this.title = spec.title?.trim() || undefined
    this.timeouts = { ...DEFAULT_RUNTIME_TIMEOUTS, ...deps.timeouts }
    // A session's mode is restored when its process starts, from the session
    // alone (docs/decisions/live-composer-state.md); its values are re-checked
    // against the catalog once it is read.
    const desired = spec.desiredConfig
    const values = desired?.values ?? {}
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
    const effort = text(values[CODEX_CONFIG.effort])
    const serviceTier = text(values[CODEX_CONFIG.serviceTier])
    const webSearch = values[CODEX_CONFIG.webSearch]
    this.desired = {
      preset: isCodexAccessPreset(desired?.modeId)
        ? desired.modeId
        : defaultCodexAccessPreset(deps.platform),
      ...(effort ? { effort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(isCodexWebSearchMode(webSearch) ? { webSearch } : {}),
    }
    this.terminals = new CodexBackgroundTerminals({
      enabled: deps.config.capabilities.supportsBackgroundTasks === true,
      client: () => (this.exitValue ? undefined : this.client),
      threadId: () => this.sessionIdValue,
      timeoutMs: this.timeouts.controlRequestMs,
      announce: (tasks) =>
        this.emit(routeEvent(this.route(), this.sessionIdValue, 'session', 'background_tasks_update', { tasks })),
      log: (entry) => this.deps.host.log(entry),
    })
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve
    })
  }

  get threadId(): ThreadId {
    return this.threadIdValue
  }
  /** The access preset's settings, in every spelling. */
  private get access(): CodexAccess {
    return codexAccess(this.desired.preset)
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
   * kill them (docs/decisions/codex-app-server.md, "Children count"). So does
   * a turn Codex began by itself, which no prompt holds the session open for,
   * and commands running in the background. */
  get busy(): boolean {
    return this.subagents.running || this.active?.background === true || this.terminals.busy
  }

  /** What was last written, never a guess: undefined until a model has been
   * chosen explicitly. */
  get applied(): AppliedSessionState | undefined {
    if (!this.appliedAt || this.modelId === undefined) return undefined
    const options = this.configOptions()
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
            currentValue: this.readBack?.model ?? this.modelId,
            options: [],
          },
        ],
        ...options.map((option) => [option.id, option] as const),
      ]),
      refreshedAt: this.appliedAt,
      source: this.readBack ? 'config_option_update' : 'write_through',
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
    // Read first: a web search mode the policy has since ruled out must not
    // reach `thread/start`. Local reads, answered in milliseconds.
    this.catalogContext = await this.readCatalogContext(client)
    if (this.desired.webSearch && !codexWebSearchModes(this.catalogContext).includes(this.desired.webSearch))
      delete this.desired.webSearch
    // A restored preset the policy has since ruled out would fail every
    // start: the default, or the first allowed one, stands in.
    let presetReplaced = false
    const allowed = this.allowedPreset(this.desired.preset)
    if (allowed !== this.desired.preset) {
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'The session’s access preset is no longer allowed; starting in another',
        data: { preset: this.desired.preset, instead: allowed },
      })
      this.desired.preset = allowed
      presetReplaced = true
    }
    const opened = await this.openThread(client)
    // Known as soon as Codex names it, so this thread's own notifications are
    // never mistaken for another's while the catalog is still on its way.
    this.sessionIdValue = opened.threadId
    this.catalog = await catalog
    this.models = codexModelListing(this.catalog, this.catalogContext)
    this.modelId ??= opened.model
    this.codexName = opened.name
    this.takeOpened(opened)
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
        {
          models: { ...this.models, ...(this.modelId ? { currentModelId: this.modelId } : {}) },
          modes: this.modeListing(),
          configOptions: this.configOptions(),
        },
      ),
    )
    this.shown = this.showing()
    // The session still names the preset that is no longer allowed: a load
    // keeps its remembered mode, so the one in force is said outright.
    if (presetReplaced)
      this.emit(routeEvent(this.route(), opened.threadId, 'session', 'current_mode_update', this.modeListing()))
    // Our title outranks a name the thread got elsewhere (a rename in Codex
    // while no runtime held it); without one, that name is the agent's title
    // for the session. Never held up for: a name is bookkeeping.
    if (this.title) void this.giveName()
    else if (opened.name) this.reportName(opened.name)
    return { sessionId: opened.threadId, state: opened.state }
  }

  /** `thread/resume` for a stored thread, `thread/start` otherwise. A thread
   * Codex no longer has falls back to a fresh one, unless the caller requires
   * the old one (`load: 'require'`); the next turn then hands the earlier
   * conversation over (`handOver`). `existing` is the thread to resume: the
   * stored one at start, the session's own when it is reopened. */
  private async openThread(
    client: CodexAppServerClient,
    existing: string | undefined = this.spec.sessionId,
  ): Promise<OpenedThread> {
    const settings = this.threadParams(this.modelId ?? this.spec.desiredConfig?.modelId)
    if (existing) {
      try {
        const resumed = await this.resumeThread(client, { ...settings, threadId: existing })
        // A subagent's thread is its parent's, never a session of its own:
        // treated as one this session does not have.
        if (isCodexSubagentThread(resumed.thread)) {
          // Resuming subscribed this connection to it; let it go again.
          await this.unsubscribe(client, resumed.thread.id)
          throw new CodexSubagentThreadError(existing)
        }
        return {
          threadId: resumed.thread.id,
          model: resumed.model,
          name: resumed.thread.name?.trim() || undefined,
          state: 'loaded',
          settings: resumed,
          webSearch: settings.webSearch,
        }
      } catch (error) {
        if (!isMissingThread(error) && !(error instanceof CodexSubagentThreadError)) throw error
        if (this.spec.load === 'require') throw new SessionUnknownError(this.providerId, existing)
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Codex no longer has this thread; starting a fresh one',
          data: { threadId: existing, error: String(error) },
        })
        this.handover = { from: existing }
      }
    } else if (this.spec.load === 'require') {
      throw new SessionUnknownError(this.providerId, undefined)
    }
    return this.startThread(client, settings)
  }

  private async startThread(
    client: CodexAppServerClient,
    settings: ReturnType<CodexSessionRuntime['threadParams']>,
  ): Promise<OpenedThread> {
    const started = await client.request(
      'thread/start',
      {
        ...settings,
        historyMode: 'paginated',
        ...(this.spec.instructions ? { developerInstructions: this.spec.instructions } : {}),
      },
      { timeoutMs: this.timeouts.newSessionMs },
    )
    return {
      threadId: started.thread.id,
      model: started.model,
      name: started.thread.name?.trim() || undefined,
      state: 'created',
      settings: started,
      webSearch: settings.webSearch,
    }
  }

  /** What `thread/start` and `thread/resume` are given: the directory, the
   * access preset (in the thread's spelling), our thread config with the
   * session's web search mode, and the model when one is chosen. Effort and
   * speed are checked against the catalog first, so they wait for the first
   * `turn/start`. */
  private threadParams(model: string | undefined) {
    const webSearch = this.desired.webSearch
    return {
      webSearch,
      cwd: this.cwd,
      approvalPolicy: this.access.approvalPolicy,
      approvalsReviewer: this.access.approvalsReviewer,
      sandbox: this.access.sandbox,
      config: threadConfig(webSearch),
      ...(model ? { model } : {}),
    }
  }

  /** The policy, flags and the user's web search mode, which say what this
   * session's settings may offer. Each is optional: a CLI that cannot answer
   * one still runs, with nothing ruled out by it. */
  private async readCatalogContext(client: CodexAppServerClient): Promise<CodexCatalogContext> {
    const optional = <T>(read: Promise<T>): Promise<T | undefined> =>
      read.catch(() => undefined)
    const timeoutMs = this.timeouts.controlRequestMs
    const request: CodexRequester['request'] = (method, params) =>
      client.request(method, params, { timeoutMs })
    const [requirements, features, config, profiles] = await Promise.all([
      optional(client.request('configRequirements/read', undefined, { timeoutMs })),
      optional(readCodexFeatures({ request })),
      optional(client.request('config/read', { cwd: this.cwd }, { timeoutMs })),
      optional(readCodexPermissionProfiles({ request }, this.cwd)),
    ])
    this.permissionProfiles = profiles
    return {
      ...(requirements ? { requirements: requirements.requirements } : {}),
      ...(features ? { features } : {}),
      ...(config ? { webSearch: codexConfiguredWebSearch(config) } : {}),
    }
  }

  /** `thread/resume`, through an archive made outside openmanager: Codex
   * refuses an archived thread (`-32600`, "is archived", _probed_), so it is
   * unarchived and resumed again, once. */
  private async resumeThread(
    client: CodexAppServerClient,
    params: Omit<v2.ThreadResumeParams, 'excludeTurns'>,
  ): Promise<v2.ThreadResumeResponse> {
    const resume = () =>
      client.request(
        'thread/resume',
        { ...params, excludeTurns: true },
        { timeoutMs: this.timeouts.loadSessionMs },
      )
    try {
      return await resume()
    } catch (error) {
      if (!isArchivedThread(error)) throw error
      this.deps.host.log({
        scope: 'codex',
        level: 'info',
        message: 'Codex had archived this thread; unarchiving it to resume',
        data: { threadId: params.threadId },
      })
      await client.request(
        'thread/unarchive',
        { threadId: params.threadId },
        { timeoutMs: this.timeouts.controlRequestMs },
      )
      return resume()
    }
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
    // Answered, never left to `-32601`, whose effect on a turn is unprobed:
    // asked for more access, it is granted none (CAL-258); asked a question,
    // nobody answers (CAL-259); asked for MCP input, it is declined (CAL-259).
    client.handle(
      'item/permissions/requestApproval',
      (): v2.PermissionsRequestApprovalResponse => ({ permissions: {}, scope: 'turn' }),
      { immediate: true },
    )
    client.handle(
      'item/tool/requestUserInput',
      (): v2.ToolRequestUserInputResponse => ({ answers: {} }),
      { immediate: true },
    )
    client.handle(
      'mcpServer/elicitation/request',
      (): v2.McpServerElicitationRequestResponse => ({ action: 'decline', content: null, _meta: null }),
      { immediate: true },
    )
  }

  // ---------------------------------------------------------------------------
  // Turns

  async prompt(args: {
    prompt: PromptInput
    userMessageId?: string
    desiredConfig?: DesiredSessionConfig
    operation?: TurnOperation
  }): Promise<void> {
    // A stop from here on stops this prompt too, wherever it is waiting.
    const cancels = this.cancels
    await this.ready()
    // A turn Codex began by itself owns the thread until it ends; the host
    // files what it says under this prompt's turn meanwhile.
    const generation = this.stopGeneration
    while (this.active?.background) await this.active.done.catch(() => undefined)
    // Stopped while it waited (the stop ended the background turn): this
    // prompt is stopped with it, and no turn is started behind the host.
    if (generation !== this.stopGeneration) return
    if (this.active) throw new Error('A Codex turn is already running in this session')
    // A composer change or a reopen still under way finishes first, and none
    // starts until this turn is open. One made after that is queued: it goes
    // with this turn's `turn/start` if made before it is sent (during the
    // handover), else with the next turn.
    const release = await this.holdSettings()
    try {
      if (this.active) throw new Error('A Codex turn is already running in this session')
      if (args.desiredConfig) await this.applyDesiredConfig(args.desiredConfig)
      // An operation sends no prompt: the command as typed is the host's.
      const input = args.operation ? [] : codexInput(args.prompt)
      if (!args.operation) this.assertReadsImages(args.prompt)
      this.assertUsable()
      // A web search mode chosen since the thread was opened takes effect now,
      // unless subagents still run on it.
      if (this.reopen || (this.configChanged() && !this.subagents.running)) {
        await this.reopenThread()
        if (this.active) throw new Error('A Codex turn is already running in this session')
      }
      // Stopped while it waited: no turn is started behind the host.
      if (cancels !== this.cancels) return
      return await this.startTurn(args, input, release)
    } finally {
      release()
    }
  }

  /** Wait for every composer change and reopen under way, then hold the
   * settings chain until the returned release is called. */
  private async holdSettings(): Promise<() => void> {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const before = this.settingsChain
    this.settingsChain = before.then(() => held)
    await before
    await this.reopenRun?.catch(() => undefined)
    return release
  }

  /** Send the turn, releasing the settings chain once it is open. */
  private async startTurn(
    args: { prompt: PromptInput; userMessageId?: string; operation?: TurnOperation },
    input: v2.UserInput[],
    release: () => void,
  ): Promise<void> {
    const client = this.client!
    const threadId = this.sessionIdValue!
    const userMessageId = args.userMessageId ?? `agent_usr_${randomUUID()}`
    this.stopGeneration++
    // An echo still owed by now (no set in flight) is never coming.
    if (this.nameSetsInFlight === 0) this.nameEchoes.clear()

    this.emit(
      routeEvent(this.route(), threadId, 'lifecycle', 'prompt_started', {
        prompt: args.prompt.text,
        userMessageId,
        ...(args.prompt.attachments?.length ? { attachments: args.prompt.attachments } : {}),
      }),
    )
    const operation = args.operation
    this.compactionOwed = false
    const active = this.openTurn(false, operation)
    // Open: a composer change from here waits for the next turn.
    release()
    this.flushNotices()
    this.turnStarting = true
    try {
      await this.handOver(client, threadId, userMessageId)
      this.threadRanTurn = true
      if (operation) await this.runOperation(client, threadId, active, operation)
      else {
        // Every setting, every turn: overrides are sticky, so one left out is
        // whatever the last turn set, not the default.
        const tier = this.turnServiceTier()
        const sent = this.sentSettings()
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
            ...(this.desired.effort ? { effort: this.desired.effort } : {}),
            ...tier,
          },
          { timeoutMs: this.timeouts.controlRequestMs },
        )
        if ('serviceTier' in tier) this.threadTier = tier.serviceTier ?? CODEX_STANDARD_SERVICE_TIER
        // Sent: from here Codex's read-back is the answer for them too. A
        // change made while `turn/start` was out did not go with it, and stays
        // queued for the next turn.
        for (const field of [...this.queued])
          if (this.sentSettings()[field] === sent[field]) this.queued.delete(field)
        // `turn/started` may have named it already. Named only now, after this
        // runtime closed it, it is an orphan Codex is still running: this
        // answer names exactly that turn, so blocking it can never catch
        // another.
        if (active.settled && !active.turn.turnId) this.orphanTurn(response.turn.id)
        else {
          this.identifyTurn(active, response.turn.id)
          if (active.turn.interruptRequested) void this.sendInterrupt(active)
        }
      }
    } catch (error) {
      this.failTurn(active, error)
      // An answer that refuses means no turn exists. Anything else (a
      // timeout) leaves Codex perhaps running a turn nobody will ever name
      // to us: the process is replaced, so that turn dies with it and the
      // next prompt never lands on a busy thread or mistakes it for its own.
      if (!(error instanceof CodexRpcError) && !this.exitValue && this.phaseValue === 'ready') {
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Replacing the Codex process after a turn/start it never answered',
          data: { error: errorMessage(error) },
        })
        void this.stop({ reason: 'restart' })
      }
    } finally {
      this.turnStarting = false
    }
    // The RPC only says the turn began; the turn ends on `turn/completed`.
    return active.done
  }

  /** Run an operation as the turn just opened (docs/decisions/codex-app-server.md,
   * "Operation turns"). Neither request carries settings, so the session's
   * own go first (`applySettingsNow`): a review runs shell commands under the
   * thread's sandbox and model, and a compaction runs on its model. Either is
   * refused (an error answer) like a `turn/start`, and the turn ends on its
   * `turn/completed`.
   *
   * - `review/start`, delivered inline: Codex names the review's turn in its
   *   answer, files every item and the `turn/completed` under it, and starts
   *   the review's work as another turn (the extra `turn/started`, whose
   *   `rootTurnId` is the review's), the one an interrupt must name.
   * - `thread/compact/start`: Codex answers with nothing, then starts the
   *   compaction as a turn that `turn/started` names. One it never names is
   *   closed after the control timeout, so the session never waits on it. */
  private async runOperation(
    client: CodexAppServerClient,
    threadId: string,
    active: ActiveTurn,
    operation: TurnOperation,
  ): Promise<void> {
    await this.applySettingsNow(client, threadId)
    if (operation.kind === 'compact' && operation.instructions)
      this.notice({
        kind: 'info',
        message: 'Codex compacts without instructions, so the words after /compact were not used',
        detail: operation.instructions,
      })
    if (operation.kind === 'review') {
      const response = await client.request(
        'review/start',
        { threadId, target: codexReviewTarget(operation.target), delivery: 'inline' },
        { timeoutMs: this.timeouts.controlRequestMs },
      )
      if (active.settled && !active.turn.turnId) this.orphanReview(response.turn.id)
      else {
        this.identifyTurn(active, response.turn.id)
        if (active.turn.interruptRequested) void this.sendInterrupt(active)
      }
      return
    }
    await client.request('thread/compact/start', { threadId }, { timeoutMs: this.timeouts.controlRequestMs })
    const named = await Promise.race([
      active.identified.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.timeouts.controlRequestMs)
        timer.unref?.()
      }),
    ])
    if (!named && !active.settled) {
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Codex accepted thread/compact/start but started no turn; closing it',
        data: { threadId },
      })
      // Should it start after all, it is still this compaction, not one
      // Codex began by itself.
      this.compactionOwed = true
      this.failTurn(active, new CodexTurnFailedError('Codex accepted the compaction but did not start it'))
    }
  }

  /** Send the session's settings that Codex's read-back does not already
   * show, now, before an operation that carries none, and wait for Codex to
   * read them back. A change queued during the last turn goes this way. One
   * Codex does not read back still went; one it refuses fails the turn, as a
   * refused `turn/start` would. */
  private async applySettingsNow(client: CodexAppServerClient, threadId: string): Promise<void> {
    const fields: CodexSettingField[] = ['model', 'effort', 'serviceTier', 'preset']
    const update = this.settingsUpdate(fields)
    if (!update) {
      for (const field of fields) this.queued.delete(field)
      return
    }
    const since = this.settingsVersion
    try {
      await client.request(
        'thread/settings/update',
        { threadId, ...update },
        { timeoutMs: this.timeouts.controlRequestMs },
      )
    } catch (error) {
      if (!(error instanceof CodexRpcError) || error.code !== RPC_METHOD_NOT_FOUND) throw error
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'This Codex has no thread/settings/update; the operation runs on the thread as it is',
        data: { fields: Object.keys(update) },
      })
      return
    }
    if ('serviceTier' in update) this.threadTier = update.serviceTier ?? CODEX_STANDARD_SERVICE_TIER
    for (const field of fields) this.queued.delete(field)
    const read = await this.settingsReadBack(since, (candidate) =>
      Object.keys(update).every((field) => this.readBackMatches(field, update, candidate)),
    )
    if (!read)
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Codex did not read back the settings sent before an operation',
        data: { fields: Object.keys(update) },
      })
  }

  private openTurn(background: boolean, operation?: TurnOperation): ActiveTurn {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const done = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    let markIdentified!: () => void
    const identified = new Promise<void>((res) => {
      markIdentified = res
    })
    const active: ActiveTurn = {
      turn: new CodexTurn(
        (output) => this.emitTurnOutput(output),
        this.tokenBaseline,
        this.cwd,
        operation?.kind,
      ),
      background,
      resolve,
      reject,
      done,
      settled: false,
      identified,
      markIdentified,
    }
    // Nobody may be listening yet if the caller dropped the promise.
    done.catch(() => undefined)
    this.active = active
    return active
  }

  /** Open the turn Codex began by itself: a goal continuing, or an automatic
   * compaction. It is announced so the host has a turn to file its output
   * under, and it ends like any other, on its `turn/completed`. */
  private openBackgroundTurn(turnId: string): void {
    this.threadRanTurn = true
    // A `/compact` closed for never starting, starting after all.
    const owed = this.compactionOwed
    this.compactionOwed = false
    const active = this.openTurn(true, owed ? { kind: 'compact' } : undefined)
    this.emit(routeEvent(this.route(), this.sessionIdValue, 'lifecycle', 'background_turn_started', {}))
    this.identifyTurn(active, turnId)
    this.flushNotices()
  }

  /** Open the thread again before a turn, after Codex closed, archived or
   * deleted it outside openmanager, or hit a system error on it. It goes
   * through the resume fallback: an archived thread is unarchived, a missing
   * one replaced by a fresh one (stamped through `session_created`, its
   * conversation handed over at this turn). One that fails to reopen fails
   * this prompt and is tried again with the next; after a system error, which
   * may have left the thread loaded and well, the turn is tried anyway.
   *
   * Also when the session's web search mode changed (`config`): it is the
   * thread's `config`, which a resume of a thread still loaded keeps, so
   * the thread is let go first (`thread/unsubscribe`; Codex unloads a thread
   * nobody is subscribed to) and resumed with the new one (_probed_ on
   * 0.170). A thread that never ran a turn has nothing on disk to resume and
   * is started again; there is no conversation to hand over. */
  private reopenThread(): Promise<void> {
    this.reopenRun ??= this.runReopen().finally(() => {
      this.reopenRun = undefined
    })
    return this.reopenRun
  }

  private async runReopen(): Promise<void> {
    const why = this.reopen ?? (this.configChanged() ? 'config' : undefined)
    const client = this.client
    const previous = this.sessionIdValue
    if (!why || !client || !previous) return
    this.reopening = true
    let opened: OpenedThread
    const ranTurn = this.threadRanTurn
    // A handover still owed from an earlier fresh start (after a restart)
    // outlives a config reopen of the thread that replaced it.
    const owed = this.handover
    let unsubscribed = false
    try {
      if (why === 'config') {
        await this.unsubscribe(client, previous)
        unsubscribed = true
      }
      opened = await this.openThread(client, previous)
      // A thread no turn ever ran on has nothing on disk to resume and no
      // conversation of its own to hand over: only one still owed goes. One
      // that had turns keeps the handover the resume fallback set.
      if (why === 'config' && !ranTurn) this.handover = owed
    } catch (error) {
      // Let go and not taken back: the thread is not loaded, and its close
      // was ours to ignore. The next turn opens it again.
      if (unsubscribed) this.reopen = 'closed'
      if (why !== 'systemError') throw error
      this.reopen = undefined
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Codex did not resume the thread after its system error; trying the turn anyway',
        data: { threadId: previous, error: errorMessage(error) },
      })
      return
    } finally {
      this.reopening = false
    }
    this.reopen = undefined
    this.assertUsable()
    this.sessionIdValue = opened.threadId
    this.codexName = opened.name
    this.takeOpened(opened)
    this.publish()
    this.terminals.threadChanged()
    this.deps.host.log({
      scope: 'codex',
      level: 'info',
      message: 'Reopened the Codex thread',
      data: { why, from: previous, threadId: opened.threadId, state: opened.state },
    })
    if (opened.threadId === previous) return
    // A fresh thread counts its tokens from zero.
    this.tokenBaseline = undefined
    // A new identity: the host stamps it before this turn is sent.
    this.emit(
      routeEvent(this.route(), opened.threadId, 'lifecycle', 'session_created', {
        models: { ...this.models, ...(this.modelId ? { currentModelId: this.modelId } : {}) },
        modes: this.modeListing(),
        configOptions: this.configOptions(),
      }),
    )
    if (this.title) void this.giveName()
  }

  /** Hand a fresh thread the conversation the lost one held
   * (docs/decisions/codex-app-server.md, "Resume fallback"): the host's copy,
   * less the prompt about to run, goes in as model-visible history with
   * `thread/inject_items`, bounded to the newest messages. Either way the
   * turn shows a note saying what happened. Never fails the turn. */
  private async handOver(
    client: CodexAppServerClient,
    threadId: string,
    userMessageId: string,
  ): Promise<void> {
    const handover = this.handover
    if (!handover) return
    this.handover = undefined
    let handedOver = false
    // Unknown (a host that keeps no history) says the context may be lost;
    // known to be empty, there was nothing to lose and nothing is said.
    let earlier = true
    try {
      const stored = this.deps.host.sessionHistory?.({
        providerId: this.providerId,
        threadId: this.threadIdValue,
      })
      const history = stored?.filter(
        (message) => message.messageId !== userMessageId && message.text.trim(),
      )
      if (history && history.length === 0) earlier = false
      const items = handoverItems(history ?? [])
      if (items.length > 0) {
        await client.request(
          'thread/inject_items',
          { threadId, items },
          { timeoutMs: this.timeouts.controlRequestMs },
        )
        handedOver = true
      }
    } catch (error) {
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Could not hand the earlier conversation to the fresh Codex thread',
        data: { from: handover.from, threadId, error: errorMessage(error) },
      })
    }
    if (earlier) this.notice(codexFreshThreadNotice(handedOver))
  }

  /** Show a notice: now, inside the turn in flight, or at the next turn's
   * start when none runs. Kept notices are bounded and never repeated. */
  private notice(notice: ProviderNotice): void {
    const active = this.active
    if (active && !active.settled) {
      this.emit(routeEvent(this.route(), this.sessionIdValue, 'session', 'provider_notice', notice))
      return
    }
    if (this.pendingNotices.some((kept) => kept.kind === notice.kind && kept.message === notice.message))
      return
    if (this.pendingNotices.length >= PENDING_NOTICES_MAX) this.pendingNotices.shift()
    this.pendingNotices.push(notice)
  }

  private flushNotices(): void {
    for (const notice of this.pendingNotices.splice(0))
      this.emit(routeEvent(this.route(), this.sessionIdValue, 'session', 'provider_notice', notice))
  }

  /** The thread was closed, archived or deleted outside openmanager. It is
   * shown, and the thread is reopened before the next turn. A turn in flight
   * is over: Codex no longer runs the thread for this connection, so it
   * fails, and can be sent again. */
  private threadGone(change: 'closed' | 'archived' | 'deleted'): void {
    // Our own archive closes the thread too, and a reopen is ours.
    if (this.ownArchive || this.reopening) return
    // Deleted outranks archived outranks closed: the reopen must expect the worst.
    if (this.reopen !== 'deleted' && !(this.reopen === 'archived' && change === 'closed'))
      this.reopen = change
    this.deps.host.log({
      scope: 'codex',
      level: 'warn',
      message: `Codex thread ${change} outside OpenManager`,
      data: { threadId: this.sessionIdValue },
    })
    this.notice(codexThreadChangeNotice(change))
    const active = this.active
    if (active) this.failTurn(active, new CodexThreadGoneError(change))
    this.terminals.threadChanged()
  }

  /** `thread/status/changed`: Codex's own word on the thread. A system error
   * is shown and the thread reopened before the next turn, unless Codex says
   * it is well again first; `notLoaded` means it was let go. */
  private statusChanged(status: v2.ThreadStatus): void {
    const previous = this.threadStatus
    this.threadStatus = status.type
    switch (status.type) {
      case 'systemError':
        if (previous === 'systemError') return
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Codex reported a system error on the thread',
          data: { threadId: this.sessionIdValue },
        })
        this.notice(codexThreadChangeNotice('systemError'))
        this.reopen ??= 'systemError'
        return
      case 'notLoaded':
        if (this.ownArchive || this.reopening) return
        if (this.reopen === undefined || this.reopen === 'systemError') this.reopen = 'closed'
        this.terminals.threadChanged()
        return
      case 'idle':
      case 'active':
        if (this.reopen === 'systemError') this.reopen = undefined
        return
    }
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
    this.cancels++
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
      const placed = active.turn.placeUnansweredSteers()
      if (placed.length > 0)
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Closing a turn with steers Codex has not answered; counting them as delivered',
          data: { turnId: active.turn.turnId, steerIds: placed },
        })
      // Codex may still be running that turn, and the next `turn/start` would
      // land on a busy thread. The process is replaced instead (as
      // `interruptGraceMs` says, and as Claude's watchdog does): the session
      // resumes on its next prompt, and the turn dies with the process. The
      // stop is begun before the turn is closed, so anything reacting to the
      // close already sees the runtime stopping.
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Replacing the Codex process after an interrupt it did not finish',
        data: { turnId: active.turn.turnId },
      })
      const stopping = this.stop({ reason: 'restart' })
      this.completeTurn(active, 'cancelled')
      await stopping
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

  /** Add a message to the turn in flight with `turn/steer`. Codex takes it
   * into that turn's pending input and the model reads it at its next step,
   * after the tool call under way. `turn/steer` carries no settings, so the
   * message runs on the turn's own model, access and effort, never on a
   * selection made since.
   *
   * Resolves once Codex has taken it. Then exactly one event follows, naming
   * `steerId`: `steer_delivered` when Codex echoes it as a `userMessage` of
   * the turn (see `CodexTurn.userMessage`), or `steer_withdrawn` if the turn
   * ends without that echo. Codex never begins a turn of its own for a steer,
   * so there is no `steer_turn_started`.
   *
   * Refused, with nothing sent or nothing taken, when there is no turn to
   * steer (none running, or being stopped), when Codex says the turn has
   * ended or is another one (`-32600`), and when the turn cannot be steered
   * at all (`activeTurnNotSteerable`: a review, a compaction). The caller
   * then queues the message for the next turn instead.
   *
   * A `turn/steer` that gets no answer (a timeout, a broken pipe) is not a
   * refusal: Codex may hold the message, and refusing would have the host
   * run it again. It stays pending and resolves like an accepted one; its
   * echo places it, or the turn's end gives it back. */
  async steer(args: { prompt: PromptInput; steerId: string }): Promise<void> {
    // Never starts a process: a steer is for a turn that is running, and a
    // runtime stopped or being replaced (after a grace close) has none.
    if (this.exitValue || this.phaseValue === 'stopping' || this.phaseValue === 'exited')
      throw new CodexSteerRefusedError('no_turn', `Codex has no turn to steer on thread ${this.threadIdValue}`)
    const active = this.active
    if (!active || active.settled || active.turn.interruptRequested)
      throw new CodexSteerRefusedError(
        'no_turn',
        `Codex has no turn to steer on thread ${this.threadIdValue}`,
      )
    // A review or compaction takes no input (Codex refuses it as
    // `activeTurnNotSteerable`): refused here, without asking.
    if (active.turn.operation)
      throw new CodexSteerRefusedError(
        'not_steerable',
        `Codex cannot steer a ${active.turn.operation} turn`,
      )
    // Converted before anything is recorded, as a prompt is: an unsupported
    // block refuses the steer instead of leaving it pending.
    const input = codexInput(args.prompt)
    // A steer can arrive between `prompt_started` and Codex naming the turn.
    // Until it goes out it can still be taken back (`withdrawSteer`).
    const preparing = { withdrawn: false }
    this.preparingSteers.set(args.steerId, preparing)
    try {
      await active.identified
    } finally {
      this.preparingSteers.delete(args.steerId)
    }
    // Taken back meanwhile: `withdrawSteer` has already said so.
    if (preparing.withdrawn) return
    const turnId = active.turn.turnId
    if (this.active !== active || active.settled || !turnId || active.turn.interruptRequested)
      throw new CodexSteerRefusedError(
        'turn_ended',
        'The Codex turn ended before the steer was sent',
      )
    active.turn.expectSteer(args.steerId, input)
    try {
      await this.client!.request(
        'turn/steer',
        {
          threadId: this.sessionIdValue!,
          expectedTurnId: turnId,
          // Echoed as the `userMessage` item's `clientId`: how its echo is
          // told apart from the prompt's.
          clientUserMessageId: args.steerId,
          input,
        },
        { timeoutMs: this.timeouts.controlRequestMs },
      )
      active.turn.steerAnswered(args.steerId)
    } catch (error) {
      if (!(error instanceof CodexRpcError)) {
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'turn/steer got no answer; waiting for its echo or the turn to end',
          data: { turnId, steerId: args.steerId, error: errorMessage(error) },
        })
        return
      }
      // Already placed or given back (the turn ended while Codex answered):
      // that event is this steer's one answer, so the refusal is not another.
      if (!active.turn.forgetSteer(args.steerId)) return
      throw steerRefusal(error)
    }
  }

  /** Take a steered message back, which only works before it is sent: while
   * the steer waits for Codex to name its turn. Then `steer_withdrawn` is
   * emitted and true returned, and the host runs it as the next turn ("send
   * now"). Codex has no un-steer, so once `turn/steer` is out the message is
   * the turn's (Codex echoes it within milliseconds) and this is false. */
  withdrawSteer(steerId: string): Promise<boolean> {
    const preparing = this.preparingSteers.get(steerId)
    if (!preparing || preparing.withdrawn) return Promise.resolve(false)
    preparing.withdrawn = true
    this.emit(
      routeEvent(this.route(), this.sessionIdValue, 'lifecycle', 'steer_withdrawn', { steerId }),
    )
    return Promise.resolve(true)
  }

  private async sendInterrupt(active: ActiveTurn): Promise<void> {
    // A review is interrupted through its working turn (_probed_: naming the
    // review's own turn is refused, "expected active turn id"). Until the
    // extra `turn/started` names it, the interrupt waits for it.
    const turnId = active.turn.operation === 'review' ? active.turn.workingTurnId : active.turn.turnId
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
    if (method === 'account/rateLimits/updated' && this.deps.rateLimits) {
      for (const observation of this.deps.rateLimits(params as v2.AccountRateLimitsUpdatedNotification))
        this.emit(routeEvent(this.route(), this.sessionIdValue, 'session', 'usage_limits_update', observation))
      return
    }
    const scope = codexNotificationScope(method, params)
    // The connection's own: this process serves this one session, so what
    // it warns about (config, deprecations, an MCP server that did not
    // start) is this session's to see.
    if (scope.kind === 'global') {
      const notice = codexNotice(method, params)
      if (notice) this.notice(notice)
      return
    }
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
    const finished = namedTurn !== undefined && this.finishedTurnIds.has(namedTurn)
    const active = this.active
    // Subagent items are the subagents' to track whenever they come, a
    // finished turn's included: a child spawned by a turn this runtime
    // closed still runs, and must get its card, count as busy and be
    // stopped. Only the turn in flight's own may show as tool rows.
    if (method === 'item/started' || method === 'item/completed') {
      const { item } = params as v2.ItemStartedNotification
      // A background command ends in a turn long finished, or in a later one.
      if (method === 'item/completed') this.terminals.itemCompleted(item)
      if (isCodexCollabItem(item)) {
        const turnId = (params as { turnId?: unknown }).turnId
        const owned =
          !finished &&
          active !== undefined &&
          (typeof turnId !== 'string' || this.ownsTurn(active, turnId))
        const phase = method === 'item/started' ? 'started' : 'completed'
        this.subagents.item(this.sessionIdValue!, item, phase, owned)
        return
      }
    }
    if (method === 'thread/settings/updated') {
      this.settingsUpdated((params as v2.ThreadSettingsUpdatedNotification).threadSettings)
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const { tokenUsage } = params as v2.ThreadTokenUsageUpdatedNotification
      if (!finished && active && (namedTurn === undefined || this.ownsTurn(active, namedTurn)))
        active.turn.tokenUsageUpdated(tokenUsage)
      // Spent outside the turn in flight (a late reading for a finished
      // one): the next turn counts from after it, never including it.
      else if (!active) this.tokenBaseline = tokenUsage.total
      return
    }
    if (finished) return
    switch (method) {
      case 'thread/name/updated':
        this.nameUpdated((params as v2.ThreadNameUpdatedNotification).threadName)
        return
      case 'thread/status/changed':
        this.statusChanged((params as v2.ThreadStatusChangedNotification).status)
        return
      case 'thread/closed':
        this.threadGone('closed')
        return
      case 'thread/archived':
        this.threadGone('archived')
        return
      case 'thread/deleted':
        this.threadGone('deleted')
        return
      case 'thread/unarchived':
        // Our own unarchive, to resume, is no news.
        if (this.reopening) return
        if (this.reopen === 'archived') this.reopen = undefined
        this.notice(codexThreadChangeNotice('unarchived'))
        return
      case 'thread/reverted':
        // Reconciling the stored history with Codex's is not built yet
        // (CAL-234): the rewind is shown, and the transcript stays as it was.
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Codex thread rewound outside OpenManager; the stored history is not reconciled',
          data: { threadId: this.sessionIdValue },
        })
        this.notice(codexThreadChangeNotice('reverted'))
        return
      case 'warning':
      case 'guardianWarning':
      case 'configWarning':
      case 'deprecationNotice':
      case 'mcpServer/startupStatus/updated': {
        // The thread's, not one turn's: shown now or at the next turn.
        const notice = codexNotice(method, params)
        if (notice) this.notice(notice)
        return
      }
      case 'modelProvider/authRecoveryStarted':
      case 'modelProvider/authRecoveryCompleted':
      case 'model/safetyBuffering/updated':
      case 'turn/moderationMetadata':
        // Logged, not shown: auth recovery resolves itself or ends in an
        // `unauthorized` failure that is shown; safety buffering only slows a
        // turn; moderation metadata is for OpenAI's own clients.
        this.deps.host.log({
          scope: 'codex',
          level: 'info',
          message: `Codex ${method}`,
          data: params,
        })
        return
      case 'turn/started': {
        const { turn } = params as v2.TurnStartedNotification
        // A review's extra `turn/started`: its working turn, rooted at the
        // review's own, which goes on naming every item and its end.
        const root = turn.rootTurnId
        if (root && root !== turn.id) {
          if (active?.turn.operation === 'review' && this.ownsTurn(active, root)) {
            this.identifyTurn(active, root)
            active.turn.workingTurnId = turn.id
            if (active.turn.interruptRequested) void this.sendInterrupt(active)
            return
          }
          // One for a review closed before Codex named it is stopped.
          if (this.orphanedReviews.delete(root)) {
            this.interruptOrphan(turn.id)
            return
          }
          // One whose review is not named yet, or is already closed, starts
          // nothing; it is kept in case the review is closed unnamed.
          if (this.turnStarting || this.finishedTurnIds.has(root)) {
            this.workingTurns.set(root, turn.id)
            if (this.workingTurns.size > 8) this.workingTurns.delete(this.workingTurns.keys().next().value!)
            return
          }
        }
        if (active) {
          if (!active.turn.turnId) {
            this.identifyTurn(active, turn.id)
            if (active.turn.interruptRequested) void this.sendInterrupt(active)
          }
          return
        }
        // No turn open and none being started: Codex began this one itself.
        if (!this.turnStarting && this.phaseValue === 'ready') this.openBackgroundTurn(turn.id)
        return
      }
      case 'turn/completed': {
        const { turn } = params as v2.TurnCompletedNotification
        if (active && (!active.turn.turnId || active.turn.turnId === turn.id)) {
          this.identifyTurn(active, turn.id)
          // An image still being read settles its row inside the turn.
          const reading = active.turn.imagesRead()
          if (reading) void reading.then(() => this.finishTurn(active, turn))
          else this.finishTurn(active, turn)
        }
        return
      }
      case 'error': {
        const notice = params as v2.ErrorNotification
        if (notice.willRetry) {
          // "Reconnecting... 2/5": the turn lives on.
          this.emit(
            routeEvent(this.route(), this.sessionIdValue, 'error', 'rpc_error', {
              source: 'codex',
              message: notice.error.message,
              recoverable: true,
              problem: codexRetryProblem(notice),
            }),
          )
        } else if (active && this.ownsTurn(active, notice.turnId)) {
          active.turn.error = notice.error
          // An operation that fails ends there: a review Codex could not
          // start (not a git repository, _probed_) gets no `turn/completed`.
          // Like a `turn/completed`, it waits for any image still being read.
          if (active.turn.operation) {
            const failed = () =>
              this.failTurn(active, new CodexTurnFailedError(notice.error.message, notice.error))
            const reading = active.turn.imagesRead()
            if (reading) void reading.then(failed)
            else failed()
          }
        }
        return
      }
    }
    // Everything below belongs to the turn in flight; a late one for a turn
    // already finished is dropped.
    const turnId = (params as { turnId?: unknown }).turnId
    const owned = active !== undefined && (typeof turnId !== 'string' || this.ownsTurn(active, turnId))
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
      case 'thread/compacted':
        active.turn.threadCompacted()
        return
      case 'item/reasoning/summaryPartAdded':
        active.turn.reasoningPartAdded(params as v2.ReasoningSummaryPartAddedNotification)
        return
      case 'item/reasoning/summaryTextDelta':
        active.turn.reasoningSummaryDelta(params as v2.ReasoningSummaryTextDeltaNotification)
        return
      default: {
        // The turn's tools: output, progress, the plan, hooks.
        if (active.turn.toolNotification(method, params)) return
        // The turn's own notices: a model switch, a verification, warnings.
        const notice = codexNotice(method, params)
        if (notice) this.notice(notice)
        return
      }
    }
  }

  /** Take Codex's id for the turn, from whichever of `turn/start` and
   * `turn/started` names it first, and report it once: the host keeps it
   * beside its own turn (revert and fork address turns by it). */
  private identifyTurn(active: ActiveTurn, turnId: string): void {
    if (active.turn.turnId) return
    active.turn.turnId = turnId
    active.markIdentified()
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
        if (active.stoppedBy) this.failTurn(active, new CodexStoppedError(active.stoppedBy))
        else this.completeTurn(active, 'cancelled')
        return
      case 'failed': {
        const error = turn.error ?? active.turn.error
        this.failTurn(active, new CodexTurnFailedError(error?.message ?? 'Codex turn failed', error ?? undefined))
        return
      }
      case 'inProgress':
        return
    }
  }

  private completeTurn(active: ActiveTurn, stopReason: string): void {
    if (active.settled) return
    active.settled = true
    this.rememberFinished(active)
    active.markIdentified()
    const running = active.turn.runningProcesses()
    active.turn.finish(stopReason === 'end_turn')
    // A stop under way ends every terminal itself (`stopTerminals`).
    if (this.phaseValue === 'ready')
      this.terminals.turnEnded(running, stopReason !== 'end_turn' || active.turn.interruptRequested)
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
    if (this.nameRetry) void this.giveName()
  }

  /** One terminal error, no `prompt_completed` (both end the turn
   * downstream), and the prompt rejects. */
  private failTurn(active: ActiveTurn, error: unknown): void {
    if (active.settled) return
    active.settled = true
    this.rememberFinished(active)
    active.markIdentified()
    const running = active.turn.runningProcesses()
    // A failed turn's commands run on, and say so, as the background tasks
    // list them. Not when the thread is gone (it holds no terminals any
    // more), nor when a stop is under way: that ends them itself.
    const ready = this.phaseValue === 'ready'
    active.turn.finish(ready && !(error instanceof CodexThreadGoneError))
    if (ready) this.terminals.turnEnded(running, active.turn.interruptRequested)
    if (this.active === active) this.active = undefined
    // Children run on past a failed turn too; not past the process.
    if (this.phaseValue !== 'exited') this.subagents.parentTurnEnded()
    const message = errorMessage(error)
    const typed = problemOf(error)
    // Compacting again is no remedy for a compaction that failed.
    const problem =
      typed?.action === 'compact' && active.turn.operation === 'compact'
        ? (({ action: _action, ...rest }) => rest)(typed)
        : typed
    this.emit(
      routeEvent(this.route(), this.sessionIdValue, 'error', 'runtime_error', {
        kind:
          error instanceof CodexTurnFailedError || error instanceof CodexThreadGoneError
            ? 'provider'
            : error instanceof CodexStoppedError
              ? 'process'
              : 'transport',
        message,
        ...(problem ? { problem } : {}),
      }),
    )
    active.reject(error)
  }

  private rememberFinished(active: ActiveTurn): void {
    if (active.turn.turnId) this.rememberFinishedId(active.turn.turnId)
    const totals = active.turn.threadTotals
    if (totals) this.tokenBaseline = totals
  }

  /** Bounded: only the last few turns can still be talked about. */
  private rememberFinishedId(turnId: string): void {
    this.finishedTurnIds.delete(turnId)
    this.finishedTurnIds.add(turnId)
    if (this.finishedTurnIds.size > FINISHED_TURNS_MAX)
      this.finishedTurnIds.delete(this.finishedTurnIds.values().next().value!)
  }

  /** A turn Codex names after this runtime already closed it: nothing it
   * says about it may reach a later turn, and it is told to stop. */
  private orphanTurn(turnId: string): void {
    if (this.finishedTurnIds.has(turnId)) return
    this.rememberFinishedId(turnId)
    this.deps.host.log({
      scope: 'codex',
      level: 'warn',
      message: 'Codex named a turn this session already closed; interrupting it',
      data: { turnId },
    })
    this.interruptOrphan(turnId)
  }

  /** A review Codex names after this runtime closed it. Only its working
   * turn can be interrupted (_probed_), so that is stopped: now if the extra
   * `turn/started` already named it, else when it does. */
  private orphanReview(turnId: string): void {
    if (this.finishedTurnIds.has(turnId)) return
    this.rememberFinishedId(turnId)
    this.deps.host.log({
      scope: 'codex',
      level: 'warn',
      message: 'Codex named a review this session already closed; interrupting it',
      data: { turnId },
    })
    const working = this.workingTurns.get(turnId)
    this.workingTurns.delete(turnId)
    if (working) this.interruptOrphan(working)
    else this.orphanedReviews.add(turnId)
  }

  private interruptOrphan(turnId: string): void {
    const client = this.client
    if (!client || !this.sessionIdValue) return
    void client
      .request('turn/interrupt', { threadId: this.sessionIdValue, turnId }, { timeoutMs: this.timeouts.controlRequestMs })
      .catch((error: unknown) =>
        this.deps.host.log({
          scope: 'codex',
          level: 'info',
          message: 'Codex refused to interrupt a closed turn',
          data: { turnId, error: errorMessage(error) },
        }),
      )
  }

  private emitTurnOutput(output: CodexTurnOutput): void {
    const steer = output.event === 'steer_delivered' || output.event === 'steer_withdrawn'
    const category = steer
      ? 'lifecycle'
      : output.event === 'plan_update' ||
          output.event === 'provider_notice' ||
          output.event === 'usage_update'
        ? 'session'
        : output.event.startsWith('tool_')
          ? 'tool'
          : 'stream'
    this.emit(routeEvent(this.route(), this.sessionIdValue, category, output.event, output.data))
  }

  private emitSubagentOutput(output: CodexSubagentOutput): void {
    const category = output.event === 'subtask_update' ? 'session' : 'tool'
    this.emit(routeEvent(this.route(), this.sessionIdValue, category, output.event, output.data))
  }

  // ---------------------------------------------------------------------------
  // Name and archive

  /** The title openmanager now shows, as the thread's name. Before the
   * thread is open it is only remembered; `bootstrap` gives it. */
  async setTitle(title: string): Promise<void> {
    const next = title.trim()
    if (!next || this.exitValue) return
    this.title = next
    if (this.sessionIdValue) await this.giveName()
  }

  /** `thread/name/set` with the current title, unless the thread already has
   * it. Best-effort: a name Codex refuses is logged, never thrown. */
  private async giveName(): Promise<void> {
    const name = this.title
    const client = this.client
    const threadId = this.sessionIdValue
    if (!name || !client || !threadId || name === this.codexName || this.exitValue) return
    this.nameRetry = false
    this.nameEchoes.set(name, (this.nameEchoes.get(name) ?? 0) + 1)
    this.nameSetsInFlight += 1
    try {
      await client.request(
        'thread/name/set',
        { threadId, name },
        { timeoutMs: this.timeouts.controlRequestMs },
      )
      this.codexName = name
    } catch (error) {
      this.takeEcho(name)
      // Not given up on: a thread busy or briefly unwritable now takes it
      // after its next turn.
      if (this.title === name) this.nameRetry = true
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Codex did not take the session title as the thread name',
        data: { threadId, error: errorMessage(error) },
      })
    } finally {
      this.nameSetsInFlight -= 1
    }
  }

  /** `thread/name/updated`: our own name coming back, or the thread named
   * by someone else, which is the agent's title for the session. Openmanager
   * weighs it against the titles it has (`shouldReplaceSessionTitle`). */
  private nameUpdated(threadName: string | undefined): void {
    const name = threadName?.trim()
    if (!name) return
    this.codexName = name
    if (this.takeEcho(name)) return
    // A name Codex changed on the way in (it trims, _probed_; a later version
    // may do more) still echoes a set that is not answered yet.
    if (this.nameSetsInFlight > 0) {
      const oldest = this.nameEchoes.keys().next()
      if (!oldest.done && this.takeEcho(oldest.value)) return
    }
    this.reportName(name)
  }

  /** Our names and Codex's are compared as Codex stores them: trimmed. */
  private takeEcho(name: string): boolean {
    const key = name.trim()
    const pending = this.nameEchoes.get(key)
    if (!pending) return false
    if (pending > 1) this.nameEchoes.set(key, pending - 1)
    else this.nameEchoes.delete(key)
    return true
  }

  private reportName(name: string): void {
    this.emit(
      routeEvent(this.route(), this.sessionIdValue, 'session', 'session_info_update', {
        title: name,
        updatedAt: null,
      }),
    )
    this.deps.host.onSessionTitle?.({
      threadId: this.threadIdValue,
      workspaceId: this.workspaceIdValue,
      title: name,
    })
  }

  /** `thread/archive` for the session the user deleted, on this connection:
   * Codex refuses it to any other process while this one holds the thread
   * ("already has an active writer", _probed_). A thread Codex no longer has
   * is already out of the way. Never a hard delete, so the thread can still
   * be recovered in Codex. A turn still running is interrupted first, within
   * `cancel`'s bounded grace, so the thread is not archived under it. */
  async archive(): Promise<void> {
    await this.ready()
    // Never under a reopen: it would swap the thread out from under us.
    await this.reopenRun?.catch(() => undefined)
    if (this.active) await this.cancel()
    this.assertUsable()
    const threadId = this.sessionIdValue!
    // Codex tells this connection about the archive (and the close) too.
    this.ownArchive = true
    try {
      await this.client!.request(
        'thread/archive',
        { threadId },
        { timeoutMs: this.timeouts.controlRequestMs },
      )
    } catch (error) {
      if (!isMissingThread(error)) throw error
    }
  }

  // ---------------------------------------------------------------------------
  // Settings

  /** The model for the next turns. Between turns it goes to Codex at once
   * (`thread/settings/update`) and resolves once Codex reads it back
   * (`thread/settings/updated`); during a turn it waits for the next
   * `turn/start`, which always names the model. A change that fails leaves
   * the selection as it was. */
  async setModel(modelId: string): Promise<void> {
    await this.ready()
    return this.serialized(async () => {
      if (!this.offersModel(modelId)) throw new Error(`Codex does not offer the model ${modelId}`)
      if (modelId === this.modelId && this.appliedAt) return
      await this.change(['model', 'effort', 'serviceTier'], () => {
        this.modelId = modelId
        this.appliedAt = new Date().toISOString()
        this.fitToModel()
      })
      this.pinned.set('model', modelId)
    })
  }

  /** An Access preset (docs/decisions/codex-app-server.md, "Access
   * presets"), sent like the model. A preset the managed policy, the
   * permission profiles or the user's flags rule out is refused with the
   * reason. */
  async setMode(modeId: string): Promise<void> {
    await this.ready()
    return this.serialized(async () => {
      if (!isCodexAccessPreset(modeId)) throw new Error(`Codex has no access preset ${modeId}`)
      const blocked = this.presetBlocked(modeId)
      if (blocked) throw new Error(blocked)
      if (
        modeId === this.desired.preset &&
        !this.queued.has('preset') &&
        this.readBack?.preset === modeId
      )
        return
      await this.change(['preset'], () => {
        this.desired.preset = modeId
      })
      this.pinned.set('preset', modeId)
    })
  }

  /** Reasoning effort, speed and web search. Effort and speed go like the
   * model; web search is the thread's `config`, so it is applied by opening
   * the thread again: at once when nothing runs, else before the next turn.
   * A value the current model or policy does not offer is refused. */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    await this.ready()
    return this.serialized(async () => {
      const option = this.configOptions().find((candidate) => candidate.id === configId)
      if (!option || option.type !== 'select')
        throw new Error(`Codex has no setting ${configId} on this model`)
      if (typeof value !== 'string' || !option.options.some((entry) => entry.value === value))
        throw new Error(`Codex does not offer ${String(value)} for ${option.name}`)
      switch (configId) {
        case CODEX_CONFIG.effort:
          await this.change(['effort'], () => {
            this.desired.effort = value
          })
          this.pinned.set('effort', value)
          return
        case CODEX_CONFIG.serviceTier:
          await this.change(['serviceTier'], () => {
            this.desired.serviceTier = value
          })
          this.pinned.set('serviceTier', value)
          return
        case CODEX_CONFIG.webSearch: {
          if (!isCodexWebSearchMode(value)) throw new Error(`Codex has no web search mode ${value}`)
          const before = this.desired.webSearch
          this.desired.webSearch = value
          this.pinned.set('webSearch', value)
          this.publish()
          if (this.configChanged() && !this.active && !this.subagents.running) {
            try {
              await this.reopenThread()
            } catch (error) {
              // Not taken: the thread keeps the mode it has.
              if (before === undefined) delete this.desired.webSearch
              else this.desired.webSearch = before
              this.pinned.delete('webSearch')
              this.publish()
              throw error
            }
          }
          return
        }
      }
    })
  }

  /** The session's selection, before a prompt. Nothing is sent here: the
   * turn about to start sends every setting. A value the catalog or the
   * policy no longer offers is dropped with a log, so a stale pick cannot
   * fail the prompt, and so is one older than a change made in the composer
   * since (`pinned`). A mode the caller names (a draft's, at its first turn)
   * applies: the turn's `turn/start` sends it. */
  async applyDesiredConfig(desired: DesiredSessionConfig): Promise<void> {
    /** The host's value, unless the composer changed it since. */
    const fresh = (field: CodexSettingField | 'webSearch', value: string): boolean => {
      const pinned = this.pinned.get(field)
      if (pinned === undefined) return true
      if (pinned === value) {
        this.pinned.delete(field)
        return true
      }
      return false
    }
    const changed = new Set<CodexSettingField>()
    if (desired.modelId && fresh('model', desired.modelId) && desired.modelId !== this.modelId) {
      if (this.offersModel(desired.modelId)) {
        this.modelId = desired.modelId
        this.appliedAt = new Date().toISOString()
        changed.add('model')
      } else {
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Codex does not offer the desired model; keeping the current one',
          data: { modelId: desired.modelId },
        })
      }
    }
    if (desired.modeId && fresh('preset', desired.modeId) && desired.modeId !== this.desired.preset) {
      const blocked = isCodexAccessPreset(desired.modeId)
        ? this.presetBlocked(desired.modeId)
        : 'not an access preset'
      if (blocked || !isCodexAccessPreset(desired.modeId)) {
        this.deps.host.log({
          scope: 'codex',
          level: 'warn',
          message: 'Codex cannot take the desired access preset; keeping the current one',
          data: { modeId: desired.modeId, reason: blocked },
        })
      } else {
        this.desired.preset = desired.modeId
        changed.add('preset')
      }
    }
    const values = desired.values ?? {}
    const offered = new Map(
      this.configOptions().flatMap((option) =>
        option.type === 'select' ? [[option.id, option.options.map((entry) => entry.value)] as const] : [],
      ),
    )
    const pick = (configId: string, field: CodexSettingField | 'webSearch'): string | undefined => {
      const value = values[configId]
      if (value === undefined) return undefined
      if (typeof value === 'string' && !fresh(field, value)) return undefined
      if (typeof value === 'string' && offered.get(configId)?.includes(value)) return value
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Codex does not offer the desired setting; keeping the current one',
        data: { configId, value },
      })
      return undefined
    }
    const effort = pick(CODEX_CONFIG.effort, 'effort')
    const serviceTier = pick(CODEX_CONFIG.serviceTier, 'serviceTier')
    const webSearch = pick(CODEX_CONFIG.webSearch, 'webSearch')
    if (effort && effort !== this.desired.effort) {
      this.desired.effort = effort
      changed.add('effort')
    }
    if (serviceTier && serviceTier !== this.desired.serviceTier) {
      this.desired.serviceTier = serviceTier
      changed.add('serviceTier')
    }
    if (isCodexWebSearchMode(webSearch)) this.desired.webSearch = webSearch
    this.fitToModel()
    // Sent by the next `turn/start`; a read-back before then must not undo it.
    for (const field of changed) this.queued.add(field)
    this.publish()
  }

  /** Composer changes and reopens, one at a time. */
  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.settingsChain.then(async () => {
      await this.reopenRun?.catch(() => undefined)
      return run()
    })
    this.settingsChain = next.catch(() => undefined)
    return next
  }

  /** Until every composer change and reopen under way has finished. */
  private async settled(): Promise<void> {
    await this.settingsChain
    await this.reopenRun?.catch(() => undefined)
  }

  /** Apply `mutate` and send what it changed. If Codex refuses it, or the
   * request fails, the selection goes back to what it was: nothing it never
   * took may reach a later turn. If Codex reads back something else, its
   * value stands. */
  private async change(fields: readonly CodexSettingField[], mutate: () => void): Promise<void> {
    const before = { modelId: this.modelId, appliedAt: this.appliedAt, desired: { ...this.desired } }
    const queued = new Set(this.queued)
    mutate()
    try {
      await this.changeSettings(fields)
    } catch (error) {
      if (!(error instanceof CodexSettingsKeptError)) {
        this.modelId = before.modelId
        this.appliedAt = before.appliedAt
        Object.assign(this.desired, before.desired)
        for (const key of Object.keys(this.desired) as Array<keyof CodexDesiredSettings>)
          if (!(key in before.desired)) delete this.desired[key]
        this.queued.clear()
        for (const field of queued) this.queued.add(field)
      }
      this.publish()
      throw error
    }
  }

  /** Send what changed to Codex, between turns, and wait for its read-back.
   * While a turn runs, or while the thread is to be opened again, the change
   * is queued for the next `turn/start` instead (docs/decisions/codex-app-server.md,
   * "Settings flow"); the composer shows it as what the next turn runs
   * with. A Codex without `thread/settings/update` (`-32601`) gets it the
   * same way. */
  private async changeSettings(fields: readonly CodexSettingField[]): Promise<void> {
    this.assertUsable()
    const queue = () => {
      for (const field of fields) this.queued.add(field)
      this.publish()
    }
    if (this.active || this.reopen || this.reopenRun) return queue()
    const update = this.settingsUpdate(fields)
    if (!update) {
      this.publish()
      return
    }
    for (const field of fields) this.inFlight.add(field)
    let read: CodexReadBack | undefined
    try {
      const since = this.settingsVersion
      try {
        await this.client!.request(
          'thread/settings/update',
          { threadId: this.sessionIdValue!, ...update },
          { timeoutMs: this.timeouts.controlRequestMs },
        )
        // Taken: Codex runs at it now, whether or not it reads it back.
        if ('serviceTier' in update) this.threadTier = update.serviceTier ?? CODEX_STANDARD_SERVICE_TIER
      } catch (error) {
        if (!(error instanceof CodexRpcError) || error.code !== RPC_METHOD_NOT_FOUND) throw error
        this.deps.host.log({
          scope: 'codex',
          level: 'info',
          message: 'This Codex has no thread/settings/update; the next turn sends the change',
          data: { fields: Object.keys(update) },
        })
        return queue()
      }
      // Codex answers first and reads the settings back after (_probed_):
      // this change's own read-back, not an earlier one's.
      read = await this.settingsReadBack(since, (candidate) =>
        Object.keys(update).every((field) => this.readBackMatches(field, update, candidate)),
      )
    } finally {
      for (const field of fields) this.inFlight.delete(field)
    }
    if (!read) {
      // Not lost: the next `turn/start` sends every setting again.
      this.deps.host.log({
        scope: 'codex',
        level: 'warn',
        message: 'Codex did not read back a settings change; the next turn sends it again',
        data: { fields: Object.keys(update) },
      })
      return queue()
    }
    const kept = Object.keys(update).filter((field) => !this.readBackMatches(field, update, read))
    if (kept.length === 0) {
      this.publish()
      return
    }
    // Refused: what Codex kept stands, and no turn sends the change later.
    for (const field of fields) this.queued.delete(field)
    this.followReadBack()
    this.publish()
    throw new CodexSettingsKeptError(
      `Codex kept its own ${kept.join(' and ')}: ${kept.map((field) => readBackValue(field, read)).join(', ')}`,
    )
  }

  /** The settings a `turn/start` sends, by field, to tell which queued
   * changes it carried. */
  private sentSettings(): Record<CodexSettingField, string | undefined> {
    return {
      model: this.modelId,
      effort: this.desired.effort,
      serviceTier: this.desired.serviceTier,
      preset: this.desired.preset,
    }
  }

  /** What `turn/start` says about speed: a tier other than standard is
   * named; standard is said (`null`) only when the thread has another tier
   * to clear, so a turn on standard speed sends nothing, as before. */
  private turnServiceTier(): { serviceTier?: string | null } {
    const tier = this.desired.serviceTier
    if (tier && tier !== CODEX_STANDARD_SERVICE_TIER) return { serviceTier: tier }
    const current = this.threadTier
    if (current && current !== CODEX_STANDARD_SERVICE_TIER) return { serviceTier: null }
    return {}
  }

  /** Why a preset may not be chosen here (the managed policy, the
   * permission profiles, the flags), or undefined when it may. */
  private presetBlocked(preset: CodexAccessPreset): string | undefined {
    return codexPolicy({
      ...this.catalogContext,
      ...(this.permissionProfiles ? { permissionProfiles: this.permissionProfiles } : {}),
    }).blockedModes?.find((mode) => mode.id === preset)?.reason
  }

  /** `preset` if it may be chosen, else the default, else the first that
   * may; with none allowed, `preset` (Codex then says why). */
  private allowedPreset(preset: CodexAccessPreset): CodexAccessPreset {
    if (!this.presetBlocked(preset)) return preset
    const fallback = defaultCodexAccessPreset(this.deps.platform)
    if (!this.presetBlocked(fallback)) return fallback
    return CODEX_ACCESS_PRESETS.find((candidate) => !this.presetBlocked(candidate)) ?? preset
  }

  /** The `thread/settings/update` fields that differ from what Codex last
   * read back, or nothing when all of them already match. A change Codex
   * already has is never sent: it would read nothing back (_probed_). */
  private settingsUpdate(fields: readonly CodexSettingField[]): Partial<v2.ThreadSettingsUpdateParams> | undefined {
    const read = this.readBack
    const update: Partial<v2.ThreadSettingsUpdateParams> = {}
    for (const field of fields) {
      switch (field) {
        case 'model':
          if (this.modelId && this.modelId !== read?.model) update.model = this.modelId
          break
        case 'effort':
          if (this.desired.effort && this.desired.effort !== read?.effort) update.effort = this.desired.effort
          break
        case 'serviceTier':
          if (this.desired.serviceTier && this.desired.serviceTier !== (this.threadTier ?? read?.serviceTier))
            // Standard is no tier (`null` clears it, read back as `default`).
            update.serviceTier =
              this.desired.serviceTier === CODEX_STANDARD_SERVICE_TIER ? null : this.desired.serviceTier
          break
        case 'preset':
          if (this.desired.preset !== read?.preset) {
            update.approvalPolicy = this.access.approvalPolicy
            update.approvalsReviewer = this.access.approvalsReviewer
            update.sandboxPolicy = this.access.sandboxPolicy
          }
          break
      }
    }
    return Object.keys(update).length > 0 ? update : undefined
  }

  private readBackMatches(
    field: string,
    update: Partial<v2.ThreadSettingsUpdateParams>,
    read: CodexReadBack,
  ): boolean {
    switch (field) {
      case 'model':
        return update.model === read.model
      case 'effort':
        return update.effort === read.effort
      case 'serviceTier':
        return (update.serviceTier ?? CODEX_STANDARD_SERVICE_TIER) === read.serviceTier
      case 'approvalPolicy':
      case 'approvalsReviewer':
      case 'sandboxPolicy':
        return read.preset === this.desired.preset
      default:
        return true
    }
  }

  /** The first read-back after `since` that `matches` (the change's own),
   * else, once the control budget runs out, the last one after `since`, or
   * undefined when none came. */
  private settingsReadBack(
    since: number,
    matches: (read: CodexReadBack) => boolean,
  ): Promise<CodexReadBack | undefined> {
    const answer = () => (this.settingsVersion > since ? this.readBack : undefined)
    const now = answer()
    if (now && matches(now)) return Promise.resolve(now)
    return new Promise((resolve) => {
      let grace: NodeJS.Timeout | undefined
      const finish = () => {
        clearTimeout(timer)
        clearTimeout(grace)
        this.settingsWaiters.delete(check)
        resolve(answer())
      }
      // A read-back that does not match is either an earlier change's, with
      // this one's right behind it, or Codex keeping its own value: a short
      // grace tells them apart without holding every change behind it.
      const check = () => {
        const read = answer()
        if (!read) return
        if (matches(read)) return finish()
        if (!grace) {
          grace = setTimeout(finish, SETTINGS_READ_BACK_GRACE_MS)
          grace.unref?.()
        }
      }
      const timer = setTimeout(finish, this.timeouts.controlRequestMs)
      timer.unref?.()
      this.settingsWaiters.add(check)
      check()
    })
  }

  /** `thread/settings/updated`: Codex's word on what the thread now runs
   * with, after a `thread/settings/update` or a `turn/start` with overrides.
   * It replaces the selection, except what a running turn queued for the
   * next one. */
  private settingsUpdated(settings: v2.ThreadSettings): void {
    this.readBack = readBackOf(settings)
    this.threadTier = this.readBack.serviceTier
    this.settingsVersion++
    this.followReadBack()
    this.publish()
    for (const waiter of [...this.settingsWaiters]) waiter()
  }

  /** A thread just opened (`thread/start` or `thread/resume`): its settings
   * are the first read-back. Values the user picked are kept when the
   * catalog offers them; the next turn sends them. */
  private takeOpened(thread: OpenedThread): void {
    const opened = thread.settings
    this.openedWebSearch = thread.webSearch
    // Resumed, it may hold turns; started, it holds none yet.
    this.threadRanTurn = thread.state === 'loaded'
    this.readBack = readBackOf({
      model: opened.model,
      effort: opened.reasoningEffort,
      serviceTier: opened.serviceTier,
      approvalPolicy: opened.approvalPolicy,
      approvalsReviewer: opened.approvalsReviewer,
      sandboxPolicy: opened.sandbox,
    })
    this.threadTier = this.readBack.serviceTier
    this.desired.effort ??= this.readBack.effort ?? undefined
    this.desired.serviceTier ??= this.readBack.serviceTier
    this.fitToModel()
  }

  /** The selection follows the read-back, field by field, unless a running
   * turn queued a change to it. */
  private followReadBack(): void {
    const read = this.readBack
    if (!read) return
    const held = (field: CodexSettingField) => this.queued.has(field) || this.inFlight.has(field)
    if (!held('model') && this.offersModel(read.model)) this.modelId = read.model
    if (!held('effort') && read.effort) this.desired.effort = read.effort
    if (!held('serviceTier')) this.desired.serviceTier = read.serviceTier
    if (!held('preset') && read.preset) this.desired.preset = read.preset
  }

  /** Effort and speed the selected model does not offer fall back to its
   * defaults (a managed policy's first), so a model change never sends a
   * level the new model rejects. */
  private fitToModel(): void {
    const options = this.configOptions()
    const fit = (configId: string, value: string | undefined): string | undefined => {
      const option = options.find((candidate) => candidate.id === configId)
      if (!option || option.type !== 'select') return value
      if (value && option.options.some((entry) => entry.value === value)) return value
      return option.currentValue || undefined
    }
    const model = this.catalogModel()
    if (model && (model.supportedReasoningEfforts ?? []).length === 0) delete this.desired.effort
    else {
      const effort = fit(CODEX_CONFIG.effort, this.desired.effort)
      if (effort) this.desired.effort = effort
      else delete this.desired.effort
    }
    if (model && codexServiceTiers(model, this.catalogContext).length === 0)
      this.desired.serviceTier = CODEX_STANDARD_SERVICE_TIER
    else {
      const tier = fit(CODEX_CONFIG.serviceTier, this.desired.serviceTier)
      if (tier) this.desired.serviceTier = tier
    }
    if (this.desired.webSearch && !codexWebSearchModes(this.catalogContext).includes(this.desired.webSearch))
      delete this.desired.webSearch
  }

  /** The web search mode chosen differs from the one the open thread has:
   * the thread must be opened again for it (`reopenThread`). */
  private configChanged(): boolean {
    return this.desired.webSearch !== this.openedWebSearch
  }

  /** The selected model's row in Codex's catalog. */
  private catalogModel(id: string | undefined = this.modelId): v2.Model | undefined {
    return this.catalog.find((model) => model.id === id) ?? this.catalog.find((model) => model.model === id)
  }

  private offersModel(id: string): boolean {
    return !this.models?.availableModels || this.models.availableModels.some((model) => model.id === id)
  }

  /** The selected model's settings, showing what the next turn runs with. */
  private configOptions(): SessionConfigOption[] {
    const model = this.catalogModel()
    if (!model) return []
    return codexModelConfigOptions(model, this.catalogContext, {
      ...(this.desired.effort ? { effort: this.desired.effort } : {}),
      ...(this.desired.serviceTier ? { serviceTier: this.desired.serviceTier } : {}),
      webSearch: this.desired.webSearch ?? null,
    })
  }

  private modeListing(): ModeListing {
    return codexModeListing(this.desired.preset)
  }

  private showing(): { model?: string; mode?: string; options?: string } {
    return {
      ...(this.modelId ? { model: this.modelId } : {}),
      mode: this.desired.preset,
      options: JSON.stringify(this.configOptions()),
    }
  }

  /** Tell the composer what changed since it was last told: the model, the
   * Access preset, the settings. Before the thread is open there is nobody
   * to tell; the open announces all of it. */
  private publish(): void {
    if (!this.sessionIdValue) return
    const next = this.showing()
    const before = this.shown
    this.shown = next
    if (next.model !== before.model && next.model)
      this.emit(
        routeEvent(this.route(), this.sessionIdValue, 'session', 'current_model_update', {
          ...this.models,
          currentModelId: next.model,
        }),
      )
    if (next.mode !== before.mode)
      this.emit(routeEvent(this.route(), this.sessionIdValue, 'session', 'current_mode_update', this.modeListing()))
    if (next.options !== before.options)
      this.emit(
        routeEvent(this.route(), this.sessionIdValue, 'session', 'config_option_update', {
          configOptions: this.configOptions(),
        }),
      )
  }

  /** An image to a model that cannot read one is refused before the turn,
   * in words, rather than left for Codex to drop or fail. */
  private assertReadsImages(prompt: PromptInput): void {
    if (!prompt.blocks.some((block) => block.type === 'image')) return
    const model = this.catalogModel()
    if (model && !(model.inputModalities ?? []).includes('image'))
      throw new Error(`${model.displayName || model.id} cannot read images. Choose a model that can.`)
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

  /** End the process. A turn still running is interrupted first and given a
   * moment to end, so Codex records it as interrupted rather than cut off,
   * and the session resumes cleanly with its next prompt (after a restart,
   * an update or an eviction). Interactions still waiting settle as the
   * process goes (`settleExit`). */
  async stop(request: TerminationRequest): Promise<SessionRuntimeExit> {
    if (this.exitValue) return this.exitValue
    const first = this.stopRequest === undefined
    this.stopRequest ??= request
    if (this.phaseValue !== 'exited') this.phaseValue = 'stopping'
    if (first) {
      const running = this.active?.turn.runningProcesses() ?? []
      await this.interruptForStop(request.reason)
      await this.stopTerminals(running)
    }
    const client = this.client
    if (client) await client.terminate(request).catch(() => undefined)
    else this.settleExit({ exitCode: null, signal: null, forced: false, at: new Date().toISOString() })
    return this.exited
  }

  dispose(): void {
    void this.stop({ reason: 'disposed' })
  }

  /** Stop the named background terminals (Codex process ids), or every one
   * listed. Never starts a process: terminals live in this one. */
  async stopBackgroundTasks(taskIds?: readonly string[]): Promise<void> {
    if (this.exitValue || this.phaseValue !== 'ready') return
    await this.terminals.stop(taskIds)
  }

  /** Bounded, like the interrupt before it: processes the thread retains
   * are ended before the app-server is, rather than left to outlive it. */
  private async stopTerminals(running: readonly string[]): Promise<void> {
    if (!this.client || this.exitValue) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      this.terminals.stopAll(running),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_TERMINALS_MAX_MS)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
  }

  /** Bounded: a stop never waits long on a process it is about to end. One
   * already being interrupted (a stop after the interrupt grace ran out) is
   * not waited on again. */
  private async interruptForStop(reason: SessionRuntimeStopReason): Promise<void> {
    const active = this.active
    if (!active || active.settled || active.turn.interruptRequested) return
    // Whether or not it can be interrupted, the turn is the host's to end.
    active.stoppedBy = reason
    if (!active.turn.turnId || !this.client || this.exitValue) return
    active.turn.interruptRequested = true
    void this.sendInterrupt(active)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      active.done.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(this.timeouts.interruptGraceMs, STOP_INTERRUPT_MAX_MS))
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
  }

  private settleExit(processExit: ProcessExit): void {
    if (this.exitValue) return
    this.phaseValue = 'exited'
    // Background terminals are children of this process and went with it.
    this.terminals.close()
    const active = this.active
    if (active)
      this.failTurn(
        active,
        active.stoppedBy
          ? new CodexStoppedError(active.stoppedBy)
          : new Error('codex app-server exited during the turn'),
      )
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

/** The settings a thread opened with, as `thread/start` and `thread/resume`
 * both answer them. */
type OpenedSettings = Pick<
  v2.ThreadStartResponse,
  'model' | 'serviceTier' | 'reasoningEffort' | 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'
>

type OpenedThread = {
  threadId: string
  model: string | undefined
  name: string | undefined
  state: 'created' | 'loaded'
  settings: OpenedSettings
  /** The web search mode it was opened with; undefined is the user's config. */
  webSearch: WebSearchMode | undefined
}

/** How long a settings change waits past a read-back that does not match
 * before it takes it as Codex's answer. */
const SETTINGS_READ_BACK_GRACE_MS = 250

/** JSON-RPC's "method not found": an older Codex without the method. */
const RPC_METHOD_NOT_FOUND = -32601

/** Codex took a settings change but read back another value: the value it
 * kept stands, and the change is refused. */
class CodexSettingsKeptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexSettingsKeptError'
  }
}

function readBackOf(settings: {
  model: string
  effort: string | null
  serviceTier: string | null
  approvalPolicy: v2.AskForApproval
  approvalsReviewer: v2.ApprovalsReviewer
  sandboxPolicy: v2.SandboxPolicy
}): CodexReadBack {
  return {
    model: settings.model,
    effort: settings.effort,
    // No tier is standard speed, which Codex itself reads back as `default`.
    serviceTier: settings.serviceTier ?? CODEX_STANDARD_SERVICE_TIER,
    preset: codexAccessPresetOf(settings),
  }
}

function readBackValue(field: string, read: CodexReadBack): string {
  switch (field) {
    case 'model':
      return read.model
    case 'effort':
      return read.effort ?? 'its default effort'
    case 'serviceTier':
      return read.serviceTier
    default:
      return read.preset ?? 'other access settings'
  }
}

/** `thread/resume` found a subagent's thread where a session's was stored. */
class CodexSubagentThreadError extends Error {
  constructor(threadId: string) {
    super(`Codex thread ${threadId} belongs to a subagent, not a session`)
    this.name = 'CodexSubagentThreadError'
  }
}

/** A turn Codex itself reported as failed, with Codex's typed error. */
export class CodexTurnFailedError extends Error {
  constructor(
    message: string,
    readonly turnError?: v2.TurnError,
  ) {
    super(message)
    this.name = 'CodexTurnFailedError'
  }
}

/** The thread was closed, archived or deleted outside openmanager while a
 * turn ran: Codex will not finish that turn for this connection. */
export class CodexThreadGoneError extends Error {
  constructor(readonly change: 'closed' | 'archived' | 'deleted') {
    super(`Codex thread was ${change} outside OpenManager during the turn`)
    this.name = 'CodexThreadGoneError'
  }
}

/** The host stopped the process under a running turn. */
export class CodexStoppedError extends Error {
  constructor(readonly reason: SessionRuntimeStopReason) {
    super(`OpenManager stopped Codex (${reason}) before the turn finished`)
    this.name = 'CodexStoppedError'
  }
}

/** Why the host stopped a process under a turn, in the user's words. */
const STOP_DETAIL: Partial<Record<SessionRuntimeStopReason, string>> = {
  disposed: 'OpenManager restarted or updated before the turn finished.',
  cwd_changed: 'The session moved to another folder before the turn finished.',
  superseded: 'The session moved before the turn finished.',
  evicted: 'Codex was stopped to make room for other sessions before the turn finished.',
}

/** What went wrong, typed, for the turn's terminal error. */
function problemOf(error: unknown): ProviderProblem | undefined {
  if (error instanceof CodexTurnFailedError)
    return error.turnError ? codexProblem(error.turnError) : undefined
  // Reopened with the next message, so sending it again is what helps.
  if (error instanceof CodexThreadGoneError) return { code: 'unknown', action: 'retry', detail: error.message }
  // Not the user's Stop: the turn can be sent again.
  if (error instanceof CodexStoppedError)
    return {
      code: 'unknown',
      action: 'retry',
      detail: STOP_DETAIL[error.reason] ?? 'Codex was stopped before the turn finished.',
    }
  if (error instanceof CodexRpcError) return codexRpcProblem(error.data, error.message)
  return undefined
}

/** The host's messages as Responses API items for `thread/inject_items`,
 * newest kept within the bound, each one cut to its own. */
export function handoverItems(
  history: readonly { role: 'user' | 'assistant'; text: string }[],
): v2.ThreadInjectItemsParams['items'] {
  const items: v2.ThreadInjectItemsParams['items'] = []
  let total = 0
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!
    const text =
      message.text.length > HANDOVER_MESSAGE_MAX_CHARS
        ? `${message.text.slice(0, HANDOVER_MESSAGE_MAX_CHARS)}…`
        : message.text
    if (total + text.length > HANDOVER_TOTAL_MAX_CHARS) break
    total += text.length
    items.unshift({
      type: 'message',
      role: message.role,
      content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text }],
    })
  }
  return items
}

/** Why a steer was refused, for the log the host writes when it queues the
 * message instead: `no_turn` (nothing running here), `turn_ended` (Codex's
 * turn ended, or is another one), `not_steerable` (a review or compaction). */
export class CodexSteerRefusedError extends Error {
  constructor(
    readonly reason: 'no_turn' | 'turn_ended' | 'not_steerable',
    message: string,
  ) {
    super(message)
    this.name = 'CodexSteerRefusedError'
  }
}

/** `turn/steer`'s refusals, by kind. Codex answers `-32600` both for a turn
 * that is not the active one ("expected active turn id `x` but found `y`",
 * "no active turn to steer", probed on 0.170) and for one that cannot be
 * steered, which also names `activeTurnNotSteerable` (`CodexErrorInfo`;
 * _probed_ on 0.170: "cannot steer a review turn", the `review` fixture). It
 * is recognised by name anywhere in the error. The runtime refuses a steer
 * into its own operation turns before asking. Any other error is passed on as
 * it is. `steer` only calls this for an answer Codex gave (`CodexRpcError`):
 * a missing answer is no refusal. */
export function steerRefusal(error: unknown): Error {
  if (error instanceof CodexRpcError) {
    const detail = `${error.message} ${JSON.stringify(error.data ?? null)}`
    if (/activeTurnNotSteerable|not.steerable/i.test(detail))
      return new CodexSteerRefusedError(
        'not_steerable',
        `Codex cannot steer this turn: ${error.message}`,
      )
    if (error.code === -32600)
      return new CodexSteerRefusedError(
        'turn_ended',
        `Codex no longer runs that turn: ${error.message}`,
      )
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** A review's target in Codex's spelling. */
export function codexReviewTarget(target: Extract<TurnOperation, { kind: 'review' }>['target']): v2.ReviewTarget {
  switch (target.type) {
    case 'uncommitted_changes':
      return { type: 'uncommittedChanges' }
    case 'base_branch':
      return { type: 'baseBranch', branch: target.branch }
    case 'commit':
      return { type: 'commit', sha: target.sha, title: target.title ?? null }
    case 'custom':
      return { type: 'custom', instructions: target.instructions }
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

/** `thread/resume` for a thread archived outside openmanager: `-32600`
 * with "session … is archived. Run `codex unarchive …`" (_probed_ on 0.170). */
export function isArchivedThread(error: unknown): boolean {
  if (!(error instanceof CodexRpcError) || error.code !== -32600) return false
  return /is archived/i.test(error.message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
