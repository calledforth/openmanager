import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ProofCommandSchemas,
  ProofEventSchemas,
  ProofResponseSchemas,
  BACKGROUND_TASKS_MAX,
  shouldReplaceSessionTitle,
  TURN_FAILURE_MESSAGES,
  titleFromPrompt,
  WorkspaceUnavailableDetailsSchema,
  type BackgroundTask,
  type CommandEnvelope,
  type DraftContent,
  type ErrorCode,
  type TransientEvent,
  type Interaction,
  type InteractionKind,
  type InteractionResponse,
  type Message,
  type ProofEvent,
  type ProofResponse,
  type Session,
  type SessionStatus,
  type SessionSummary,
  type SubscriptionScope,
  type SessionTitleSource,
  type Thread,
  type TurnFailureReason,
  type Turn,
  type TurnStart,
  type WorkspaceComposerPreference,
  type Cursor,
} from '@openmanager/protocol/node'
import {
  projectAgentEvent,
  providers,
  SessionUnknownError,
  type AgentRuntime,
  type HostDeps,
  type ProtocolEventContext,
  type RuntimeSessionArgs,
} from '@agentpack/runtime/node'
import {
  cancelledInteractionIds,
  findOpenTurnId,
  findSessionIdByProviderSession,
  findTurnByCommandId,
  getProviderSessionId,
  getSessionSummary,
  hasInteraction,
  listAllSessionSummaries,
  listThreadsForSession,
  readThreadState,
  type ThreadState,
} from './db/session-store.ts'
import type { ArtifactStore } from './artifacts.ts'
import { waitingKind } from './db/session-activity.ts'
import type { WriteOptions } from './db/event-repository.ts'
import { sessionDeletionEvents } from './db/deletions.ts'
import type { CommandContext } from './command-context.ts'
import { formatTitleContext, type TitleContextMessage } from './session-titles/context.ts'
import { TitleGenerationError, type TitleGenerator } from './session-titles/generator.ts'
import type { GeneratedTitle, TitlePromptInput } from './session-titles/prompts.ts'
import {
  countUserMessages,
  readTitleTranscript,
  titleMessage,
} from './session-titles/transcript.ts'

type ProviderId = keyof typeof providers

const WORKSPACE_UNAVAILABLE =
  'The workspace folder is unavailable. Restore its path or permissions, then try again.'
const SESSION_WORKSPACE_UNAVAILABLE =
  'The session folder is missing, moved, or inaccessible on this environment. Restore the original folder path or its permissions, then try again. Your session is still listed.'
const ARTIFACTS_UNAVAILABLE = 'These images are no longer available. Attach them again.'
const SEND_WORKSPACE_UNAVAILABLE =
  'The session folder is unavailable. Restore the original folder path or its permissions, then reopen the session.'
type RuntimeEvent = Parameters<HostDeps['emitEvent']>[0]
type ProviderGate = {
  rejection(providerId: string): { code: ErrorCode; message: string } | undefined
}
export type WorkspaceRuntimeRoute = {
  providerId: string
  /** Providers offered by this workspace; legacy resolver seams offer their single route. */
  providers?: readonly string[]
  cwd: string
  /**
   * Called once the provider has actually opened a session in the workspace.
   * Bookkeeping only: the host owns reporting a failure, and a throw here
   * never affects the session the client already holds.
   */
  onSessionStarted?: () => void
}
export type WorkspaceRuntimeResolver = (
  workspaceId: string,
  context?: CommandContext,
) => WorkspaceRuntimeRoute | undefined
type ActiveTurn = {
  turn: Turn
  /** Absent on a turn the provider began by itself; nobody prompted it. */
  userMessage?: Message
  interruptRequested: boolean
  promptStarted?: boolean
  /** Includes host terminal bookkeeping, not just the provider completion event. */
  completion?: Promise<void>
  promptFailed?: boolean
  runtimeMessageId?: string
  /**
   * The message id of a turn the provider began by itself just before this
   * turn's prompt reached it. The provider finishes that turn first, so what
   * it says and asks meanwhile is filed under this one: otherwise a permission
   * request raised there would reach nobody and hold this prompt up behind it.
   */
  foldedMessageId?: string
  /**
   * The open text and reasoning runs of the turn, as host message ids. A run
   * is a maximal stretch of one kind of stream event: the next event of any
   * other kind (a thought after text, a tool call, the end of a block) closes
   * it, and the next event of that kind opens a fresh one with a new id. That
   * is the rule the desktop projector applies to its parts; carrying it here
   * lets every client keep thoughts, text and tools in the order they happened.
   */
  textRunId?: string
  reasoningRunId?: string
  /**
   * Thoughts of this turn that no `stop` has closed yet, by host message id.
   * ACP providers never frame their thoughts, so the server closes them when
   * the provider moves on to text or a tool (docs/sync-foundations.md §4.3.3).
   */
  openReasoning?: Set<string>
  /** The mode the host is starting this turn in (a plan build), if it chose one. */
  modeId?: string
  generatedImages?: Set<string>
  toolIds: Map<string, string>
  interactionIds: Map<string, string>
  /** Each open request's kind and when it was raised, by host id. */
  pendingInteractions: Map<string, { kind: InteractionKind; createdAt: number }>
}

/**
 * Events that take their own place in the transcript, or end it. Any of them
 * between two chunks of a run splits the run. Bookkeeping the provider sends
 * mid-stream (usage, mode, model, command lists, a resolved request) does not.
 */
const RUN_BREAKING_EVENTS: ReadonlySet<RuntimeEvent['event']> = new Set<RuntimeEvent['event']>([
  'tool_call',
  'tool_call_update',
  'tool_call_content',
  'permission_request',
  'question_request',
  'plan_review_request',
  'plan_update',
  'subtask_update',
  'extension_request',
  'extension_notification',
  'rpc_error',
  'runtime_error',
  'auth_required',
  'capability_missing',
  'prompt_completed',
])

/**
 * The host message id an event of the turn is filed under. Text and thought
 * chunks continue their open run or start a new one; a run-breaking event
 * closes both runs, so the next chunk of either kind starts fresh. A thought's
 * `stop` closes its own run after it is filed, which keeps providers that frame
 * their blocks (Claude Code) at one id per block.
 */
function runMessageId(active: ActiveTurn, event: RuntimeEvent): string | undefined {
  if (event.event === 'agent_message_chunk') {
    active.reasoningRunId = undefined
    return (active.textRunId ??= randomUUID())
  }
  if (event.event === 'agent_thought_chunk') {
    active.textRunId = undefined
    const id = (active.reasoningRunId ??= randomUUID())
    if (event.data.phase === 'stop') active.reasoningRunId = undefined
    return id
  }
  if (RUN_BREAKING_EVENTS.has(event.event)) {
    active.textRunId = undefined
    active.reasoningRunId = undefined
  }
  return active.runtimeMessageId
}
/**
 * What the host remembers about one interaction, so a resolve command can be
 * checked against the request and answered the same way twice.
 */
/** What a status event says beside the status; see db/session-activity.ts. */
type StatusActivity = { waitingOn: InteractionKind | null; inBackground: boolean }

function summaryActivity(
  activity: StatusActivity,
): Pick<SessionSummary, 'waitingOn' | 'inBackground'> {
  return {
    ...(activity.waitingOn ? { waitingOn: activity.waitingOn } : {}),
    ...(activity.inBackground ? { inBackground: true as const } : {}),
  }
}

type InteractionEntry = {
  /** The provider's own request id; clients only ever see the host id. */
  providerRequestId: string
  turnId: string
  interaction: Interaction
  settled: boolean
  resolution?: InteractionResponse
  result?: Promise<ProofResponse<'interaction.respond'> | ReturnType<typeof errorResult>>
  startBuild?: () => NonNullable<InteractionEntry['result']>
  /** The answer this host forwarded, and the command id that carried it. */
  answer?: InteractionAnswer
}
type InteractionAnswer = {
  clientId?: string
  commandId?: string
  response: InteractionResponse
  build?: { text: string; modeId?: string }
}

type InteractionRuntime = Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'> &
  // Optional so a host without interactive providers still assembles.
  Partial<
    Pick<
      AgentRuntime,
      | 'respondPermission'
      | 'respondQuestion'
      | 'respondPlan'
      | 'stopBackgroundTasks'
      | 'closeThread'
    >
  >
type ThreadRecord = {
  session: Session
  /** Provenance of `session.title`, so a rename outranks later automatic titles. */
  titleSource?: SessionTitleSource
  thread: Thread
  providerId: ProviderId
  cwd: string
  runtimeSession: Promise<string>
  turns: Turn[]
  messages: Message[]
  /** What each command id already started here, so a retry never runs twice. */
  commandTurns: Map<string, TurnStart>
  /** Every interaction this thread raised, by host id, pending or settled. */
  interactions: Map<string, InteractionEntry>
  status: SessionStatus
  updatedAt: number
  /** In-memory mode only; with SQLite the row is the single source. */
  settledAt?: number
  /** In-memory mode only: when the last turn completed, until acknowledged. */
  doneAt?: number
  activeTurn?: ActiveTurn
  /**
   * Work the provider still has running between turns, under host ids. While
   * there is any, the session rests at `running` rather than `idle`.
   */
  backgroundTasks?: BackgroundTask[]
  /** The host id of each live background task, by the provider's own id. */
  backgroundTaskIds?: Map<string, string>
  /** In-memory mode only: what the last status event said beside the status. */
  announced?: StatusActivity
  /**
   * The start of a turn the provider began by itself that could not be
   * written. Kept so the turn's next event can try again.
   */
  unrecordedBackgroundTurn?: RuntimeEvent
  /** A session-scoped cancel must drain before another prompt can start. */
  cancellation?: Promise<void>
  pendingBuild?: boolean
  /**
   * The draft images this session's launch claimed. A rolled-back launch
   * hands them back before the session's deletion would take them along, so
   * the draft it restores has its images.
   */
  claimedArtifacts?: string[]
}

/** Why a session the rows hold could not be loaded: the answer an open gives. */
export type LoadRefusal = { code: ErrorCode; message: string; details?: unknown }
type SessionOpenPosition = { environment: Cursor; session: Cursor }

type Loaded =
  | { refused: LoadRefusal }
  | { session: SessionSummary; threads: Thread[]; at: SessionOpenPosition }

const errorResult = (requestId: string, code: ErrorCode, message: string, details?: unknown) => ({
  type: 'error' as const,
  requestId,
  error: { code, message, ...(details === undefined ? {} : { details }) },
})

const turnSendResult = (requestId: string, started: TurnStart) =>
  ProofResponseSchemas['turn.send'].parse({ type: 'response', requestId, payload: started })

/**
 * Whether a repeat is the same answer. Two command ids decide it outright, so
 * a second client sending an identical answer still loses; without ids on both
 * sides the answer itself is all there is to compare.
 */
function sameAnswer(first: InteractionAnswer, second: InteractionAnswer): boolean {
  if (JSON.stringify(first.build) !== JSON.stringify(second.build)) return false
  if (first.commandId && second.commandId) return first.commandId === second.commandId
  // Both were parsed by the same schema, so key order is stable.
  return JSON.stringify(first.response) === JSON.stringify(second.response)
}

/** Why a response does not fit the request it answers, if it does not. */
function invalidResponse(interaction: Interaction, response: InteractionResponse): string | null {
  if (interaction.kind !== response.kind) return 'Response does not match the interaction kind.'
  if (
    response.outcome.outcome === 'cancelled' &&
    (response.outcome.reason === 'turn_ended' || response.outcome.reason === 'server_restarted')
  )
    return 'Only the environment cancels a request for that reason.'
  if (interaction.kind === 'permission' && response.kind === 'permission') {
    const { outcome } = response
    if (
      outcome.outcome === 'selected' &&
      !interaction.options.some((option) => option.optionId === outcome.optionId)
    )
      return 'Unknown permission option.'
    return null
  }
  if (interaction.kind === 'question' && response.kind === 'question') {
    if (response.outcome.outcome !== 'answered') return null
    const answered = new Set<string>()
    for (const answer of response.outcome.answers) {
      const question = interaction.questions.find((item) => item.questionId === answer.questionId)
      if (!question) return 'Unknown question.'
      if (answered.has(answer.questionId)) return 'A question was answered twice.'
      answered.add(answer.questionId)
      const selected = answer.selectedOptionIds ?? []
      if (selected.some((id) => !question.options.some((option) => option.optionId === id)))
        return 'Unknown question option.'
      if (selected.length > 1 && !question.allowMultiple) return 'This question accepts one option.'
    }
  }
  return null
}

/**
 * Own the host identities and runtime routes used by the proof-slice commands.
 *
 * Runtime work is deliberately queued in a microtask. The returned command
 * result is therefore written to the socket before a provider can emit an
 * event, including providers that emit synchronously while opening a session.
 */
export function createThreadService(
  runtime: InteractionRuntime,
  providerGate: ProviderGate,
  /**
   * Where durable events go. With a database (`options.database`) they reach
   * the event repository, whose terminal path closes a turn's open children
   * with their own events (db/turn-closure.ts). Without one (unit tests
   * only) nothing writes those closes, unlike the environment-client mock,
   * which plays the server and does (docs/sync-foundations.md §4.3 (e)).
   */
  appendEvent: (event: ProofEvent) => void,
  /** A transient (`turn.notice`): the event service places it among the durable events. */
  publishTransient: (event: TransientEvent) => void = () => undefined,
  // Routing is by registered workspace ID only (D9): there is no default that
  // treats the ID as a path, so an unregistered workspace can never run.
  resolveWorkspace: WorkspaceRuntimeResolver = () => undefined,
  options: {
    artifacts?: ArtifactStore
    database?: DatabaseSync
    flush?: () => void
    /** A stream's head, for stating where a read stands. */
    head?: (scope: SubscriptionScope) => Cursor
    /**
     * Commit several host events together; falls back to one append per
     * event. `options` carries host-private facts that ride the write, such
     * as a child session's provider identity.
     */
    appendAtomic?: (events: readonly ProofEvent[], options?: WriteOptions) => void
    /**
     * Write one turn's end now, throwing when it fails instead of keeping it
     * for a retry. Falls back to `appendEvent`.
     */
    finalizeNow?: (event: ProofEvent) => void
    /**
     * A failed write on the provider-driven path is reported here and the
     * batch stays queued for the next append. Without a handler it throws.
     */
    onPersistenceError?: (error: unknown, eventName: string) => void
    /**
     * Why `resolveWorkspace` refused, so a registered folder that vanished is
     * answered as recoverable instead of as a missing resource. Without it
     * every refusal reads as an unknown workspace, which is the old behaviour.
     */
    workspaceAvailability?: (
      workspaceId: string,
    ) => 'unknown' | 'available' | 'missing' | 'inaccessible'
    /**
     * A turn started in a mode the host chose itself (a plan build), with no
     * `composer.mode.set` for other clients' composers to have followed.
     * Reported once the provider has started the prompt, never for a launch
     * that failed.
     */
    onSessionMode?: (sessionId: string, modeId: string) => void
    /**
     * Files a draft's picks, if it has any, as the workspace's "last used" for
     * this provider, and answers the preference the new session launches on:
     * what the draft showed. Called before the session exists; a throw refuses
     * the create. Absent, a create that carries picks is refused rather than
     * started on something else.
     */
    launchPreference?: (
      workspaceId: string,
      providerId: string,
      picks?: WorkspaceComposerPreference,
    ) => WorkspaceComposerPreference
    /**
     * Gives a new session its own model and config, from the preference it
     * launched on, before its provider starts. The provider is configured from
     * the session's selection first, so another draft launching in the same
     * workspace, which files its picks over that shared preference, cannot
     * seed this session with them.
     */
    seedSessionComposer?: (
      sessionId: string,
      selection: Pick<WorkspaceComposerPreference, 'modelId' | 'configValues'>,
    ) => void
    /**
     * The draft a create sends: its deletion commits with the session, and is
     * undone if the session is rolled back. Absent, a create naming a draft
     * is refused rather than leaving the draft behind.
     */
    drafts?: {
      launch(
        draftId: string,
        sent: { workspaceId: string; sessionId: string; content: DraftContent },
      ): { event: ProofEvent; restore: () => void } | { error: string }
    }
    /**
     * Names sessions with the environment's title model: from the first
     * prompt, once more after the first turn when that prompt was too vague,
     * and on request. Absent, sessions keep the fallback and agent titles.
     */
    titles?: TitleGenerator
    /** A title pass that failed or was overtaken; nothing the user waits on. */
    onTitleFailure?: (sessionId: string, error: unknown) => void
  } = {},
) {
  const sessions = new Map<string, ThreadRecord>()
  const threads = new Map<string, ThreadRecord>()
  /** Host session per `providerId:providerSessionId` registered as a child this process. */
  const childSessionIds = new Map<string, string>()
  /**
   * Children the user deleted while this process runs, by the same key. The
   * parent turn that delegated them may still report the subtask, and that
   * report must not quietly recreate what the user removed.
   */
  const forgottenChildren = new Set<string>()
  // Supplied after construction so the service can be assembled before the
  // WebSocket publisher exists.
  let environmentId = ''

  const route = (record: ThreadRecord, sessionId?: string): RuntimeSessionArgs => ({
    providerId: record.providerId,
    threadId: record.thread.threadId,
    workspaceId: record.session.workspaceId,
    cwd: record.cwd,
    ...(sessionId ? { sessionId } : {}),
    // A sub-agent's transcript lives in the agent: a fresh session in its
    // place would lose it, so the runtime may only load it, on every start and
    // every respawn (docs/sync-foundations.md §4.7.4 (e)).
    ...(record.session.parentSessionId ? { load: 'require' as const } : {}),
  })

  /**
   * Sessions this process learned it can never open: a sub-agent's chat the
   * agent no longer knows. The loader answers them `session_unrecoverable`.
   */
  const unrecoverable = new Set<string>()
  const UNRECOVERABLE: LoadRefusal = {
    code: 'session_unrecoverable',
    message:
      "This chat's history lives in the agent and can't be reopened. Delete it to remove it.",
  }

  /**
   * Make the identity a runtime reports durable, when it differs from the
   * stored one: a session created because there was none (a crash between
   * creation and its stamp), or because the agent had forgotten the stored
   * one. Before any prompt may use it: every prompt awaits `runtimeSession`,
   * and a respawn inside a prompt reports through `session_created`, which
   * stamps before the prompt is sent (§4.7.4).
   */
  const stampIdentity = (record: ThreadRecord, providerSessionId: string): string => {
    // A sub-agent's session is only ever loaded, never created (see `route`).
    if (!options.database || record.session.parentSessionId) return providerSessionId
    const row = options.database
      .prepare('SELECT provider_session_id FROM sessions WHERE session_id = ?')
      .get(record.session.sessionId) as { provider_session_id: string | null } | undefined
    // Deleted while its provider session resolved: nothing left to stamp.
    if (!row || row.provider_session_id === providerSessionId) return providerSessionId
    return persistRuntimeSession(record, providerSessionId)
  }
  /**
   * Persist the opaque identity before allowing prompts to use the provider
   * session. Host-private and not activity (docs/sync-foundations.md §4.4):
   * it writes the identity alone, never `updated_at`, so no client-visible
   * field changes and no event is owed. The row's provider was written by
   * `session.created`; a row that is gone or names another provider is
   * refused rather than silently left unstamped.
   */
  const persistRuntimeSession = (record: ThreadRecord, providerSessionId: string): string => {
    const database = options.database
    if (!database) return providerSessionId
    const stamped = database
      .prepare(
        'UPDATE sessions SET provider_session_id = ? WHERE session_id = ? AND provider_id = ?',
      )
      .run(providerSessionId, record.session.sessionId, record.providerId)
    if (stamped.changes !== 1) {
      throw new Error(
        `Session ${record.session.sessionId} has no row on provider ${record.providerId} to stamp`,
      )
    }
    return providerSessionId
  }

  const threadScope = (record: ThreadRecord) =>
    ({
      type: 'thread',
      environmentId,
      sessionId: record.session.sessionId,
      threadId: record.thread.threadId,
    }) as const

  /**
   * Answer a workspace that would not resolve. A registered folder that is
   * gone or unreadable is a recoverable state the client can explain and
   * retry; only an ID the environment does not know is a missing resource.
   */
  const rejectWorkspace = (requestId: string, workspaceId: string, message: string) => {
    const availability = options.workspaceAvailability?.(workspaceId) ?? 'unknown'
    return availability === 'missing' || availability === 'inaccessible'
      ? errorResult(
          requestId,
          'workspace_unavailable',
          message,
          WorkspaceUnavailableDetailsSchema.parse({ workspaceId, availability }),
        )
      : errorResult(requestId, 'not_found', 'Workspace not found.')
  }

  const rejectProvider = (requestId: string, providerId: string) => {
    const rejection = providerGate.rejection(providerId)
    return rejection ? errorResult(requestId, rejection.code, rejection.message) : undefined
  }

  // Provider callbacks and turn settlement must not fail because a write did:
  // the in-memory turn still settles, and the host decides how to report it.
  // Answers whether the event committed, so what memory records about the
  // event itself (requests, their answers, open thoughts) follows only a
  // committed write (I11).
  const appendRuntimeEvent = (event: ProofEvent): boolean => {
    let committed = true
    try {
      appendEvent(event)
    } catch (error) {
      if (!options.onPersistenceError) throw error
      options.onPersistenceError(error, event.name)
      committed = false
    }
    if (
      event.name === 'turn.completed' ||
      event.name === 'turn.interrupted' ||
      event.name === 'turn.failed'
    ) {
      const record = threads.get(event.scope.threadId)
      // Mirrors the SQLite projection: only a completed turn leaves news
      // behind, and not while background work is still running.
      if (record) {
        record.doneAt =
          event.name === 'turn.completed' && !record.backgroundTasks?.length
            ? Date.parse(event.timestamp)
            : undefined
      }
      // Deferred until the caller has marked the turn completed, which it
      // does right after announcing it.
      if (record && event.name === 'turn.completed') queueMicrotask(() => refineTitle(record))
      // The requests the turn left open were closed by `interaction.cancelled`
      // events committed with its end (db/turn-closure.ts). Memory follows
      // those committed rows, never a write that failed (I11). Without a
      // database (unit tests only) there are no rows; the turn's end settles
      // every request it left open.
      const cancelled =
        committed && options.database
          ? cancelledInteractionIds(options.database, event.payload.turnId)
          : undefined
      for (const entry of committed ? (record?.interactions.values() ?? []) : []) {
        if (entry.turnId !== event.payload.turnId || entry.settled) continue
        if (cancelled && !cancelled.has(entry.interaction.interactionId)) continue
        entry.settled = true
        if (entry.interaction.lifecycle) {
          entry.interaction = {
            ...entry.interaction,
            lifecycle: {
              ...entry.interaction.lifecycle,
              state: 'cancelled',
              resolvedAt: event.timestamp,
            },
          }
        }
      }
    }
    return committed
  }

  const emitInterrupted = (
    record: ThreadRecord,
    turnId: string,
    reason: 'user' | 'server_restarted' = 'user',
  ) => {
    appendRuntimeEvent(
      ProofEventSchemas['turn.interrupted'].parse({
        type: 'event',
        name: 'turn.interrupted',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        scope: {
          type: 'thread',
          environmentId: environmentId,
          sessionId: record.session.sessionId,
          threadId: record.thread.threadId,
        },
        payload: { turnId, reason },
      }),
    )
  }

  const emitCompleted = (record: ThreadRecord, turnId: string) => {
    appendRuntimeEvent(
      ProofEventSchemas['turn.completed'].parse({
        type: 'event',
        name: 'turn.completed',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        scope: threadScope(record),
        payload: { turnId },
      }),
    )
  }

  /** Whether the rows still hold a record's thread: a deletion takes them with it. */
  const threadHeld = (record: ThreadRecord) => {
    if (!options.database) return false
    options.flush?.()
    return listThreadsForSession(options.database, record.session.sessionId).some(
      (thread) => thread.threadId === record.thread.threadId,
    )
  }

  const emitFailed = (
    record: ThreadRecord,
    turnId: string,
    reason: TurnFailureReason = 'provider_error',
  ) => {
    appendRuntimeEvent(
      ProofEventSchemas['turn.failed'].parse({
        type: 'event',
        name: 'turn.failed',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        scope: threadScope(record),
        payload: {
          turnId,
          reason,
          message: TURN_FAILURE_MESSAGES[reason],
        },
      }),
    )
  }

  /**
   * The turn a command id already started, read from the log. Pending events
   * are flushed first so a retry that arrives before the batch was written
   * still finds its turn.
   */
  const findPersistedTurn = (sessionId: string, threadId: string, commandId: string) => {
    if (!options.database) return undefined
    options.flush?.()
    return findTurnByCommandId(options.database, { sessionId, threadId, commandId })
  }

  /** The workspace of a session whose thread is no longer in memory. */
  const persistedWorkspaceId = (sessionId: string) => {
    if (!options.database) return undefined
    options.flush?.()
    return getSessionSummary(options.database, sessionId)?.workspaceId
  }

  /**
   * Announce a session and its thread, in one write. `session.created`
   * carries the whole row in the canonical form a listing reads back, so a
   * client that only hears the event holds what a fresh load would
   * (docs/sync-foundations.md §4.7.2). Returns the time the session was
   * announced at.
   */
  const persistCreatedThread = (
    session: Session,
    thread: Thread,
    created: {
      providerId: ProviderId
      titleSource?: SessionTitleSource
      alongside?: readonly ProofEvent[]
      /** The provider's own id for the session, when it is known before the row exists (a child). */
      identity?: string
    },
  ): string => {
    const timestamp = new Date().toISOString()
    const announced = ProofEventSchemas['session.created'].parse({
      type: 'event',
      name: 'session.created',
      eventId: randomUUID(),
      timestamp,
      scope: { type: 'environment', environmentId },
      payload: {
        session: {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          title: session.title,
          ...(created.titleSource ? { titleSource: created.titleSource } : {}),
          ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
          status: 'idle',
          providerId: created.providerId,
          updatedAt: timestamp,
          settledAt: null,
          doneAt: null,
        },
      },
    })
    const threadCreated = ProofEventSchemas['thread.created'].parse({
      type: 'event',
      name: 'thread.created',
      eventId: randomUUID(),
      timestamp,
      scope: { type: 'session', environmentId, sessionId: session.sessionId },
      payload: { thread },
    })
    const alongside = created.alongside ?? []
    if (options.appendAtomic) {
      options.appendAtomic(
        [announced, threadCreated, ...alongside],
        created.identity ? { identities: { [session.sessionId]: created.identity } } : undefined,
      )
      return timestamp
    }
    // Without an atomic writer there is no database (unit tests only), so
    // there is no row for an identity to ride on.
    appendEvent(announced)
    appendEvent(threadCreated)
    alongside.forEach(appendEvent)
    return timestamp
  }

  /**
   * Forget a session, every thread record that belongs to it, and every child
   * session under it. Restored sessions can hold several thread records, so
   * cleanup has to be session-wide or a partially available session is left
   * behind. Children go with the parent because SQLite cascades them the same
   * way; a live child record outliving its deleted parent row could still
   * prompt the provider.
   */
  const dropSessionRecords = (sessionId: string): ThreadRecord[] => {
    const dropped: ThreadRecord[] = []
    const pending = [sessionId]
    const seen = new Set<string>()
    while (pending.length) {
      const id = pending.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      sessions.delete(id)
      forgetTitleWork(id)
      for (const [threadId, item] of threads) {
        if (item.session.parentSessionId === id) pending.push(item.session.sessionId)
        if (item.session.sessionId !== id) continue
        threads.delete(threadId)
        dropped.push(item)
      }
    }
    for (const [key, hostId] of childSessionIds) {
      if (seen.has(hostId)) childSessionIds.delete(key)
    }
    return dropped
  }

  /**
   * Abandon a dropped record's turn and stop any provider work behind it. The
   * turn is cleared before the provider session resolves so a prompt that never
   * ran cannot finalize as completed.
   */
  const abandonTurn = (item: ThreadRecord) => {
    if (!item.activeTurn) return
    item.activeTurn.interruptRequested = true
    item.activeTurn = undefined
    void item.runtimeSession
      .then((sessionId) => runtime.cancel({ ...route(item), sessionId }))
      .catch(() => undefined)
  }

  /**
   * End the background work of a dropped record. Nothing can reach it any
   * more to stop it, and a provider process with background work is never
   * stopped for being idle, so it would run on until the server exits.
   */
  const abandonBackgroundWork = (item: ThreadRecord) => {
    if (!item.backgroundTasks?.length) return
    item.backgroundTasks = undefined
    item.backgroundTaskIds = undefined
    void runtime
      .closeThread?.({ providerId: item.providerId, threadId: item.thread.threadId })
      .catch(() => undefined)
  }

  /** Let go of a record nothing points at any more, and whatever it was running. */
  const abandon = (item: ThreadRecord) => {
    abandonTurn(item)
    abandonBackgroundWork(item)
  }

  /**
   * Rebuild in-memory records for a session that only exists in SQLite, so the
   * runtime loads the stored provider thread instead of creating a second one.
   * A failed load drops the records again, keeping durable history and letting
   * another open retry.
   */
  const restoreSession = (
    session: SessionSummary,
    providerId: ProviderId,
    providerSessionId: string | undefined,
    cwd: string,
    restoredThreads: Thread[],
  ) => {
    const records: ThreadRecord[] = []
    for (const thread of restoredThreads) {
      const record: ThreadRecord = {
        session: {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          title: session.title,
          ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
        },
        thread,
        providerId,
        cwd,
        runtimeSession: Promise.resolve().then(() => {
          if (threads.get(thread.threadId) !== record) throw new Error('Session was closed.')
          return runtime
            .ensureSession(route(record, providerSessionId))
            .then((result) => stampIdentity(record, result.sessionId))
        }),
        turns: [],
        messages: [],
        commandTurns: new Map(),
        interactions: new Map(),
        titleSource: session.titleSource,
        status: session.status,
        updatedAt: Date.parse(session.updatedAt),
      }
      void record.runtimeSession.catch((error: unknown) => {
        // A sub-agent's chat the agent no longer knows can never be opened:
        // nothing was created in its place and its identity is kept.
        if (error instanceof SessionUnknownError) unrecoverable.add(session.sessionId)
        // One thread failing to load leaves the session half attached, so the
        // whole restore is abandoned and a later open retries it from SQLite.
        const current = sessions.get(session.sessionId)
        if (current && records.includes(current)) dropSessionRecords(session.sessionId)
      })
      records.push(record)
      threads.set(thread.threadId, record)
    }
    if (records[0]) sessions.set(session.sessionId, records[0])
  }

  /**
   * Load a session the rows hold and memory does not (docs/sync-foundations.md
   * §4.7.3), with the checks an open makes, in its order: the summary, the
   * provider's capability and health, the workspace (with the caller's
   * context), the threads. Then the records, whose `runtimeSession` asks the
   * provider for the session; every prompt awaits it. Synchronous: the
   * records exist before the caller goes on, so a second command finds them.
   * Nothing to do for a session in memory, or in memory-only mode.
   */
  const loadSession = (sessionId: string, context?: CommandContext): Loaded | undefined => {
    const database = options.database
    if (!database || sessions.has(sessionId)) return undefined
    options.flush?.()
    const session = getSessionSummary(database, sessionId)
    if (!session) return { refused: { code: 'not_found', message: 'Session not found.' } }
    // Read with the summary: restoring below may write events of its own.
    const at = readPosition(sessionId)
    if (unrecoverable.has(sessionId)) return { refused: UNRECOVERABLE }
    const providerId = session.providerId as ProviderId
    // No identity means the provider never received anything: a crash came
    // between the session's creation and its stamp. A root session is
    // created now and stamped before any prompt (§4.7.4); a sub-agent's
    // cannot be, because its transcript would be lost.
    const providerSessionId = getProviderSessionId(database, sessionId) ?? undefined
    if (!providerSessionId && session.parentSessionId) return { refused: UNRECOVERABLE }
    if (
      !providers[providerId] ||
      (providerSessionId && !providers[providerId].capabilities.canLoadSession)
    ) {
      return {
        refused: { code: 'capability_missing', message: 'Provider cannot resume sessions.' },
      }
    }
    const rejection = providerGate.rejection(providerId)
    if (rejection) return { refused: rejection }
    let target: WorkspaceRuntimeRoute | undefined
    try {
      target = resolveWorkspace(session.workspaceId, context)
    } catch {
      /* unavailable */
    }
    if (!target) return { refused: workspaceRefusal(session.workspaceId) }
    const restoredThreads = listThreadsForSession(database, sessionId)
    if (!restoredThreads.length) {
      return { refused: { code: 'not_found', message: 'Thread not found.' } }
    }
    restoreSession(session, providerId, providerSessionId, target.cwd, restoredThreads)
    return { session, threads: restoredThreads, at }
  }

  /**
   * The answer to `session.open` states a position (docs/sync-foundations.md
   * §6.5): the heads of the streams that change what it reads, in the tick of
   * that read. Memory-only mode has no streams.
   */
  const readPosition = (sessionId: string): SessionOpenPosition => {
    const head = (scope: SubscriptionScope): Cursor =>
      options.head?.(scope) ?? { scope, epoch: 'memory', sequence: 0 }
    return {
      environment: head({ type: 'environment', environmentId }),
      session: head({ type: 'session', environmentId, sessionId }),
    }
  }

  /** What `rejectWorkspace` answers, for the loader. */
  const workspaceRefusal = (workspaceId: string): LoadRefusal => {
    const availability = options.workspaceAvailability?.(workspaceId) ?? 'unknown'
    return availability === 'missing' || availability === 'inaccessible'
      ? {
          code: 'workspace_unavailable',
          message: SESSION_WORKSPACE_UNAVAILABLE,
          details: WorkspaceUnavailableDetailsSchema.parse({ workspaceId, availability }),
        }
      : { code: 'not_found', message: 'Workspace not found.' }
  }

  const refused = (requestId: string, refusal: LoadRefusal) =>
    errorResult(requestId, refusal.code, refusal.message, refusal.details)

  /** How to put back the draft each just-created session was sent from, until it starts. */
  const sentDrafts = new Map<string, () => void>()

  /**
   * Delete a session in one write that says everything going with it: each
   * session under it, deepest first, and each one's draft (db/deletions.ts).
   * Without a database (unit tests only) there is nothing under it to read.
   */
  const deleteSessions = (sessionId: string) => {
    if (!options.database) {
      appendEvent(
        ProofEventSchemas['session.deleted'].parse({
          type: 'event',
          name: 'session.deleted',
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
          scope: { type: 'environment', environmentId },
          payload: { sessionId },
        }),
      )
      return
    }
    options.flush?.()
    const events = sessionDeletionEvents(options.database, environmentId, [sessionId], Date.now())
    if (options.appendAtomic) options.appendAtomic(events)
    else events.forEach(appendEvent)
  }

  const rollbackSession = (record: ThreadRecord) => {
    if (sessions.get(record.session.sessionId) !== record) return
    sessions.delete(record.session.sessionId)
    if (threads.get(record.thread.threadId) === record) threads.delete(record.thread.threadId)
    // Held again, and so kept for the draft restored below, rather than
    // deleted with the session.
    if (record.claimedArtifacts?.length) {
      try {
        options.artifacts?.release(record.claimedArtifacts, record.session.sessionId)
      } catch (error) {
        options.onPersistenceError?.(error, 'session.deleted')
      }
    }
    try {
      deleteSessions(record.session.sessionId)
    } catch (error) {
      if (!options.onPersistenceError) throw error
      options.onPersistenceError(error, 'session.deleted')
    }
    // The send never happened as far as anyone can see, so neither did the
    // draft's deletion: the retry starts from what the user wrote.
    const restoreDraft = sentDrafts.get(record.session.sessionId)
    sentDrafts.delete(record.session.sessionId)
    try {
      restoreDraft?.()
    } catch (error) {
      options.onPersistenceError?.(error, 'draft.saved')
    }
  }

  const stableId = (ids: Map<string, string>, providerId: string | undefined) => {
    if (!providerId) return undefined
    let hostId = ids.get(providerId)
    if (!hostId) {
      hostId = randomUUID()
      ids.set(providerId, hostId)
    }
    return hostId
  }

  const projectRuntimeEvent = (
    record: ThreadRecord,
    event: RuntimeEvent,
    active: ActiveTurn | undefined,
    completionState?: ProtocolEventContext['completionState'],
    failureReason?: TurnFailureReason,
  ): void => {
    projectOwnEvent(record, event, active, completionState, failureReason)
    // A generated image is filed after the tool call that produced it, so the
    // transcript shows the result where it happened: after the work, not before.
    if (
      active &&
      options.artifacts &&
      (event.event === 'tool_call' ||
        event.event === 'tool_call_update' ||
        event.event === 'tool_call_content')
    ) {
      const items =
        event.event === 'tool_call_content' ? [event.data.item] : (event.data.content ?? [])
      for (const item of items) {
        if (item.type !== 'content' || item.content.type !== 'image') continue
        const image = item.content
        const key = createHash('sha256')
          .update(event.data.toolCallId)
          .update(image.mimeType)
          .update(image.data)
          .digest('hex')
        active.generatedImages ??= new Set()
        if (active.generatedImages.has(key)) continue
        active.generatedImages.add(key)
        projectOwnEvent(
          record,
          { ...event, category: 'stream', event: 'agent_message_chunk', data: { content: image } },
          active,
        )
      }
    }
  }

  /** Close every thought of the turn still open (see `ActiveTurn.openReasoning`). */
  const closeOpenReasoning = (record: ThreadRecord, active: ActiveTurn, timestamp: string) => {
    if (!active.openReasoning?.size) return
    for (const messageId of active.openReasoning) {
      appendRuntimeEvent(
        ProofEventSchemas['message.reasoning'].parse({
          type: 'event',
          name: 'message.reasoning',
          eventId: randomUUID(),
          timestamp,
          scope: threadScope(record),
          payload: { messageId, turnId: active.turn.turnId, phase: 'stop' },
        }),
      )
    }
    active.openReasoning.clear()
  }

  const projectOwnEvent = (
    record: ThreadRecord,
    event: RuntimeEvent,
    active: ActiveTurn | undefined,
    completionState?: ProtocolEventContext['completionState'],
    failureReason?: TurnFailureReason,
  ): void => {
    // The durable prompt already names its uploaded images. Provider echoes must
    // neither duplicate them nor relabel them as generated output.
    if (
      options.database &&
      event.event === 'user_message_chunk' &&
      event.data.content.type === 'image'
    )
      return
    const providerToolId =
      event.event === 'tool_call' ||
      event.event === 'tool_call_update' ||
      event.event === 'tool_call_content'
        ? event.data.toolCallId
        : event.event === 'permission_request'
          ? event.data.toolCall.toolCallId
          : undefined
    const providerInteractionId =
      event.event === 'permission_request' ||
      event.event === 'permission_resolved' ||
      event.event === 'question_request' ||
      event.event === 'question_resolved' ||
      event.event === 'plan_review_request' ||
      event.event === 'plan_review_resolved'
        ? event.data.requestId
        : undefined
    const messageId =
      event.event === 'prompt_started' || event.event === 'user_message_chunk'
        ? active?.userMessage?.messageId
        : active
          ? runMessageId(active, event)
          : undefined
    const projected = projectAgentEvent(event, {
      eventId: randomUUID(),
      environmentId,
      workspaceId: record.session.workspaceId,
      sessionId: record.session.sessionId,
      threadId: record.thread.threadId,
      sessionTitle: record.session.title,
      turnId: active?.turn.turnId,
      messageId,
      interactionId: active ? stableId(active.interactionIds, providerInteractionId) : undefined,
      toolCallId: active ? stableId(active.toolIds, providerToolId) : undefined,
      resolvedByClientId:
        active && providerInteractionId
          ? record.interactions.get(stableId(active.interactionIds, providerInteractionId)!)?.answer
              ?.clientId
          : undefined,
      completionState,
      failureReason,
      // A request settled here leaves its turn waiting only on the others.
      turnState:
        active &&
        [...active.pendingInteractions.keys()].some(
          (id) => id !== stableId(active.interactionIds, providerInteractionId),
        )
          ? 'waiting'
          : 'running',
    })
    if (!projected) return
    if (
      projected.name === 'message.delta' &&
      projected.payload.content.type === 'image' &&
      options.artifacts
    ) {
      try {
        const content = projected.payload.content
        const metadata = options.artifacts.generated(
          record.session.sessionId,
          record.session.workspaceId,
          content.mimeType,
          content.data,
        )
        projected.payload.content = options.artifacts.reference(metadata)
      } catch (error) {
        options.onPersistenceError?.(error, 'artifact.generated')
        // Never fall back to putting image bytes in the event log.
        publishTransient({
          type: 'event',
          name: 'turn.notice',
          eventId: randomUUID(),
          timestamp: event.timestamp,
          scope: threadScope(record),
          payload: {
            turnId: projected.payload.turnId,
            message: 'A generated image could not be stored.',
          },
        })
        return
      }
    }
    // The create command already announced the session, and with a database
    // the user's turn is durable before provider work begins; the provider's
    // own signals would only repeat them.
    if (projected.name === 'session.created') return
    if (options.database && projected.name === 'turn.started') return
    // A thought ends where the provider moves on to its answer or a tool: the
    // server says so, with an event, instead of every client guessing it.
    if (
      active &&
      ((projected.name === 'message.delta' && projected.payload.role === 'assistant') ||
        projected.name === 'tool.updated')
    ) {
      closeOpenReasoning(record, active, projected.timestamp)
    }
    // What memory records here may run ahead of a write that failed, and
    // that is safe: the batcher never drops an appended event. It keeps a
    // failed batch, and every event appended behind it, and writes them in
    // order before anything later (event-batcher.ts), so the request this
    // records reaches the rows before its answer can, or the answer is not
    // written either. That holds for a second request that arrives while
    // the first one's write is still failing. Dropping it here would lose a
    // request the next flush commits.
    if (projected.name === 'turn.notice') publishTransient(projected)
    else appendRuntimeEvent(projected)
    if (active && projected.name === 'message.reasoning') {
      active.openReasoning ??= new Set()
      if (projected.payload.phase === 'stop')
        active.openReasoning.delete(projected.payload.messageId)
      else active.openReasoning.add(projected.payload.messageId)
    }
    if (active && projected.name === 'interaction.requested') {
      const { interaction } = projected.payload
      active.pendingInteractions.set(interaction.interactionId, {
        kind: interaction.kind,
        createdAt: Date.now(),
      })
      if (providerInteractionId) {
        record.interactions.set(interaction.interactionId, {
          providerRequestId: providerInteractionId,
          turnId: active.turn.turnId,
          interaction,
          settled: false,
        })
      }
      touch(record, 'waiting')
    } else if (
      active &&
      (projected.name === 'interaction.resolved' || projected.name === 'interaction.expired')
    ) {
      const entry = record.interactions.get(projected.payload.response.interactionId)
      if (entry) {
        entry.settled = true
        entry.resolution = projected.payload.response
        if (entry.interaction.lifecycle) {
          entry.interaction = {
            ...entry.interaction,
            lifecycle: {
              ...entry.interaction.lifecycle,
              state: projected.name === 'interaction.expired' ? 'expired' : 'resolved',
              resolvedAt: projected.timestamp,
              resolvedByClientId:
                projected.name === 'interaction.resolved'
                  ? (projected.payload.resolvedByClientId ?? null)
                  : null,
            },
          }
        }
      }
      active.pendingInteractions.delete(projected.payload.response.interactionId)
      touch(record, active.pendingInteractions.size > 0 ? 'waiting' : 'running')
    }
  }

  /** Where a session rests once a turn has ended without failing. */
  const resting = (record: ThreadRecord): SessionStatus =>
    record.backgroundTasks?.length ? 'running' : 'idle'

  /**
   * Record the provider's live background tasks and tell every client. The
   * roster is the whole truth each time: a task missing from it has ended.
   * Between turns it is also the only thing saying whether the session is
   * working, so the same event carries the status that follows from it.
   */
  const applyBackgroundTasks = (
    record: ThreadRecord,
    reported: readonly { taskId: string; kind: BackgroundTask['kind']; description: string }[],
  ) => {
    // A task keeps its host id for as long as the provider lists it; one
    // that left the roster is forgotten, so a stop can no longer name it.
    const ids = new Map<string, string>()
    const tasks = reported.slice(0, BACKGROUND_TASKS_MAX).map((task) => {
      const taskId = record.backgroundTaskIds?.get(task.taskId) ?? randomUUID()
      ids.set(task.taskId, taskId)
      return { taskId, kind: task.kind, description: task.description.slice(0, 1000) }
    })
    const rests = !record.activeTurn && (record.status === 'idle' || record.status === 'running')
    const status = rests ? (tasks.length ? 'running' : 'idle') : undefined
    const timestamp = new Date().toISOString()
    const updated = ProofEventSchemas['session.updated'].parse({
      type: 'event',
      name: 'session.updated',
      eventId: randomUUID(),
      timestamp,
      scope: { type: 'environment', environmentId },
      payload: {
        sessionId: record.session.sessionId,
        backgroundTasks: tasks,
        // With SQLite the event states only the roster: the projection derives
        // the resting status from the rows and the status pass announces it
        // (docs/sync-foundations.md §4.7.8). The in-memory seam has no rows,
        // so there the roster event also carries the status that follows.
        ...(status && !options.database
          ? {
              status,
              ...(status === 'running' ? { inBackground: true } : {}),
              ...(status !== record.status ? { updatedAt: timestamp } : {}),
            }
          : {}),
      },
    })
    try {
      if (options.appendAtomic) options.appendAtomic([updated])
      else appendEvent(updated)
    } catch (error) {
      // Memory follows the provider even when the write did not land: the
      // tasks are real and must stay stoppable, and every roster event
      // restates the whole roster and status, so the next one repairs the row.
      if (!options.onPersistenceError) throw error
      options.onPersistenceError(error, 'session.updated')
    }
    record.backgroundTasks = tasks
    record.backgroundTaskIds = ids
    if (status) record.announced = { waitingOn: null, inBackground: status === 'running' }
    if (status && status !== record.status) {
      record.status = status
      record.updatedAt = Date.parse(timestamp)
    }
  }

  /**
   * Open the turn a provider began by itself: a background task finished and
   * the agent is acting on the result. It has no user message and no command
   * behind it, and from here on it is a turn like any other: its output is
   * filed under it, it can be interrupted, and the provider ends it.
   */
  const startBackgroundTurn = (record: ThreadRecord, event: RuntimeEvent) => {
    record.unrecordedBackgroundTurn = undefined
    const sent = record.activeTurn
    if (sent) {
      // A turn the user sent owns the session already. If its prompt has not
      // reached the provider yet, what the provider says first is filed here.
      if (!sent.runtimeMessageId) sent.foldedMessageId = event.messageId
      return
    }
    if (record.cancellation || record.pendingBuild) return
    const turn: Turn = {
      turnId: randomUUID(),
      threadId: record.thread.threadId,
      state: 'running',
      startedAt: event.timestamp,
      origin: 'background',
    }
    const started = ProofEventSchemas['turn.started'].parse({
      type: 'event',
      name: 'turn.started',
      eventId: randomUUID(),
      timestamp: event.timestamp,
      scope: threadScope(record),
      payload: { turn },
    })
    try {
      // Written before anything is filed under it, as a sent turn is: output
      // for a turn the log never recorded would fail every write after it.
      if (options.appendAtomic) options.appendAtomic([started])
      else appendEvent(started)
    } catch (error) {
      if (!options.onPersistenceError) throw error
      options.onPersistenceError(error, 'turn.started')
      // Not given up on: the provider goes on with the turn either way, so the
      // next thing it says for it tries the start again. Only what arrived
      // while the log could not be written is lost, not the whole follow-up.
      record.unrecordedBackgroundTurn = event
      return
    }
    record.turns.push(turn)
    record.activeTurn = {
      turn,
      interruptRequested: false,
      promptStarted: true,
      runtimeMessageId: event.messageId,
      toolIds: new Map(),
      interactionIds: new Map(),
      pendingInteractions: new Map(),
    }
    // After the turn is open, so the session no longer reads as background only.
    touch(record, 'running')
  }

  const touch = (record: ThreadRecord, status?: SessionStatus) => {
    record.updatedAt = Date.now()
    if (!status) return
    const changed = record.status !== status
    record.status = status
    // SQLite emits status from its transaction. The in-memory test seam
    // still models the same server-owned environment event, which also goes
    // out when only what the session waits on, or works for, has changed.
    if (options.database) return
    const activity = activityOf(record, status)
    if (
      changed ||
      activity.waitingOn !== record.announced?.waitingOn ||
      activity.inBackground !== record.announced?.inBackground
    ) {
      emitStatus(record, status)
    }
  }

  /** The in-memory reading of `readSessionActivity`; see db/session-activity.ts. */
  const activityOf = (record: ThreadRecord, status: SessionStatus): StatusActivity => ({
    waitingOn:
      status === 'waiting'
        ? (waitingKind(record.activeTurn?.pendingInteractions.values() ?? []) ?? null)
        : null,
    inBackground: status === 'running' && !record.activeTurn && !!record.backgroundTasks?.length,
  })

  /**
   * Settle a title against its provenance and announce the winner. A manual
   * rename outranks everything, a provider title outranks the first-prompt
   * fallback, and the fallback only ever fills a placeholder — so the first
   * meaningful turn names the session and later turns leave it alone.
   */
  /**
   * The title and its source as the rows hold them, everything queued
   * written first. The projection judges a title against these (I2), so the
   * producer decides against them too, not against memory: memory can lag a
   * write that failed and landed on a later retry. Memory takes them on the
   * way. Undefined when the rows cannot be read now; a title can wait.
   */
  const committedTitle = (record: ThreadRecord) => {
    if (!options.database) return { title: record.session.title, source: record.titleSource }
    try {
      options.flush?.()
    } catch {
      return undefined
    }
    const summary = getSessionSummary(options.database, record.session.sessionId)
    if (!summary) return undefined
    record.session.title = summary.title
    record.titleSource = summary.titleSource
    return { title: summary.title, source: summary.titleSource }
  }

  const applyTitle = (record: ThreadRecord, title: string, source: SessionTitleSource): void => {
    const nextTitle = title.trim()
    if (!nextTitle) return
    const stored = committedTitle(record)
    if (!stored) return
    // A user title that happens to look generated is still the user's.
    if (stored.source === 'user' && source !== 'user') return
    if (!shouldReplaceSessionTitle(stored.title, stored.source, source)) return
    if (stored.title === nextTitle && stored.source === source) return
    // Announced before it is believed. A name is bookkeeping, so a failed write
    // must not fail the turn that triggered it, and leaving the record on its
    // old title keeps it a placeholder that the next turn names again.
    try {
      appendEvent(
        ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
          scope: { type: 'environment', environmentId },
          payload: { sessionId: record.session.sessionId, title: nextTitle, titleSource: source },
        }),
      )
    } catch (error) {
      options.onPersistenceError?.(error, 'session.updated')
      return
    }
    // A title is not activity: the session keeps its place (§4.7.1).
    record.session.title = nextTitle
    record.titleSource = source
  }

  /**
   * Title model work per session. Every pass takes the next number and only
   * the newest may save; `needsRefinement` is the first title's own verdict
   * that the first prompt did not say what the session is about. `controller`
   * stops the running pass's CLI once its answer can no longer be used.
   */
  type TitleWork = {
    pass: number
    running: boolean
    needsRefinement: boolean
    controller?: AbortController
  }
  const titleWork = new Map<string, TitleWork>()
  /** Every pass still waiting on its CLI, so closing can wait for them all. */
  const titlePasses = new Set<Promise<unknown>>()
  let titlesStopped = false

  /** The session no longer wants a title: stop its pass and forget it. */
  const forgetTitleWork = (sessionId: string) => {
    titleWork.get(sessionId)?.controller?.abort()
    titleWork.delete(sessionId)
  }

  const currentTitleOf = (sessionId: string) => {
    const record = sessions.get(sessionId)
    if (record) return { title: record.session.title, source: record.titleSource }
    const summary = options.database ? getSessionSummary(options.database, sessionId) : undefined
    return summary ? { title: summary.title, source: summary.titleSource } : undefined
  }

  const titleTranscript = (
    record: ThreadRecord | undefined,
    threadId: string,
  ): TitleContextMessage[] => {
    if (options.database) {
      options.flush?.()
      return readTitleTranscript(options.database, threadId)
    }
    // The in-memory seam keeps only prompts; SQLite has the whole conversation.
    return (record?.messages ?? []).map((message) => titleMessage(message.role, message.content))
  }

  const userPromptCount = (record: ThreadRecord): number => {
    if (options.database) {
      options.flush?.()
      return countUserMessages(options.database, record.thread.threadId)
    }
    return record.messages.filter((message) => message.role === 'user').length
  }

  const reportTitleFailure = (sessionId: string) => (error: unknown) => {
    // Turned off is a choice, and a stopped pass was not wanted; neither is
    // worth a log line.
    if (error instanceof TitleGenerationError && error.reason !== 'failed') return
    options.onTitleFailure?.(sessionId, error)
  }

  /** Save a generated title on every open record of the session. */
  const saveGeneratedTitle = (sessionId: string, title: string): boolean => {
    try {
      appendEvent(
        ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: randomUUID(),
          timestamp: new Date().toISOString(),
          scope: { type: 'environment', environmentId },
          payload: { sessionId, title, titleSource: 'generated' },
        }),
      )
    } catch (error) {
      options.onPersistenceError?.(error, 'session.updated')
      return false
    }
    for (const item of threads.values()) {
      if (item.session.sessionId !== sessionId) continue
      item.session.title = title
      item.titleSource = 'generated'
    }
    return true
  }

  /**
   * Ask the title model, then save its answer unless it was overtaken: by a
   * newer pass, or by the user renaming the session meanwhile. The agent
   * naming its session in the meantime does not count; that is the title a
   * generated one is meant to replace. Answers what was saved, or undefined.
   */
  const runTitlePass = async (
    sessionId: string,
    input: TitlePromptInput,
  ): Promise<GeneratedTitle | undefined> => {
    const titles = options.titles
    if (!titles || titlesStopped)
      throw new TitleGenerationError('off', 'This environment cannot generate titles.')
    const before = currentTitleOf(sessionId)
    const work = titleWork.get(sessionId) ?? { pass: 0, running: false, needsRefinement: false }
    titleWork.set(sessionId, work)
    // Only the newest pass may save, so an older one's CLI is working for nothing.
    work.controller?.abort()
    const controller = new AbortController()
    work.controller = controller
    const pass = ++work.pass
    work.running = true
    const answer = titles.generate(input, controller.signal)
    titlePasses.add(answer)
    try {
      const generated = await answer
      // A stopped pass may still have answered; the answer is not wanted.
      if (controller.signal.aborted || work.pass !== pass) return undefined
      const now = currentTitleOf(sessionId)
      if (!before || !now) return undefined
      const renamed =
        now.source === 'user' && (before.source !== 'user' || now.title !== before.title)
      if (renamed) return undefined
      if (!saveGeneratedTitle(sessionId, generated.title)) return undefined
      return generated
    } finally {
      titlePasses.delete(answer)
      if (work.pass === pass) {
        work.running = false
        work.controller = undefined
      }
    }
  }

  /**
   * Name a session from its first prompt, next to the fallback title the
   * prompt already gave it. Runs beside the turn and never holds it up. A
   * session the user named, or one already generated (a restored session
   * sending again), is left alone.
   */
  const titleFromFirstPrompt = (record: ThreadRecord, message: Message) => {
    if (!options.titles || record.session.parentSessionId) return
    if (record.titleSource === 'user' || record.titleSource === 'generated') return
    if (userPromptCount(record) !== 1) return
    const { text, attachments } = titleMessage('user', message.content)
    if (!text.trim() && !attachments?.length) return
    const sessionId = record.session.sessionId
    void runTitlePass(sessionId, { message: text, ...(attachments ? { attachments } : {}) })
      .then((generated) => {
        const work = titleWork.get(sessionId)
        if (!generated?.needsRefinement || !work) return
        work.needsRefinement = true
        // The first turn may have finished before its title did.
        refineTitle(record)
      })
      .catch(reportTitleFailure(sessionId))
  }

  /**
   * Once, after the first turn: a first prompt too vague to name ("fix
   * this", a bare link) is usually explained by the agent's first answer, so
   * the title is written again from both.
   */
  const refineTitle = (record: ThreadRecord) => {
    const sessionId = record.session.sessionId
    const work = titleWork.get(sessionId)
    if (!options.titles || !work?.needsRefinement || work.running) return
    if (record.titleSource !== 'generated' || record.activeTurn) return
    if (record.turns.at(-1)?.state !== 'completed') return
    work.needsRefinement = false
    // A second prompt says more than the first answer did; nothing to refine.
    if (userPromptCount(record) !== 1) return
    const { message, attachments } = formatTitleContext(
      titleTranscript(record, record.thread.threadId),
    )
    if (!message) return
    void runTitlePass(sessionId, {
      message,
      previousTitle: record.session.title ?? '',
      ...(attachments.length > 0 ? { attachments } : {}),
    }).catch(reportTitleFailure(sessionId))
  }

  const emitStatus = (record: ThreadRecord, status: SessionStatus) => {
    // Mirrors the SQLite projection: running or asking brings a settled session back.
    const unsettle =
      record.settledAt !== undefined && (status === 'running' || status === 'waiting')
    if (unsettle) record.settledAt = undefined
    // A new turn supersedes the last result, as `turn.started` does in SQLite.
    if (status === 'running' || status === 'waiting') record.doneAt = undefined
    const activity = activityOf(record, status)
    record.announced = activity
    // A status moves the session's place in the list, and says so.
    record.updatedAt = Date.now()
    const timestamp = new Date(record.updatedAt).toISOString()
    appendRuntimeEvent(
      ProofEventSchemas['session.updated'].parse({
        type: 'event',
        name: 'session.updated',
        eventId: randomUUID(),
        timestamp,
        scope: { type: 'environment', environmentId },
        payload: {
          sessionId: record.session.sessionId,
          status,
          updatedAt: timestamp,
          ...summaryActivity(activity),
          ...(unsettle ? { settledAt: null } : {}),
          doneAt: record.doneAt === undefined ? null : new Date(record.doneAt).toISOString(),
        },
      }),
    )
  }

  /**
   * File the provider's child session (a subagent transcript) as a host
   * session under the parent, once. The provider repeats the subtask across
   * updates and after reconnects, so the child is looked up in memory and
   * then in SQLite before a new identity is minted. The provider session id
   * is stamped in the same step as the rows, so the child can be resumed
   * after a restart exactly like a session the user created.
   */
  const registerChildSession = (
    parent: ThreadRecord,
    providerSessionId: string,
    title: string | null,
  ) => {
    const key = `${parent.providerId}:${providerSessionId}`
    if (childSessionIds.has(key) || forgottenChildren.has(key)) return
    if (options.database) {
      options.flush?.()
      const persisted = findSessionIdByProviderSession(
        options.database,
        parent.providerId,
        providerSessionId,
      )
      if (persisted) {
        childSessionIds.set(key, persisted)
        return
      }
    }
    const session: Session = {
      sessionId: randomUUID(),
      workspaceId: parent.session.workspaceId,
      title,
      parentSessionId: parent.session.sessionId,
    }
    const thread: Thread = { threadId: randomUUID(), sessionId: session.sessionId }
    try {
      // The identity is stored by the same write that creates the row, so a
      // child is never durable without what it resumes and deduplicates by.
      persistCreatedThread(session, thread, {
        providerId: parent.providerId,
        ...(title ? { titleSource: 'provider' as const } : {}),
        identity: providerSessionId,
      })
    } catch (error) {
      // The parent turn carries on; the child is offered again on the next update.
      options.onPersistenceError?.(error, 'session.created')
      return
    }
    const record: ThreadRecord = {
      session,
      thread,
      providerId: parent.providerId,
      titleSource: title ? 'provider' : undefined,
      cwd: parent.cwd,
      runtimeSession: Promise.resolve(providerSessionId),
      turns: [],
      messages: [],
      commandTurns: new Map(),
      interactions: new Map(),
      status: 'idle',
      updatedAt: Date.now(),
    }
    sessions.set(session.sessionId, record)
    threads.set(thread.threadId, record)
    childSessionIds.set(key, session.sessionId)
  }

  /**
   * Remember a child the user is deleting so a later report of the same
   * provider child does not register it again. Read before the row goes.
   */
  const forgetChild = (sessionId: string) => {
    for (const [key, hostId] of childSessionIds) {
      if (hostId !== sessionId) continue
      forgottenChildren.add(key)
      return
    }
    if (!options.database) return
    const summary = getSessionSummary(options.database, sessionId)
    const providerSessionId = getProviderSessionId(options.database, sessionId)
    if (summary && providerSessionId) {
      forgottenChildren.add(`${summary.providerId}:${providerSessionId}`)
    }
  }

  const summaryOf = (record: ThreadRecord): SessionSummary => ({
    sessionId: record.session.sessionId,
    workspaceId: record.session.workspaceId,
    title: record.session.title,
    ...(record.titleSource ? { titleSource: record.titleSource } : {}),
    ...(record.session.parentSessionId ? { parentSessionId: record.session.parentSessionId } : {}),
    status: record.status,
    providerId: record.providerId,
    updatedAt: new Date(record.updatedAt).toISOString(),
    settledAt: record.settledAt === undefined ? null : new Date(record.settledAt).toISOString(),
    doneAt: record.doneAt === undefined ? null : new Date(record.doneAt).toISOString(),
    ...(record.backgroundTasks?.length ? { backgroundTasks: record.backgroundTasks } : {}),
    ...summaryActivity(activityOf(record, record.status)),
  })

  const sendTurn = (command: CommandEnvelope, context?: CommandContext, modeId?: string) => {
    const parsed = ProofCommandSchemas['turn.send'].safeParse(command)
    if (!parsed.success) {
      return errorResult(command.requestId, 'validation', 'Invalid prompt request.')
    }
    const input = parsed.data.payload
    // A client's own id makes the send retryable; a client that sends none
    // gets a minted one so every turn is still recorded with exactly one.
    const commandId = input.commandId ?? randomUUID()
    const recordOf = () => {
      const threadRecord = threads.get(input.threadId)
      return threadRecord?.session.sessionId === input.sessionId ? threadRecord : undefined
    }
    let record = recordOf()
    // Access is settled before anything is answered, a replay included: a
    // caller who cannot reach the workspace must not learn what was sent
    // to it. A thread no longer in memory names its workspace from the log.
    const workspaceId = record?.session.workspaceId ?? persistedWorkspaceId(input.sessionId)
    if (workspaceId === undefined) {
      return errorResult(command.requestId, 'not_found', 'Thread not found.')
    }
    if (!resolveWorkspace(workspaceId, context)) {
      return rejectWorkspace(command.requestId, workspaceId, SEND_WORKSPACE_UNAVAILABLE)
    }
    // A live thread has served every send since this process started, so
    // its own map answers without touching the log. Only a thread that is
    // no longer in memory needs the durable lookup, which is exactly the
    // retry that crosses a restart.
    const replayed = !input.commandId
      ? undefined
      : record
        ? record.commandTurns.get(input.commandId)
        : findPersistedTurn(input.sessionId, input.threadId, input.commandId)
    if (replayed) return turnSendResult(command.requestId, replayed)
    if (!record) {
      // A chat the rows hold and this process has not loaded (after a
      // restart): load it as an open would, then serve the send (§4.7.3).
      const loaded = loadSession(input.sessionId, context)
      if (loaded && 'refused' in loaded) return refused(command.requestId, loaded.refused)
      record = recordOf()
    }
    if (!record) {
      return errorResult(command.requestId, 'not_found', 'Thread not found.')
    }
    const providerRejection = rejectProvider(command.requestId, record.providerId)
    if (providerRejection) return providerRejection
    if (record.activeTurn || record.cancellation || record.pendingBuild) {
      return errorResult(command.requestId, 'conflict', 'A turn is already in progress.')
    }
    // The rows may hold a turn no process runs: one whose recovery failed at
    // boot. A second turn beside it would leave the thread with two open.
    if (options.database) {
      options.flush?.()
      if (findOpenTurnId(options.database, input)) {
        return errorResult(command.requestId, 'conflict', 'A turn is already in progress.')
      }
    }
    let promptImages: { type: 'image'; mimeType: string; data: string }[] = []
    const artifactContent: Message['content'] = []
    try {
      for (const artifactId of new Set(input.artifactIds ?? [])) {
        const metadata = options.artifacts?.get(input.sessionId, artifactId)
        if (!metadata || metadata.workspaceId !== workspaceId) {
          return errorResult(command.requestId, 'not_found', 'Artifact not found in this session.')
        }
        artifactContent.push(options.artifacts!.reference(metadata))
        promptImages.push({
          type: 'image',
          mimeType: metadata.mimeType,
          data: options.artifacts!.read(metadata).toString('base64'),
        })
      }
    } catch {
      return errorResult(command.requestId, 'unavailable', 'An attachment could not be read.')
    }
    const startedAt = new Date().toISOString()
    const turn: Turn = {
      turnId: randomUUID(),
      threadId: record.thread.threadId,
      state: 'running',
      startedAt,
      commandId,
    }
    const userMessage: Message = {
      messageId: randomUUID(),
      threadId: record.thread.threadId,
      turnId: turn.turnId,
      role: 'user',
      // A caption-less image sends no empty text block alongside it.
      content: [
        ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
        ...artifactContent,
      ],
    }
    const started: TurnStart = { turn, userMessage, commandId }
    if (options.database) {
      try {
        const event = ProofEventSchemas['turn.started'].parse({
          type: 'event',
          name: 'turn.started',
          eventId: randomUUID(),
          timestamp: startedAt,
          scope: threadScope(record),
          payload: started,
        })
        // A failed host command must not leave a start in the streaming
        // buffer that a later retry could flush as an orphaned turn.
        if (options.appendAtomic) options.appendAtomic([event])
        else appendEvent(event)
      } catch (error) {
        options.onPersistenceError?.(error, 'turn.started')
        return errorResult(
          command.requestId,
          'unavailable',
          'The message could not be saved. Try again.',
        )
      }
    }
    record.turns.push(turn)
    record.messages.push(userMessage)
    record.commandTurns.set(commandId, started)
    const title = titleFromPrompt(input.text)
    if (title) applyTitle(record, title, 'fallback')
    titleFromFirstPrompt(record, userMessage)
    const active: ActiveTurn = {
      turn,
      userMessage,
      interruptRequested: false,
      ...(modeId ? { modeId } : {}),
      toolIds: new Map(),
      interactionIds: new Map(),
      pendingInteractions: new Map(),
    }
    record.activeTurn = active
    // After the turn is open, so the session does not read as background only.
    touch(record, 'running')
    active.completion = record.runtimeSession
      .then((sessionId) => {
        // Deleting the session or closing the workspace drops the record while
        // the provider session is still resolving. Starting provider work for a
        // record nothing points at any more would outlive the session itself.
        if (threads.get(record.thread.threadId) !== record) {
          // Dropped for another reason, its rows still there (another thread
          // of the session failed to load): its turn ends through the
          // terminal path, or the rows would hold it open until the next boot
          // (§4.7.3 point 4). A deletion took the rows too and needs no end.
          if (record.activeTurn === active && threadHeld(record)) {
            emitFailed(record, turn.turnId)
            turn.state = 'failed'
            record.activeTurn = undefined
          }
          return
        }
        if (record.activeTurn !== active || active.interruptRequested) return
        active.promptStarted = true
        return runtime.prompt({
          ...route(record, sessionId),
          ...(modeId ? { desiredConfig: { modeId } } : {}),
          prompt: {
            text: input.text,
            blocks: [
              ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
              ...promptImages,
            ],
          },
          userMessageId: userMessage.messageId,
        })
      })
      .then(() => {
        promptImages = []
        if (active.promptStarted && record.activeTurn === active && turn.state === 'running') {
          // A provider may settle without a terminal callback while cancel
          // is still pending. Its prompt has ended either way.
          if (active.interruptRequested) emitInterrupted(record, turn.turnId)
          else emitCompleted(record, turn.turnId)
          turn.state = active.interruptRequested ? 'interrupted' : 'completed'
          record.activeTurn = undefined
          touch(record, resting(record))
        }
      })
      .catch(() => {
        promptImages = []
        active.promptFailed = true
        if (record.activeTurn === active && turn.state === 'running') {
          if (active.interruptRequested) emitInterrupted(record, turn.turnId)
          else emitFailed(record, turn.turnId)
          turn.state = active.interruptRequested ? 'interrupted' : 'failed'
          record.activeTurn = undefined
          touch(record, active.interruptRequested ? resting(record) : 'error')
        }
      })
    return turnSendResult(command.requestId, started)
  }

  const service = {
    setEnvironmentId(id: string) {
      environmentId = id
    },

    /**
     * Every session's summary, newest first: the rows when persistent, else
     * memory. Nothing on the wire reads this (the environment snapshot reads
     * the rows itself); it is how tests and the in-memory mode inspect state.
     */
    summaries(): SessionSummary[] {
      if (options.database) {
        options.flush?.()
        return listAllSessionSummaries(options.database)
      }
      return [...sessions.values()]
        .map(summaryOf)
        .sort((left, right) =>
          left.updatedAt === right.updatedAt
            ? right.sessionId.localeCompare(left.sessionId)
            : (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''),
        )
    },

    /**
     * A thread as its snapshot states it: the rows when persistent, else
     * memory (without reasoning, tools or order, which memory does not keep).
     * For inspection, like `summaries`.
     */
    threadState(target: { sessionId: string; threadId: string }): ThreadState | undefined {
      if (options.database) {
        options.flush?.()
        return readThreadState(options.database, target)
      }
      const record = threads.get(target.threadId)
      if (!record || record.session.sessionId !== target.sessionId) return undefined
      return {
        thread: record.thread,
        turns: record.turns,
        messages: record.messages,
        reasoning: [],
        tools: [],
        order: [],
        interactions: [...record.interactions.values()]
          .filter((entry) => !entry.settled && record.activeTurn?.turn.turnId === entry.turnId)
          .map((entry) => ({ turnId: entry.turnId, interaction: entry.interaction })),
        listing: {},
      }
    },

    /**
     * Forget background work left over from the process that ran before this
     * one. The tasks were children of provider processes that did not survive
     * it, so every session still listing some has none, and one held at
     * `running` only by them is idle. Said through the event log rather than
     * by editing rows, so a client that reconnects with a saved cursor hears
     * it too. Call once, before any session can run.
     */
    forgetStaleBackgroundWork(): number {
      const database = options.database
      if (!database) return 0
      options.flush?.()
      const stale = database
        .prepare('SELECT session_id, status FROM sessions WHERE background_tasks_json IS NOT NULL')
        .all() as { session_id: string; status: string }[]
      if (stale.length === 0) return 0
      const timestamp = new Date().toISOString()
      const events = stale.map((row) =>
        ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: randomUUID(),
          timestamp,
          scope: { type: 'environment', environmentId },
          // Only the roster: a resting session it kept running becomes idle
          // in the projection, and a turn cut off by the restart already
          // reads as failed.
          payload: { sessionId: row.session_id, backgroundTasks: [] },
        }),
      )
      if (options.appendAtomic) options.appendAtomic(events)
      else for (const event of events) appendEvent(event)
      return stale.length
    },

    /**
     * Stop every title being written and start no more. Settles once each
     * title CLI and everything it started has exited, so none outlives the
     * server or writes into a database that is closing.
     */
    async stopTitles(): Promise<void> {
      titlesStopped = true
      for (const work of titleWork.values()) work.controller?.abort()
      await Promise.allSettled([...titlePasses])
    },

    /**
     * Forget every session of a workspace that is being unregistered. An
     * active turn is asked to stop, best effort; whatever the provider still
     * emits afterwards finds no thread and is dropped. Returns the count.
     */
    closeWorkspaceSessions(workspaceId: string): number {
      let closed = 0
      for (const record of [...sessions.values()]) {
        if (record.session.workspaceId !== workspaceId) continue
        // A child already went with its parent earlier in this pass.
        if (!sessions.has(record.session.sessionId)) continue
        for (const item of dropSessionRecords(record.session.sessionId)) abandon(item)
        closed += 1
      }
      return closed
    },

    /** The host session a runtime thread belongs to, while that session is loaded. */
    sessionForThread(threadId: string): string | undefined {
      return threads.get(threadId)?.session.sessionId
    },

    /**
     * The provider session a composer setter acts on, loading a session the
     * rows hold as an open would, with the caller's context (§4.7.3). A
     * refusal is the answer the open would give.
     */
    resolveRuntimeSession(sessionId: string, context?: CommandContext) {
      const loaded = loadSession(sessionId, context)
      if (loaded && 'refused' in loaded) return loaded.refused
      const record = sessions.get(sessionId)
      if (!record) return undefined
      return record.runtimeSession.then((providerSessionId) => ({
        ...route(record),
        sessionId: providerSessionId,
      }))
    },

    dispatch(command: CommandEnvelope, context?: CommandContext): unknown | undefined {
      if (command.name === 'session.create') {
        const parsed = ProofCommandSchemas['session.create'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid session create request.')
        }
        const input = parsed.data.payload
        if (input.environmentId !== environmentId) {
          return errorResult(
            command.requestId,
            'validation',
            'The requested environment does not match this server.',
          )
        }
        let target: WorkspaceRuntimeRoute | undefined
        try {
          target = resolveWorkspace(input.workspaceId, context)
        } catch {
          return rejectWorkspace(command.requestId, input.workspaceId, WORKSPACE_UNAVAILABLE)
        }
        if (!target) {
          return rejectWorkspace(command.requestId, input.workspaceId, WORKSPACE_UNAVAILABLE)
        }
        // Order matters: a provider this build cannot run is a capability gap,
        // not a missing resource, so it is answered before the health gate.
        if (!Object.hasOwn(providers, input.providerId)) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'This server cannot run the requested provider.',
          )
        }
        const providerRejection = rejectProvider(command.requestId, input.providerId)
        if (providerRejection) return providerRejection
        if (!(target.providers ?? [target.providerId]).includes(input.providerId)) {
          return errorResult(
            command.requestId,
            'validation',
            'The workspace does not offer the requested provider. Choose an available provider.',
          )
        }
        const providerId = input.providerId as ProviderId
        // The runtime drops a mode the provider cannot set, so the first turn
        // would run in the default one. Refused instead: the client picked it.
        if (input.modeId !== undefined && !providers[providerId].capabilities.canSetMode) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'This provider cannot start a chat in another mode.',
          )
        }
        // A draft's images are held until its launch claims them: this
        // client's own uploads, and any the draft being sent names, which
        // another device may have attached. Read before the send deletes the
        // draft, and checked before anything is announced, so a stale or
        // foreign id leaves no session behind; claimed once the session exists.
        const artifactIds = input.artifactIds ? [...new Set(input.artifactIds)] : []
        let shared: string[] = []
        if (artifactIds.length > 0) {
          if (!options.artifacts || !context) {
            return errorResult(
              command.requestId,
              'capability_missing',
              'This environment cannot attach images to a new chat.',
            )
          }
          if (input.draftId !== undefined) shared = options.artifacts.imagesOf(input.draftId)
          if (!options.artifacts.claimable(artifactIds, { clientId: context.clientId, shared })) {
            return errorResult(command.requestId, 'not_found', ARTIFACTS_UNAVAILABLE)
          }
        }
        // Filed before the session exists, so a pick that cannot be saved stops
        // the launch rather than starting it on something the user did not
        // choose. What comes back is what the draft showed; the session keeps
        // it as its own below.
        let launched: WorkspaceComposerPreference | undefined
        if (input.preference && !options.launchPreference) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'This environment cannot start a chat with the selected settings.',
          )
        }
        try {
          launched = options.launchPreference?.(input.workspaceId, providerId, input.preference)
        } catch {
          if (input.preference) {
            return errorResult(
              command.requestId,
              'unavailable',
              'The chat settings could not be saved. Try again.',
            )
          }
          // Nothing was picked: the provider's own seeding still applies.
        }
        // A draft names the id its session gets, so a retried send lands on the
        // same session id. An id that is already taken is not reused.
        const sessionId = input.sessionId ?? randomUUID()
        if (
          input.sessionId !== undefined &&
          (sessions.has(sessionId) ||
            (options.database !== undefined && getSessionSummary(options.database, sessionId)))
        ) {
          return errorResult(
            command.requestId,
            'conflict',
            'A session with this id already exists.',
          )
        }
        let draft: { event: ProofEvent; restore: () => void } | undefined
        if (input.draftId !== undefined) {
          if (!options.drafts) {
            return errorResult(
              command.requestId,
              'capability_missing',
              'This environment does not keep drafts.',
            )
          }
          // Put back as sent if the session is rolled back: text, images,
          // provider and picks. The rollback hands the images back first.
          const picks = {
            ...input.preference,
            ...(input.modeId !== undefined ? { modeId: input.modeId } : {}),
          }
          const launch = options.drafts.launch(input.draftId, {
            workspaceId: input.workspaceId,
            sessionId,
            content: {
              text: input.firstMessage ?? '',
              providerId,
              ...(Object.keys(picks).length > 0 ? { preference: picks } : {}),
              ...(artifactIds.length > 0 ? { artifactIds } : {}),
            },
          })
          if ('error' in launch) return errorResult(command.requestId, 'validation', launch.error)
          draft = launch
        }
        const session: Session = {
          sessionId,
          workspaceId: parsed.data.payload.workspaceId,
          title: parsed.data.payload.title ?? null,
        }
        const thread: Thread = { threadId: randomUUID(), sessionId: session.sessionId }
        // Announced and durable before it is exposed or started: a failed write
        // means no client learns of a session the host could not serve after a
        // restart, and every connected client sees the session at once. The
        // sent draft goes in the same write, so no save still in flight can
        // bring it back.
        let announcedAt: string
        try {
          announcedAt = persistCreatedThread(session, thread, {
            providerId,
            ...(input.title !== undefined ? { titleSource: 'fallback' as const } : {}),
            ...(draft ? { alongside: [draft.event] } : {}),
          })
        } catch (error) {
          options.onPersistenceError?.(error, 'session.created')
          return errorResult(
            command.requestId,
            'unavailable',
            'The session could not be saved. Try again.',
          )
        }
        let record!: ThreadRecord
        const runtimeSession = Promise.resolve()
          .then(() => {
            if (sessions.get(session.sessionId) !== record)
              throw new Error('Session creation was cancelled.')
            return runtime.ensureSession(route(record))
          })
          .then((result) => {
            // The client already holds the session: a failing stamp must not
            // turn a successful start into a rollback. The host logs it.
            try {
              target.onSessionStarted?.()
            } catch {
              /* reported by the host's callback; see WorkspaceRuntimeRoute */
            }
            return persistRuntimeSession(record, result.sessionId)
          })
        record = {
          session,
          thread,
          providerId,
          titleSource: input.title !== undefined ? 'fallback' : undefined,
          cwd: target.cwd,
          runtimeSession,
          turns: [],
          messages: [],
          commandTurns: new Map(),
          interactions: new Map(),
          status: 'idle',
          // The time it was announced at, as the answer and the event say.
          updatedAt: Date.parse(announcedAt),
        }
        sessions.set(session.sessionId, record)
        threads.set(thread.threadId, record)
        if (draft) sentDrafts.set(session.sessionId, draft.restore)
        void record.runtimeSession.then(
          () => {
            // Started: the session stands, and so does the send.
            if (sentDrafts.get(session.sessionId) === draft?.restore) {
              sentDrafts.delete(session.sessionId)
            }
          },
          () => rollbackSession(record),
        )
        // Before the provider starts, which is a microtask away: once the
        // session has a selection of its own, a later launch in the workspace
        // can only move the shared preference, not this session.
        if (launched && (launched.modelId !== undefined || launched.configValues !== undefined)) {
          try {
            options.seedSessionComposer?.(session.sessionId, {
              ...(launched.modelId !== undefined ? { modelId: launched.modelId } : {}),
              ...(launched.configValues !== undefined
                ? { configValues: launched.configValues }
                : {}),
            })
          } catch (error) {
            // Display and seeding state; the preference still stands in for it.
            options.onPersistenceError?.(error, 'session.composer.updated')
          }
        }
        if (artifactIds.length > 0) {
          // The claim points each row at the session, so the session row it
          // references has to be written first.
          options.flush?.()
          let claimed = false
          try {
            claimed = options.artifacts!.claim(artifactIds, {
              workspaceId: input.workspaceId,
              clientId: context!.clientId,
              sessionId: session.sessionId,
              shared,
            })
          } catch (error) {
            options.onPersistenceError?.(error, 'session.created')
          }
          if (!claimed) {
            // Another launch took them in between, or the write failed.
            rollbackSession(record)
            return errorResult(command.requestId, 'not_found', ARTIFACTS_UNAVAILABLE)
          }
          record.claimedArtifacts = artifactIds
        }
        // Re-enter the existing turn command so validation, runtime scheduling and
        // history ownership remain in one place. No asynchronous gap is exposed.
        // A picked mode rides the first prompt the way a plan build's does: set
        // on the live session before the prompt, which fails if it cannot be.
        let firstTurn
        if (input.firstMessage !== undefined) {
          let result: unknown
          try {
            result = sendTurn(
              {
                ...command,
                name: 'turn.send',
                payload: {
                  sessionId: session.sessionId,
                  threadId: thread.threadId,
                  text: input.firstMessage,
                  ...(artifactIds.length > 0 ? { artifactIds } : {}),
                },
              },
              context,
              input.modeId,
            )
          } catch {
            result = rejectWorkspace(command.requestId, input.workspaceId, WORKSPACE_UNAVAILABLE)
          }
          const started = ProofResponseSchemas['turn.send'].safeParse(result)
          if (!started.success) {
            // The session was already announced, so its removal must be too.
            // It hands the images back for the retry, which the draft keeps.
            rollbackSession(record)
            return result
          }
          firstTurn = started.data.payload
        }
        return ProofResponseSchemas['session.create'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { session, thread, ...(firstTurn ? { firstTurn } : {}), announcedAt },
        })
      }

      if (command.name === 'session.title.regenerate') {
        const parsed = ProofCommandSchemas['session.title.regenerate'].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid session request.')
        options.flush?.()
        const { sessionId } = parsed.data.payload
        const record = sessions.get(sessionId)
        const session =
          record?.session ??
          (options.database ? getSessionSummary(options.database, sessionId) : undefined)
        if (!session) return errorResult(command.requestId, 'not_found', 'Session not found.')
        if (!options.titles)
          return errorResult(
            command.requestId,
            'unavailable',
            'This environment cannot generate titles.',
          )
        const threadId =
          record?.thread.threadId ??
          (options.database
            ? listThreadsForSession(options.database, sessionId)[0]?.threadId
            : undefined)
        const { message, attachments } = formatTitleContext(
          threadId ? titleTranscript(record, threadId) : [],
        )
        if (!message)
          return errorResult(
            command.requestId,
            'conflict',
            'The session has no messages to name it from yet.',
          )
        const { requestId } = command
        return runTitlePass(sessionId, {
          message,
          previousTitle: session.title ?? '',
          ...(attachments.length > 0 ? { attachments } : {}),
        })
          .then((generated) => {
            if (!generated)
              return errorResult(
                requestId,
                'conflict',
                'The session was renamed or asked for another title meanwhile.',
              )
            // Asked for by name: nothing is left to refine after it.
            const work = titleWork.get(sessionId)
            if (work) work.needsRefinement = false
            return ProofResponseSchemas['session.title.regenerate'].parse({
              type: 'response',
              requestId,
              // Built field by field: `session` may be a summary read before the
              // title changed, and its provenance and times are stale now.
              payload: {
                session: {
                  sessionId,
                  workspaceId: session.workspaceId,
                  title: generated.title,
                  ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
                },
              },
            })
          })
          .catch((error: unknown) => {
            reportTitleFailure(sessionId)(error)
            if (error instanceof TitleGenerationError && error.reason === 'aborted')
              return errorResult(
                requestId,
                'conflict',
                'The session was renamed or asked for another title meanwhile.',
              )
            return errorResult(
              requestId,
              'unavailable',
              error instanceof TitleGenerationError
                ? error.message
                : 'The title could not be generated.',
            )
          })
      }

      if (command.name === 'session.rename' || command.name === 'session.delete') {
        const parsed = ProofCommandSchemas[command.name].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid session request.')
        options.flush?.()
        const { sessionId } = parsed.data.payload
        const record = sessions.get(sessionId)
        const session =
          record?.session ??
          (options.database ? getSessionSummary(options.database, sessionId) : undefined)
        if (!session) return errorResult(command.requestId, 'not_found', 'Session not found.')
        const timestamp = new Date().toISOString()
        const rename =
          parsed.data.name === 'session.rename'
            ? ProofEventSchemas['session.updated'].parse({
                type: 'event',
                name: 'session.updated',
                eventId: randomUUID(),
                timestamp,
                scope: { type: 'environment', environmentId },
                payload: { sessionId, title: parsed.data.payload.title, titleSource: 'user' },
              })
            : undefined
        if (parsed.data.name === 'session.delete' && session.parentSessionId) forgetChild(sessionId)
        // Deleted, or renamed: a title still being written is not wanted.
        if (parsed.data.name === 'session.delete') forgetTitleWork(sessionId)
        else titleWork.get(sessionId)?.controller?.abort()
        try {
          if (rename) appendEvent(rename)
          else deleteSessions(sessionId)
        } catch (error) {
          options.onPersistenceError?.(error, rename ? rename.name : 'session.deleted')
          return errorResult(
            command.requestId,
            'unavailable',
            'The session change could not be saved. Try again.',
          )
        }
        if (parsed.data.name === 'session.rename') {
          for (const item of threads.values()) {
            if (item.session.sessionId !== sessionId) continue
            item.titleSource = 'user'
            item.session.title = parsed.data.payload.title
          }
          return ProofResponseSchemas['session.rename'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: { session: { ...session, title: parsed.data.payload.title } },
          })
        }
        for (const item of dropSessionRecords(sessionId)) abandon(item)
        return ProofResponseSchemas['session.delete'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: null,
        })
      }

      if (command.name === 'session.settle') {
        const parsed = ProofCommandSchemas['session.settle'].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid session request.')
        options.flush?.()
        const { sessionId, settled } = parsed.data.payload
        const record = sessions.get(sessionId)
        const session =
          record?.session ??
          (options.database ? getSessionSummary(options.database, sessionId) : undefined)
        if (!session) return errorResult(command.requestId, 'not_found', 'Session not found.')
        // Only a turn starting clears `settledAt`, so a live session settled
        // now would stay on the shelf after it finishes. Bringing one back is fine.
        const status = record?.status ?? ('status' in session ? session.status : 'idle')
        if (settled && (status === 'running' || status === 'waiting')) {
          return errorResult(command.requestId, 'conflict', 'A live session cannot be settled.')
        }
        const timestamp = new Date().toISOString()
        const settledAt = settled ? timestamp : null
        const event = ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: randomUUID(),
          timestamp,
          scope: { type: 'environment', environmentId },
          payload: { sessionId, settledAt },
        })
        try {
          appendEvent(event)
        } catch (error) {
          options.onPersistenceError?.(error, event.name)
          return errorResult(
            command.requestId,
            'unavailable',
            'The session change could not be saved. Try again.',
          )
        }
        for (const item of threads.values()) {
          if (item.session.sessionId !== sessionId) continue
          item.settledAt = settled ? Date.parse(timestamp) : undefined
        }
        return ProofResponseSchemas['session.settle'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { settledAt },
        })
      }

      if (command.name === 'session.acknowledge') {
        const parsed = ProofCommandSchemas['session.acknowledge'].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid session request.')
        options.flush?.()
        const { sessionId } = parsed.data.payload
        const record = sessions.get(sessionId)
        const summary = options.database
          ? getSessionSummary(options.database, sessionId)
          : record
            ? summaryOf(record)
            : undefined
        if (!summary) return errorResult(command.requestId, 'not_found', 'Session not found.')
        // Several clients may open the same finished session; only the first
        // one has anything to clear, and the rest must not add noise.
        if (summary.doneAt) {
          const event = ProofEventSchemas['session.updated'].parse({
            type: 'event',
            name: 'session.updated',
            eventId: randomUUID(),
            timestamp: new Date().toISOString(),
            scope: { type: 'environment', environmentId },
            payload: { sessionId, doneAt: null },
          })
          try {
            appendEvent(event)
          } catch (error) {
            options.onPersistenceError?.(error, event.name)
            return errorResult(
              command.requestId,
              'unavailable',
              'The session change could not be saved. Try again.',
            )
          }
          for (const item of threads.values()) {
            if (item.session.sessionId === sessionId) item.doneAt = undefined
          }
        }
        return ProofResponseSchemas['session.acknowledge'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: null,
        })
      }

      if (command.name === 'session.background.stop') {
        const parsed = ProofCommandSchemas['session.background.stop'].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid session request.')
        options.flush?.()
        const { sessionId, taskIds } = parsed.data.payload
        const records = [...threads.values()].filter((item) => item.session.sessionId === sessionId)
        const known = records.length
          ? true
          : !!options.database && !!getSessionSummary(options.database, sessionId)
        if (!known) return errorResult(command.requestId, 'not_found', 'Session not found.')
        const { requestId } = command
        const stopped = ProofResponseSchemas['session.background.stop'].parse({
          type: 'response',
          requestId,
          payload: null,
        })
        const stops: Promise<void>[] = []
        for (const record of records) {
          if (!runtime.stopBackgroundTasks) continue
          if (!taskIds) {
            // Every task the provider has, not only the ones this host lists:
            // the roster it announces is capped, the work is not.
            stops.push(runtime.stopBackgroundTasks(route(record)))
            continue
          }
          // Clients name tasks by host id; the provider knows its own.
          const providerTaskIds = [...(record.backgroundTaskIds ?? [])]
            .filter(([, hostTaskId]) => taskIds.includes(hostTaskId))
            .map(([providerTaskId]) => providerTaskId)
          // A task that already ended has nothing to stop.
          if (providerTaskIds.length === 0) continue
          stops.push(runtime.stopBackgroundTasks({ ...route(record), taskIds: providerTaskIds }))
        }
        if (stops.length === 0) return stopped
        // The roster is not touched here: the provider reports what is left.
        return Promise.all(stops).then(
          () => stopped,
          () =>
            errorResult(
              requestId,
              'unavailable',
              'The background work could not be stopped. Try again.',
            ),
        )
      }

      if (command.name === 'session.open') {
        const parsed = ProofCommandSchemas['session.open'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid session open request.')
        }
        const loaded = loadSession(parsed.data.payload.sessionId, context)
        if (loaded && 'refused' in loaded) return refused(command.requestId, loaded.refused)
        if (loaded) {
          return ProofResponseSchemas['session.open'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: { session: loaded.session, threads: loaded.threads, at: loaded.at },
          })
        }
        const record = sessions.get(parsed.data.payload.sessionId)
        if (!record) return errorResult(command.requestId, 'not_found', 'Session not found.')
        if (!resolveWorkspace(record.session.workspaceId, context)) {
          return rejectWorkspace(
            command.requestId,
            record.session.workspaceId,
            SESSION_WORKSPACE_UNAVAILABLE,
          )
        }
        const providerRejection = rejectProvider(command.requestId, record.providerId)
        if (providerRejection) return providerRejection
        if (!providers[record.providerId].capabilities.canLoadSession) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'Provider cannot resume sessions.',
          )
        }
        void record.runtimeSession
          .then((sessionId) => runtime.ensureSession(route(record, sessionId)))
          .catch(() => undefined)
        return ProofResponseSchemas['session.open'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: {
            session: options.database
              ? getSessionSummary(options.database, record.session.sessionId)
              : summaryOf(record),
            threads: options.database
              ? listThreadsForSession(options.database, record.session.sessionId)
              : [record.thread],
            at: readPosition(record.session.sessionId),
          },
        })
      }

      if (command.name === 'turn.send') return sendTurn(command, context)

      if (command.name === 'turn.interrupt') {
        const parsed = ProofCommandSchemas['turn.interrupt'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid interrupt request.')
        }
        const record = threads.get(parsed.data.payload.threadId)
        // A turn the rows hold open with no process running it (its recovery
        // failed at boot) has no provider work to stop: interrupting it is
        // writing its end, through the same terminal path as any other.
        const { sessionId, threadId, turnId } = parsed.data.payload
        const running = record?.activeTurn?.turn.turnId === turnId
        let heldOpen = false
        if (options.database && !running) {
          options.flush?.()
          heldOpen = findOpenTurnId(options.database, { sessionId, threadId }) === turnId
        }
        if (heldOpen) {
          // The answer says what the rows say: a write that rolled back is
          // an error, not a success (I10). A turn whose end cannot be
          // written at all stays open until its rows are fixed or its
          // session is deleted.
          try {
            ;(options.finalizeNow ?? appendEvent)(
              ProofEventSchemas['turn.interrupted'].parse({
                type: 'event',
                name: 'turn.interrupted',
                eventId: randomUUID(),
                timestamp: new Date().toISOString(),
                scope: { type: 'thread', environmentId, sessionId, threadId },
                payload: { turnId, reason: 'user' },
              }),
            )
          } catch (error) {
            options.onPersistenceError?.(error, 'turn.interrupted')
            return errorResult(
              command.requestId,
              'unavailable',
              'The turn could not be ended. Try again, or delete the session.',
            )
          }
          return ProofResponseSchemas['turn.interrupt'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: { turnId },
          })
        }
        if (!record || record.session.sessionId !== parsed.data.payload.sessionId) {
          // A thread the rows hold is not unknown because this process has
          // not loaded it: nothing runs on it, so its turn is not in
          // progress (§4.7.3).
          const held =
            !record &&
            options.database !== undefined &&
            listThreadsForSession(options.database, sessionId).some(
              (thread) => thread.threadId === threadId,
            )
          return held
            ? errorResult(command.requestId, 'conflict', 'Turn is not in progress.')
            : errorResult(command.requestId, 'not_found', 'Thread not found.')
        }
        const providerRejection = rejectProvider(command.requestId, record.providerId)
        if (providerRejection) return providerRejection
        if (!providers[record.providerId].capabilities.canCancelPrompt) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'Provider cannot interrupt prompts.',
          )
        }
        const active = record.activeTurn
        if (!active || active.turn.turnId !== parsed.data.payload.turnId) {
          return errorResult(command.requestId, 'conflict', 'Turn is not in progress.')
        }
        if (!active.interruptRequested) {
          active.interruptRequested = true
          record.cancellation = record.runtimeSession
            .then((sessionId) => runtime.cancel({ ...route(record), sessionId }))
            .then(() => {
              if (record.activeTurn?.turn.turnId !== active.turn.turnId) return
              active.turn.state = 'interrupted'
              record.activeTurn = undefined
              touch(record, resting(record))
              emitInterrupted(record, active.turn.turnId)
            })
            .catch(() => {
              if (record.activeTurn?.turn.turnId !== active.turn.turnId) return
              // A prompt skipped during startup has no provider work left to stop.
              if (!active.promptStarted) {
                emitInterrupted(record, active.turn.turnId)
                active.turn.state = 'interrupted'
                record.activeTurn = undefined
                touch(record, resting(record))
                return
              }
              // A running prompt remains active so cancellation can be retried.
              active.interruptRequested = false
            })
            .finally(() => {
              record.cancellation = undefined
            })
        }
        return ProofResponseSchemas['turn.interrupt'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { turnId: active.turn.turnId },
        })
      }

      if (command.name === 'interaction.respond') {
        const parsed = ProofCommandSchemas['interaction.respond'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid interaction response.')
        }
        const { sessionId, threadId, response, commandId, build } = parsed.data.payload
        const record = threads.get(threadId)
        if (record && record.session.sessionId !== sessionId) {
          return errorResult(command.requestId, 'not_found', 'Thread not found.')
        }
        const entry = record?.interactions.get(response.interactionId)
        const done = () =>
          ProofResponseSchemas['interaction.respond'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: null,
          })
        const alreadyResolved = () =>
          errorResult(command.requestId, 'conflict', 'Interaction was already resolved.', {
            interactionId: response.interactionId,
          })
        if (!record || !entry) {
          // A restart ends every turn and cancels what it left pending, so an
          // interaction only the log remembers is settled, not unknown. That
          // holds with no thread in memory too: a client that reconnects by
          // replay never reopens the session, yet may still show the prompt.
          const logged =
            options.database &&
            (options.flush?.(),
            hasInteraction(options.database, {
              sessionId,
              threadId,
              interactionId: response.interactionId,
            }))
          if (logged) return alreadyResolved()
          return errorResult(
            command.requestId,
            'not_found',
            record ? 'Interaction not found.' : 'Thread not found.',
          )
        }
        // First write wins. `answer` is set before the provider hears it, so a
        // second answer racing the settlement event is refused here too and
        // nothing is ever forwarded twice.
        if (entry.answer) {
          return sameAnswer(entry.answer, { commandId, response, build })
            ? ((entry.result ?? entry.startBuild?.())?.then((result) => ({
                ...result,
                requestId: command.requestId,
              })) ?? done())
            : alreadyResolved()
        }
        // Settled without an answer from here: it timed out or was cancelled.
        if (entry.settled || record.activeTurn?.turn.turnId !== entry.turnId) {
          return alreadyResolved()
        }
        if (build && (response.kind !== 'plan' || response.outcome.outcome !== 'accepted')) {
          return errorResult(command.requestId, 'validation', 'Only an accepted plan can be built.')
        }
        const invalid = invalidResponse(entry.interaction, response)
        if (invalid) return errorResult(command.requestId, 'validation', invalid)
        const providerRejection = rejectProvider(command.requestId, record.providerId)
        if (providerRejection) return providerRejection
        const target = { providerId: record.providerId, requestId: entry.providerRequestId }
        // `invalidResponse` refused the reasons only the environment gives
        // (`turn_ended`, `server_restarted`); what is left is the provider's.
        type Forwarded<T> = T extends { outcome: 'cancelled' }
          ? {
              outcome: 'cancelled'
              reason?: Exclude<T['reason' & keyof T], 'turn_ended' | 'server_restarted'>
            }
          : T
        // The one cast: what `invalidResponse` let through is the provider's.
        const forwarded = <T>(outcome: T) => outcome as Forwarded<T>
        const forward =
          response.kind === 'permission'
            ? runtime.respondPermission &&
              (() =>
                runtime.respondPermission!({
                  ...target,
                  outcome: forwarded(response.outcome),
                }))
            : response.kind === 'question'
              ? runtime.respondQuestion &&
                (() =>
                  runtime.respondQuestion!({
                    ...target,
                    outcome: forwarded(response.outcome),
                  }))
              : runtime.respondPlan &&
                (() =>
                  runtime.respondPlan!({
                    ...target,
                    outcome: forwarded(response.outcome),
                  }))
        if (!forward) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'This environment cannot answer interactions.',
          )
        }
        const proposing = record.activeTurn!
        const followUp =
          build &&
          entry.interaction.kind === 'plan' &&
          entry.interaction.continuation === 'follow_up_turn'
        if (followUp && !proposing.completion) {
          return errorResult(command.requestId, 'conflict', 'The proposing turn has not started.')
        }
        entry.answer = { commandId, response, build, clientId: context?.clientId }
        if (followUp) record.pendingBuild = true
        try {
          forward()
        } catch (error) {
          entry.answer = undefined
          if (followUp) record.pendingBuild = false
          // The provider no longer holds the request: it settled on its own
          // and the event saying so never reached this turn.
          if (error instanceof Error && /already resolved/.test(error.message)) {
            entry.settled = true
            return alreadyResolved()
          }
          // Anything else left the request parked, so it stays answerable.
          return errorResult(command.requestId, 'internal', 'Could not answer the interaction.')
        }
        if (followUp) {
          // A terminal event can precede the runtime promise settling. Reserve
          // the thread until both provider work and host bookkeeping drain.
          const buildCommandId = randomUUID()
          entry.startBuild = () => {
            record.pendingBuild = true
            entry.result = proposing.completion!.then(() => {
              record.pendingBuild = false
              if (
                threads.get(threadId) !== record ||
                proposing.turn.state !== 'completed' ||
                proposing.promptFailed ||
                proposing.interruptRequested
              ) {
                return errorResult(
                  command.requestId,
                  'conflict',
                  'The proposing turn did not complete.',
                )
              }
              const result = sendTurn(
                {
                  type: 'command',
                  requestId: command.requestId,
                  name: 'turn.send',
                  payload: { sessionId, threadId, text: build.text, commandId: buildCommandId },
                },
                context,
                build.modeId,
              )
              // The verdict is already delivered, but a failed turn start has
              // not consumed the build. Let the winning answer retry only that
              // step, under the same send identity, once its cause recovers.
              if (result.type === 'error') {
                entry.result = undefined
                return result
              }
              return done()
            })
            return entry.result
          }
          return entry.startBuild()
        }
        return done()
      }

      return undefined
    },

    onRuntimeEvent(event: RuntimeEvent) {
      const record = threads.get(event.threadId)
      if (!record) return

      // A runtime that created a session where it meant to load one (no
      // identity, or one the agent had forgotten), including a respawn inside
      // a prompt: stamped now, synchronously, before that prompt is sent.
      if (event.event === 'session_created' && event.sessionId && !record.session.parentSessionId) {
        try {
          stampIdentity(record, event.sessionId)
        } catch (error) {
          options.onPersistenceError?.(error, 'session.created')
        }
      }

      if (event.event === 'background_tasks_update') {
        applyBackgroundTasks(record, event.data.tasks)
        return
      }
      if (event.event === 'background_turn_started') {
        startBackgroundTurn(record, event)
        return
      }
      const unrecorded = record.unrecordedBackgroundTurn
      if (unrecorded && event.messageId !== undefined && event.messageId === unrecorded.messageId) {
        startBackgroundTurn(record, unrecorded)
      }

      if (event.event === 'prompt_started') {
        const active = record.activeTurn
        if (!active || event.data.userMessageId !== active.userMessage?.messageId) return
        active.runtimeMessageId = event.messageId
        // Only now has the provider opened the session and accepted the mode.
        // A launch that fails before this leaves every composer where it was.
        if (active.modeId) options.onSessionMode?.(record.session.sessionId, active.modeId)
        projectRuntimeEvent(record, event, active)
        return
      }

      const active = record.activeTurn
      // An idle runtime can crash too. Expected reaping/shutdown is not a
      // session failure; an unexpected exit must reach sidebar subscribers.
      if (event.event === 'process_exited' && !active) {
        if (!event.data.expected && record.status !== 'error') {
          if (options.database) emitStatus(record, 'error')
          touch(record, 'error')
        }
        return
      }
      if (event.event === 'session_info_update') {
        if (typeof event.data.title === 'string') applyTitle(record, event.data.title, 'provider')
        return
      }
      const turnScoped =
        event.event === 'prompt_completed' ||
        event.category === 'stream' ||
        event.category === 'tool' ||
        event.category === 'permission' ||
        event.event === 'question_request' ||
        event.event === 'question_resolved' ||
        event.event === 'plan_review_request' ||
        event.event === 'plan_review_resolved' ||
        event.event === 'plan_update' ||
        event.event === 'subtask_update' ||
        event.category === 'error' ||
        event.event === 'process_exited'
      // Output of a turn the provider began by itself just before this one's
      // prompt reached it; see `foldedMessageId`.
      const folded =
        !!active?.foldedMessageId &&
        event.messageId === active.foldedMessageId &&
        event.event !== 'process_exited'
      if (folded) {
        // That turn's own ending is not this turn's: the prompt is still queued.
        const ends =
          event.event === 'prompt_completed' ||
          event.event === 'auth_required' ||
          event.event === 'capability_missing' ||
          ((event.event === 'rpc_error' || event.event === 'runtime_error') &&
            event.data.recoverable !== true)
        if (ends) return
      } else if (
        turnScoped &&
        (!active ||
          (!active.runtimeMessageId && event.event !== 'process_exited') ||
          (event.messageId !== undefined && event.messageId !== active.runtimeMessageId))
      ) {
        return
      }

      if (!active) {
        projectRuntimeEvent(record, event, undefined)
        return
      }

      if (event.event === 'subtask_update') {
        // Only a provider that exposes the child as a loadable session names
        // one; the subtask itself has no protocol projection yet.
        if (event.data.childSessionId) {
          registerChildSession(
            record,
            event.data.childSessionId,
            event.data.title ?? event.data.description ?? null,
          )
        }
        return
      }

      if (event.event === 'prompt_completed') {
        const interrupted =
          active.interruptRequested || /abort|cancel|interrupt/i.test(event.data.stopReason ?? '')
        projectRuntimeEvent(record, event, active, interrupted ? 'interrupted' : 'completed')
        active.turn.state = interrupted ? 'interrupted' : 'completed'
        record.activeTurn = undefined
        touch(record, resting(record))
        return
      }

      if (event.event === 'process_exited') {
        const interrupted = active.interruptRequested
        const reason: TurnFailureReason =
          event.data.signal || event.data.exitCode === null
            ? 'provider_process_crashed'
            : 'provider_process_exited'
        projectRuntimeEvent(record, event, active, interrupted ? 'interrupted' : 'failed', reason)
        active.turn.state = interrupted ? 'interrupted' : 'failed'
        record.activeTurn = undefined
        touch(record, interrupted ? resting(record) : 'error')
        return
      }

      if (
        event.event === 'auth_required' ||
        event.event === 'capability_missing' ||
        ((event.event === 'rpc_error' || event.event === 'runtime_error') &&
          event.data.recoverable !== true)
      ) {
        const interrupted = active.interruptRequested
        if (interrupted) emitInterrupted(record, active.turn.turnId)
        else projectRuntimeEvent(record, event, active, 'failed')
        active.turn.state = interrupted ? 'interrupted' : 'failed'
        record.activeTurn = undefined
        touch(record, interrupted ? resting(record) : 'error')
        return
      }

      projectRuntimeEvent(record, event, active)
    },
  }
  return service
}
