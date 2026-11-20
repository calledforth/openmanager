import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  ProofCommandSchemas,
  ProofEventSchemas,
  ProofResponseSchemas,
  SubagentSchema,
  STEER_SEND_NOW_CAPABILITY,
  SteerCommandSchemas,
  SteerResponseSchemas,
  BACKGROUND_TASKS_MAX,
  shouldReplaceSessionTitle,
  TURN_FAILURE_MESSAGES,
  titleFromPrompt,
  WorkspaceUnavailableDetailsSchema,
  type BackgroundTask,
  type CommandEnvelope,
  type DraftContent,
  type DurableTurnNotice,
  type ErrorCode,
  type TransientEvent,
  type Interaction,
  type InteractionKind,
  type InteractionResponse,
  type Message,
  type MessagePhase,
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
  type TurnStarted,
  type WorkspaceComposerPreference,
  type Cursor,
  EMPTY_THREAD_QUEUE,
  THREAD_QUEUE_MAX,
  type QueuedMessage,
  type QueuedMessageSettings,
  type ThreadQueue,
  type ThreadQueuePause,
  isSettledSubagentStatus,
  type SessionSubagent,
  type Subagent,
  type SubagentStatus,
} from '@openmanager/protocol/node'
import {
  projectAgentEvent,
  providers,
  ToolCallTracker,
  SessionUnknownError,
  type AgentRuntime,
  type HostDeps,
  type ProtocolEventContext,
  type RuntimeRoute,
  type RuntimeSessionArgs,
} from '@agentpack/runtime/node'
import {
  cancelledInteractionIds,
  findOpenTurnId,
  findSubagentByTask,
  findSubagentSessionId,
  findTurnByCommandId,
  getStoredSubagent,
  getProviderSessionId,
  getSessionSummary,
  hasInteraction,
  listAllSessionSummaries,
  listThreadsForSession,
  readThreadQueue,
  readThreadState,
  type ThreadState,
} from './db/session-store.ts'
import {
  mergeReport,
  preview,
  reportOf,
  sameRecord,
  subagentRecord,
  subagentStatusOf,
  type SubtaskUpdate,
} from './subagent-records.ts'
import { createSubagentWake } from './subagents/subagent-wake.ts'
import type { SpawnCaller, SpawnHost, SpawnProvider } from './subagents/spawn-tools.ts'
import type { ArtifactMetadata, ArtifactStore } from './artifacts.ts'
import { withSettledText } from './db/tool-output.ts'
import { waitingKind } from './db/session-activity.ts'
import type { WriteOptions } from './db/event-repository.ts'
import { sessionDeletionEvents } from './db/deletions.ts'
import { backgroundTasksWakeAgent } from './background-wake.ts'
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
const ONLY_ITS_AGENT = 'Only the agent that started this subagent can reach it.'
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
   * The folder one session runs in, when that is not `cwd` itself: the
   * "No project" workspace gives each session a subfolder of its own. Made
   * when asked, and throws when it cannot be; called on create and restore.
   */
  sessionCwd?: (sessionId: string) => string
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
  /**
   * Absent on a turn nobody sent: one the provider began by itself, or one
   * the environment prompted (`promptId`).
   */
  userMessage?: Message
  /**
   * The id the environment's own prompt went to the provider under, on a
   * turn it started with no user message (the one that resumes a moved
   * session). Its `prompt_started` matches on it; the prompt is never shown.
   */
  promptId?: string
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
  /**
   * The phase of the open text run, as its provider marked it. One message
   * has one phase, so a chunk of another phase opens a run of its own: Codex
   * can send its commentary and its answer back to back.
   */
  textRunPhase?: MessagePhase
  /**
   * The provider's id for the item the open text run belongs to, when it
   * names one. A chunk that names its phase and another item opens a run of
   * its own, so one host message holds one provider item (Codex can send two
   * narrations back to back). Chunks that name no phase never split a run.
   */
  textRunItemId?: string
  reasoningRunId?: string
  /**
   * Host ids (turn, message, activity) whose provider id this turn has
   * already stamped, or tried to: each is stamped once (`stampProviderId`).
   */
  providerIdsStamped?: Set<string>
  /**
   * Thoughts of this turn that no `stop` has closed yet, by host message id.
   * ACP providers never frame their thoughts, so the server closes them when
   * the provider moves on to text or a tool (docs/sync-foundations.md §4.3.3).
   */
  openReasoning?: Set<string>
  /** The mode the host is starting this turn in (a plan build), if it chose one. */
  modeId?: string
  generatedImages?: Set<string>
  /** What this turn's tool calls have sent so far. */
  toolCalls?: ToolCallTracker
  /** The tool call behind each open question, by host interaction id, when the provider says. */
  questionTools?: Map<string, string>
  /**
   * Tool calls whose input `watchToolInput` asked to see settle, by host id,
   * with when the host first saw that input (no later than the call ran).
   */
  watchedTools?: Map<string, number>
  toolIds: Map<string, string>
  /** Host ids of this turn's `spawn_agent` calls, in order: a card takes the place of each. */
  spawnCalls?: string[]
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
  'provider_notice',
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
 * closes both runs, so the next chunk of either kind starts fresh, and so does
 * a text chunk whose phase, or (with a phase) whose provider item, differs
 * from its run's. A thought's
 * `stop` closes its own run after it is filed, which keeps providers that frame
 * their blocks (Claude Code) at one id per block.
 */
function runMessageId(active: ActiveTurn, event: RuntimeEvent): string | undefined {
  if (event.event === 'agent_message_chunk') {
    active.reasoningRunId = undefined
    // Only a chunk that names a phase can start a new message. One that names
    // none (null counts as none) belongs to the run it arrives in, so a
    // provider that marks only some chunks of a message never has it broken
    // in two mid-sentence.
    const phase = event.data.phase ?? undefined
    const item = event.data.messageId
    const otherItem =
      item !== undefined && active.textRunItemId !== undefined && item !== active.textRunItemId
    if (active.textRunId && phase !== undefined && (active.textRunPhase !== phase || otherItem))
      active.textRunId = undefined
    if (!active.textRunId) {
      active.textRunId = randomUUID()
      active.textRunPhase = phase
      active.textRunItemId = item
    } else active.textRunItemId ??= item
    return active.textRunId
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
      | 'stopSubtask'
      | 'closeThread'
      | 'retireSession'
      | 'setSessionTitle'
      | 'steer'
      | 'withdrawSteer'
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
  /**
   * The messages the chat holds back, as the last committed
   * `thread.queue.updated` said: memory follows the log, never a write that
   * failed. See `writeQueue`.
   */
  queue: ThreadQueue
  /**
   * Steered messages the provider gave back that still wait at the front of
   * the queue, so the next one given back lines up behind them. See
   * `givenBackFirst`.
   */
  givenBackSteers?: Set<string>
  status: SessionStatus
  updatedAt: number
  /** In-memory mode only; with SQLite the row is the single source. */
  settledAt?: number
  /** In-memory mode only; with SQLite the row is the single source. */
  pinnedAt?: number
  /** In-memory mode only; with SQLite the row is the single source. */
  cookingAt?: number
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
   * Set on a child session that holds a subagent's work, as its summary
   * says it (docs/decisions/subagents.md, Child sessions).
   */
  subagent?: SessionSubagent
  /**
   * A child with no provider session of its own: its parent's runtime fills
   * it, and nothing may prompt, load or stop it as a session.
   */
  detached?: boolean
  /**
   * The draft images this session's launch claimed. A rolled-back launch
   * hands them back before the session's deletion would take them along, so
   * the draft it restores has its images.
   */
  claimedArtifacts?: string[]
  /**
   * Set once the session moved to another workspace in this process: its
   * provider session is then only ever resumed, never replaced by a fresh
   * one, so a transcript the new folder cannot find fails loudly instead of
   * starting a blank chat under the old id.
   */
  moved?: boolean
  /**
   * A move applied whose marker no turn has carried yet: the resume turn
   * could not open (a plan build held the thread, or it was refused). The
   * next turn opened on the thread opens with the marker, and its prompt
   * tells the agent where it is now.
   */
  movedTo?: { workspaceId: string; name: string; path: string }
}

/**
 * One subagent a runtime reported, as this process knows it. Keyed by the
 * session whose runtime reports it and the runtime's `taskId`
 * (docs/decisions/subagents.md, Identity).
 */
type SubagentEntry = {
  key: string
  taskId: string
  /** The record whose runtime reports it: its events arrive on this thread. */
  owner: ThreadRecord
  /** The record whose thread the record is filed on (its parent's transcript). */
  holder: ThreadRecord
  /** Everything the runtime reported, merged. */
  report: SubtaskUpdate
  /** As last announced. */
  record: Subagent
  /** The child session holding its work, unless the user deleted it. */
  child?: ThreadRecord
}

/**
 * A move the session's agent asked for (`move_session`), applied when the
 * turn that asked completes: the provider's process is pointed at one folder
 * for its whole life, so the new one takes over from the next turn.
 */
type PendingMove = {
  workspaceId: string
  /** The project's name when it was asked for, for the marker the move leaves. */
  name?: string
  /** The thread whose turn asked. */
  threadId: string
  /**
   * The turn whose completion applies the move: the one that asked, or the
   * one that took over from it (a steered message's own turn).
   */
  turnId?: string
  /**
   * Set instead of `turnId` when the asking turn completed while the
   * provider still held steered messages sent into it: the move waits on
   * what becomes of them, never on whichever turn completes next
   * (`steerResolved`).
   */
  steerIds?: Set<string>
  /** One of `steerIds` was given back to the queue rather than run. */
  givenBack?: boolean
}

/** What `requestMove` answers the tool: the move it filed, or why it filed none. */
export type MoveRequest =
  | {
      ok: true
      workspaceId: string
      cwd: string
      /** Background work the session has running, which stops when it moves. */
      backgroundTasks: number
    }
  | { ok: false; message: string }

/**
 * Providers proven to resume a session from another folder by its id alone.
 * Claude Code finds a transcript in any project folder; OpenCode and Cursor
 * file sessions by project and are not known to, so theirs stay put.
 */
export const MOVABLE_PROVIDERS: readonly string[] = ['claude']

/**
 * What the provider reads on the turn that resumes a moved session: where it
 * is now, and to carry on. The user never sees it; the transcript shows the
 * move's marker instead.
 */
export const movedPrompt = (name: string, path: string) =>
  `${movedNote(name, path)} ` +
  `Carry on with the work there. If nothing is left to do, say in a sentence that the session is now in ${name}.`

/** Where a moved session is now, ahead of a sent prompt that opens in its new folder. */
const movedNote = (name: string, path: string) =>
  `OpenManager moved this session to the project "${name}" at ${path}; that is your working directory now.`

/** Why a session the rows hold could not be loaded: the answer an open gives. */
export type LoadRefusal = { code: ErrorCode; message: string; details?: unknown }
type SessionOpenPosition = { environment: Cursor; session: Cursor }

type Loaded =
  { refused: LoadRefusal } | { session: SessionSummary; threads: Thread[]; at: SessionOpenPosition }

/**
 * A queue with the steered messages `returning` picks given back as `queued`.
 * They were meant for the running turn, so they move ahead of every message
 * that was only queued, keeping their order. `ahead` names steers given back
 * earlier that already wait at the front.
 */
function givenBackFirst(
  items: readonly QueuedMessage[],
  ahead: ReadonlySet<string>,
  returning: (item: QueuedMessage) => boolean,
): QueuedMessage[] {
  const front: QueuedMessage[] = []
  const rest: QueuedMessage[] = []
  for (const item of items) {
    if (returning(item)) front.push({ ...item, delivery: 'queued' })
    else if (ahead.has(item.queueItemId)) front.push(item)
    else rest.push(item)
  }
  return [...front, ...rest]
}

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
      selection: Pick<WorkspaceComposerPreference, 'modelId' | 'modeId' | 'configValues'>,
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
    /**
     * The composer selection a message sent now would run with: the
     * session's own, with the workspace preference for what it has not
     * chosen. A queued message keeps it, so it runs on what the user saw.
     */
    queuedSettings?: (args: {
      providerId: ProviderId
      workspaceId: string
      threadId: string
    }) => QueuedMessageSettings
    /** Something the queue could not do that nobody is waiting on an answer for. */
    onQueueProblem?: (message: string, data: Record<string, unknown>) => void
    /** The providers and models `spawn_agent` can start a child on. */
    spawnProviders?: () => readonly SpawnProvider[]
    /** The providers whose sessions may move to another folder; `MOVABLE_PROVIDERS` by default. */
    movableProviders?: readonly string[]
    /** A move a session's agent asked for that could not be applied when its turn completed. */
    onMoveProblem?: (message: string, data: Record<string, unknown>) => void
    /**
     * Tool calls the host wants to hear about when they end, by their input
     * (a shell command running `gh pr create`). Asked of every tool update
     * that carries input; each call it accepts is reported once by
     * `onWatchedToolSettled`, when it completes or fails, with its whole text
     * when the update carries it. Called before the update is appended.
     */
    watchToolInput?: (input: unknown) => boolean
    /**
     * Every tool update that carries input, with the session and project it
     * ran in, before it is appended: for a host that wants to know which
     * agent touched what (the scratchpad's author). Must be cheap.
     */
    onToolInput?: (call: {
      sessionId: string
      workspaceId: string
      providerId: string
      kind: string | undefined
      input: unknown
    }) => void
    onWatchedToolSettled?: (args: {
      sessionId: string
      toolCallId: string
      text: string | undefined
      /** When the host first saw the call's input, in ms: before it ran. */
      startedAt: number
    }) => void
  } = {},
) {
  const sessions = new Map<string, ThreadRecord>()
  const threads = new Map<string, ThreadRecord>()
  /** Every subagent this process has heard of, by `subagentKey`. */
  const subagentEntries = new Map<string, SubagentEntry>()
  const subagentsById = new Map<string, SubagentEntry>()
  /** Moves asked for by a session's agent, by root session id, until their turn completes. */
  const pendingMoves = new Map<string, PendingMove>()
  /**
   * Subagents whose child the user deleted while this process runs, by the
   * same key. The runtime may still report the subagent, and that report
   * must not quietly recreate what the user removed. After a restart the
   * stored record, naming a child that is gone, says the same.
   */
  const forgottenChildren = new Set<string>()
  /**
   * The child that raised each open request of a subagent, by provider and
   * the provider's request id, so the request's settlement reaches that
   * child even when the runtime does not tag it.
   */
  const childRequests = new Map<string, ThreadRecord>()
  /**
   * Subagents whose record went with a deleted child it was filed on (a
   * nested subagent's parent subagent). Nothing is left to show it on, so
   * later reports of it are dropped rather than filed somewhere else.
   */
  const droppedSubagents = new Set<string>()
  // Supplied after construction so the service can be assembled before the
  // WebSocket publisher exists.
  let environmentId = ''

  /**
   * A child whose transcript lives in its parent's agent (a provider's own
   * subagent) is only ever loaded. A child of ours (`spawn_agent`) is an
   * ordinary session on its own provider, created like any other.
   */
  const loadOnly = (record: ThreadRecord) =>
    !!record.session.parentSessionId && record.subagent?.origin !== 'openmanager'

  /**
   * The title a provider that names its sessions (Codex) is given: one the
   * user or the title model wrote. A fallback is only the first prompt, which
   * the provider already shows, and a provider's own title is its to keep. A
   * provider's subagent is named by its parent's agent.
   */
  const providerTitle = (record: ThreadRecord): string | undefined =>
    (record.titleSource === 'user' || record.titleSource === 'generated') && !loadOnly(record)
      ? record.session.title?.trim() || undefined
      : undefined

  const route = (record: ThreadRecord, sessionId?: string): RuntimeSessionArgs => {
    const title = providerTitle(record)
    return {
      providerId: record.providerId,
      threadId: record.thread.threadId,
      workspaceId: record.session.workspaceId,
      cwd: record.cwd,
      ...(sessionId ? { sessionId } : {}),
      // A sub-agent's transcript lives in the agent: a fresh session in its
      // place would lose it, so the runtime may only load it, on every start and
      // every respawn (docs/sync-foundations.md §4.7.4 (e)).
      ...(loadOnly(record) || record.moved ? { load: 'require' as const } : {}),
      // Given to the provider when its process starts; a change after that
      // goes through `sendTitle`.
      ...(title ? { title } : {}),
    }
  }

  /**
   * A title the user or the title model just wrote, to the session's live
   * runtimes. One with no live process gets it from `route` when it next
   * starts, so a rename never starts a process. Best-effort: a provider that
   * refuses it never fails the rename.
   */
  const sendTitle = (sessionId: string) => {
    for (const item of threads.values()) {
      if (item.session.sessionId !== sessionId) continue
      const title = providerTitle(item)
      if (!title) continue
      void runtime
        .setSessionTitle?.({ providerId: item.providerId, threadId: item.thread.threadId, title })
        .catch(() => undefined)
    }
  }

  /**
   * The provider session of a child its parent's runtime fills: none. Every
   * path that would prompt, load or stop it as a session refuses it first;
   * this only keeps one that slips through from reaching a provider.
   */
  const detachedSession = () => {
    const none = Promise.reject(
      new Error(ONLY_ITS_AGENT),
    )
    none.catch(() => undefined)
    return none
  }

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
    if (!options.database || loadOnly(record)) return providerSessionId
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

  /** The turns with a live notice out; see `endLiveNotice`. */
  const liveNotices = new Set<string>()

  /**
   * A live notice says what the provider is doing about a hiccup right now.
   * The turn's next durable event means it has moved on, or the turn has
   * ended, and the server says so: a client holds a live notice until then.
   * The user's own prompt is no sign of recovery.
   */
  const endLiveNotice = (event: ProofEvent) => {
    if (!('turnId' in event.payload) || !liveNotices.has(event.payload.turnId)) return
    if (event.name === 'message.delta' && event.payload.role === 'user') return
    const { turnId } = event.payload
    liveNotices.delete(turnId)
    publishTransient(
      ProofEventSchemas['turn.notice.cleared'].parse({
        type: 'event',
        name: 'turn.notice.cleared',
        eventId: randomUUID(),
        timestamp: event.timestamp,
        scope: event.scope,
        payload: { turnId },
      }),
    )
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
    endLiveNotice(event)
    if (
      event.name === 'turn.completed' ||
      event.name === 'turn.interrupted' ||
      event.name === 'turn.failed'
    ) {
      const record = threads.get(event.scope.threadId)
      // Mirrors the SQLite projection: only a completed turn leaves news
      // behind, and not while background work that will wake the agent is
      // still running.
      if (record) {
        const awaitingWake =
          !!record.backgroundTasks?.length && backgroundTasksWakeAgent(record.providerId)
        record.doneAt =
          event.name === 'turn.completed' && !awaitingWake ? Date.parse(event.timestamp) : undefined
      }
      // Deferred until the caller has marked the turn completed, which it
      // does right after announcing it.
      if (record && event.name === 'turn.completed') queueMicrotask(() => refineTitle(record))
      // A subagent running in the foreground ends with the turn that ran it,
      // whatever its runtime says after; one in the background runs on.
      if (record && event.name !== 'turn.completed') {
        queueMicrotask(() =>
          interruptSubagentsOf(
            record,
            (entry) => !entry.record.background,
            'The turn that started it ended.',
          ),
        )
      }
      // The queue follows the turn's end, deferred for the same reason: the
      // next turn may only start once this one is off the record.
      if (record && committed) {
        const ended = event.name
        const restarted =
          event.name === 'turn.interrupted' && event.payload.reason === 'server_restarted'
        const turnId = event.payload.turnId
        queueMicrotask(() => {
          // Before the queue: a message waiting behind this turn runs in the new folder.
          settleMove(record, turnId, ended === 'turn.completed')
          settleQueue(record, ended, restarted)
        })
      } else if (record) {
        // An end the rows do not hold: the turn is still open there, so the
        // move it asked for cannot apply. It is dropped, not kept waiting.
        settleMove(record, event.payload.turnId, false)
      }
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
      /** What the child holds, for a subagent's child session. */
      subagent?: SessionSubagent
      /** The runtime's key of each subagent record `alongside` creates; see WriteOptions. */
      subagentTasks?: WriteOptions['subagentTasks']
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
          ...(created.subagent ? { subagent: created.subagent } : {}),
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
      const write: WriteOptions = {
        ...(created.identity ? { identities: { [session.sessionId]: created.identity } } : {}),
        ...(created.subagentTasks ? { subagentTasks: created.subagentTasks } : {}),
      }
      options.appendAtomic(
        [announced, threadCreated, ...alongside],
        Object.keys(write).length > 0 ? write : undefined,
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
      // A move it asked for goes with it: nothing is left to move.
      pendingMoves.delete(id)
      for (const [threadId, item] of threads) {
        if (item.session.parentSessionId === id) pending.push(item.session.sessionId)
        if (item.session.sessionId !== id) continue
        threads.delete(threadId)
        dropped.push(item)
      }
    }
    for (const [key, entry] of subagentEntries) {
      if (seen.has(entry.owner.session.sessionId) || seen.has(entry.holder.session.sessionId)) {
        subagentEntries.delete(key)
        subagentsById.delete(entry.record.subagentId)
        if (!seen.has(entry.owner.session.sessionId)) droppedSubagents.add(key)
      } else if (entry.child && seen.has(entry.child.session.sessionId)) entry.child = undefined
    }
    for (const [key, child] of childRequests) {
      if (seen.has(child.session.sessionId)) childRequests.delete(key)
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
    // A subagent's child with no provider session of its own is only ever
    // filled by its parent's runtime: there is nothing to load.
    const detached = session.subagent?.origin === 'native' && !providerSessionId
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
        runtimeSession: detached
          ? detachedSession()
          : Promise.resolve().then(() => {
              if (threads.get(thread.threadId) !== record) throw new Error('Session was closed.')
              return runtime
                .ensureSession(route(record, providerSessionId))
                .then((result) => stampIdentity(record, result.sessionId))
            }),
        ...(session.subagent ? { subagent: session.subagent } : {}),
        ...(detached ? { detached: true } : {}),
        turns: [],
        messages: [],
        commandTurns: new Map(),
        interactions: new Map(),
        // Restored as the rows hold it. A restart has already paused it
        // (`pauseQueuesAfterRestart`), so nothing drains on its own.
        queue: options.database
          ? readThreadQueue(options.database, thread.threadId)
          : EMPTY_THREAD_QUEUE,
        titleSource: session.titleSource,
        status: session.status,
        updatedAt: Date.parse(session.updatedAt),
      }
      if (!detached) void record.runtimeSession.catch((error: unknown) => {
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
    // A native subagent's child holds what its parent's runtime filed, and
    // nothing more: it opens from the rows alone.
    if (!providerSessionId && session.parentSessionId && !session.subagent) {
      return { refused: UNRECOVERABLE }
    }
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
    // A sub-agent ran in its parent's folder (`registerChild`), so it is
    // restored there: the folder is named for the root of its tree.
    let root = session
    for (let depth = 0; root.parentSessionId && depth < 64; depth += 1) {
      const parent = getSessionSummary(database, root.parentSessionId)
      if (!parent) break
      root = parent
    }
    let cwd: string
    try {
      cwd = target.sessionCwd?.(root.sessionId) ?? target.cwd
    } catch {
      return { refused: workspaceRefusal(session.workspaceId) }
    }
    const restoredThreads = listThreadsForSession(database, sessionId)
    if (!restoredThreads.length) {
      return { refused: { code: 'not_found', message: 'Thread not found.' } }
    }
    restoreSession(session, providerId, providerSessionId, cwd, restoredThreads)
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
   * What deleting these sessions asks of each provider session going with
   * them: retire it, which for Codex archives the thread and never deletes
   * it (docs/decisions/codex-app-server.md, "Threads: archive on delete, no
   * import"). Read before the rows go. Every thread of a session is retired,
   * so whichever holds a live runtime archives on it and every runtime is
   * stopped; only the session's first thread carries the stored provider
   * session, for archiving when no runtime holds it. One whose provider
   * session is still being made carries none, and its runtime archives its
   * own thread once started. A provider's own subagent is its parent's
   * agent's to keep.
   */
  const retirements = (
    sessionIds: readonly string[],
  ): Array<RuntimeRoute & { sessionId?: string }> => {
    const database = options.database
    return sessionIds.flatMap((id) => {
      const stored = database ? getProviderSessionId(database, id) : undefined
      const records = [...threads.values()].filter((item) => item.session.sessionId === id)
      if (records.length > 0) {
        const primary = sessions.get(id) ?? records[0]
        return records
          .filter((record) => !loadOnly(record))
          .map((record) => ({
            providerId: record.providerId,
            threadId: record.thread.threadId,
            workspaceId: record.session.workspaceId,
            cwd: record.cwd,
            ...(record === primary && stored ? { sessionId: stored } : {}),
          }))
      }
      if (!database) return []
      const summary = getSessionSummary(database, id)
      if (!summary) return []
      if (summary.parentSessionId && summary.subagent?.origin !== 'openmanager') return []
      let cwd = homedir()
      try {
        cwd = resolveWorkspace(summary.workspaceId)?.cwd ?? cwd
      } catch {
        /* the folder is gone; archiving needs none */
      }
      return listThreadsForSession(database, id).map((thread, index) => ({
        providerId: summary.providerId as ProviderId,
        threadId: thread.threadId,
        workspaceId: summary.workspaceId,
        cwd,
        ...(index === 0 && stored ? { sessionId: stored } : {}),
      }))
    })
  }

  /** Retire each one, in the background: a deletion never waits on a provider. */
  const retire = (targets: ReadonlyArray<RuntimeRoute & { sessionId?: string }>) => {
    for (const target of targets) void runtime.retireSession?.(target).catch(() => undefined)
  }

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

  /**
   * Where each kind of provider id is kept, by host id and thread. An id the
   * thread already holds is never written twice: a provider's turn and
   * message ids are unique per thread, so a provider item split across two
   * host messages keeps its id on the first.
   */
  let providerIdWrites: Record<'turn' | 'message' | 'activity', StatementSync> | undefined
  const providerIdWritesFor = (database: DatabaseSync) =>
    (providerIdWrites ??= {
      turn: database.prepare(
        `UPDATE turns SET provider_turn_id = ?1
         WHERE turn_id = ?2 AND thread_id = ?3 AND provider_turn_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM turns WHERE thread_id = ?3 AND provider_turn_id = ?1)`,
      ),
      message: database.prepare(
        `UPDATE messages SET external_id = ?1
         WHERE message_id = ?2 AND thread_id = ?3 AND external_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id = ?3 AND external_id = ?1)`,
      ),
      activity: database.prepare(
        `UPDATE turn_activity SET external_id = ?1
         WHERE activity_id = ?2 AND thread_id = ?3 AND external_id IS NULL`,
      ),
    })

  /**
   * Keep a provider's own id beside the host row it names: a turn's
   * (`turns.provider_turn_id`), an assistant message's (`messages.external_id`),
   * a reasoning block's or a tool call's (`turn_activity.external_id`).
   * Host-private and not activity, like a provider session id's stamp: no
   * event carries it, and no `updated_at` moves. Each row takes the first id
   * the provider gives it, once. The row may still be in the batcher, so
   * what is buffered is written first. A stamp that fails leaves NULL, as for
   * a provider that names nothing, and never costs the turn its events.
   */
  const stampProviderId = (
    record: ThreadRecord,
    active: ActiveTurn,
    target: 'turn' | 'message' | 'activity',
    hostId: string,
    providerId: string,
  ) => {
    const database = options.database
    if (!database) return
    const stamped = (active.providerIdsStamped ??= new Set())
    if (stamped.has(hostId)) return
    stamped.add(hostId)
    try {
      options.flush?.()
      providerIdWritesFor(database)[target].run(providerId, hostId, record.thread.threadId)
    } catch (error) {
      if (!options.onPersistenceError) throw error
      options.onPersistenceError(error, 'provider id')
    }
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
          undefined,
          undefined,
          stableId(active.toolIds, event.data.toolCallId),
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

  const toolCallsFor = (active: ActiveTurn) => (active.toolCalls ??= new ToolCallTracker())

  /** The tool call a permission answer refused, if it refused one. */
  const declinedToolCall = (interaction: Interaction, response: InteractionResponse) => {
    if (interaction.kind !== 'permission' || response.outcome.outcome !== 'selected') return
    const { optionId } = response.outcome
    const option = interaction.options.find((item) => item.optionId === optionId)
    return option?.kind === 'reject_once' || option?.kind === 'reject_always'
      ? interaction.toolCall.toolCallId
      : undefined
  }

  /**
   * What a question's answer leaves on its tool: Cursor's answers exist only in
   * the interaction, so the server states them, keyed by prompt as a row reads them.
   */
  const answeredInput = (interaction: Interaction, response: InteractionResponse) => {
    if (interaction.kind !== 'question' || response.kind !== 'question') return undefined
    if (response.outcome.outcome !== 'answered') return undefined
    const given = new Map(response.outcome.answers.map((answer) => [answer.questionId, answer]))
    const answers: Record<string, string> = {}
    for (const question of interaction.questions) {
      const answer = given.get(question.questionId)
      const labels = (answer?.selectedOptionIds ?? []).map(
        (id) => question.options.find((option) => option.optionId === id)?.label ?? id,
      )
      const parts = [...labels, ...(answer?.text?.trim() ? [answer.text.trim()] : [])]
      if (parts.length > 0) answers[question.prompt] = parts.join(', ')
    }
    return {
      questions: interaction.questions.map(({ prompt }) => ({ prompt })),
      answers,
    }
  }

  /** The provider's item id of what an event was filed as, beside its row. */
  const stampItemId = (
    record: ThreadRecord,
    active: ActiveTurn,
    event: RuntimeEvent,
    projected: ProofEvent,
    providerToolId: string | undefined,
  ) => {
    if (
      projected.name === 'message.delta' &&
      projected.payload.role === 'assistant' &&
      event.event === 'agent_message_chunk' &&
      event.data.messageId
    ) {
      stampProviderId(record, active, 'message', projected.payload.messageId, event.data.messageId)
    } else if (
      projected.name === 'message.reasoning' &&
      event.event === 'agent_thought_chunk' &&
      event.data.messageId
    ) {
      stampProviderId(record, active, 'activity', projected.payload.messageId, event.data.messageId)
    } else if (projected.name === 'tool.updated' && providerToolId) {
      stampProviderId(record, active, 'activity', projected.payload.toolCallId, providerToolId)
    }
  }

  const projectOwnEvent = (
    record: ThreadRecord,
    event: RuntimeEvent,
    active: ActiveTurn | undefined,
    completionState?: ProtocolEventContext['completionState'],
    failureReason?: TurnFailureReason,
    /** The host id of the tool call a promoted image came from. */
    imageToolCallId?: string,
  ): void => {
    if (event.event === 'turn_identified') {
      if (active)
        stampProviderId(record, active, 'turn', active.turn.turnId, event.data.providerTurnId)
      return
    }
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
    const toolCalls = active
      ? providerToolId !== undefined
        ? toolCallsFor(active)
        : active.toolCalls
      : undefined
    // A text chunk that names no phase takes its run's, so it is stored with
    // the message it joins rather than refused as a mismatch.
    const source =
      event.event === 'agent_message_chunk' &&
      (event.data.phase ?? undefined) === undefined &&
      active?.textRunPhase !== undefined
        ? { ...event, data: { ...event.data, phase: active.textRunPhase } }
        : event
    const projected = projectAgentEvent(source, {
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
      toolCalls,
      interruptRequested: active?.interruptRequested,
    })
    if (!projected) return
    if (projected.name === 'tool.updated') {
      const text = toolCalls?.takeBody(projected.payload.toolCallId)
      if (text !== undefined) withSettledText(projected, text)
      const { toolCallId, input, status } = projected.payload
      if (input !== undefined && options.onToolInput) {
        try {
          options.onToolInput({
            sessionId: record.session.sessionId,
            workspaceId: record.session.workspaceId,
            providerId: record.providerId,
            kind: projected.payload.kind ?? toolCalls?.known(toolCallId).kind,
            input,
          })
        } catch {
          // A host's bookkeeping must not cost the agent its tool update.
        }
      }
      if (
        active &&
        input !== undefined &&
        !active.watchedTools?.has(toolCallId) &&
        options.watchToolInput?.(input)
      ) {
        ;(active.watchedTools ??= new Map()).set(toolCallId, Date.now())
      }
      // `gh pr create` that found a pull request already open exits with a
      // failure and still names it, so a failed call is reported too.
      const startedAt = active?.watchedTools?.get(toolCallId)
      if (startedAt !== undefined && (status === 'completed' || status === 'failed')) {
        active!.watchedTools!.delete(toolCallId)
        options.onWatchedToolSettled?.({
          sessionId: record.session.sessionId,
          toolCallId,
          text,
          startedAt,
        })
      }
    }
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
        projected.payload.content = {
          ...options.artifacts.reference(metadata),
          ...(imageToolCallId ? { toolCallId: imageToolCallId } : {}),
        }
      } catch (error) {
        options.onPersistenceError?.(error, 'artifact.generated')
        // Never fall back to putting image bytes in the event log. The gap
        // stays explained in the transcript, where the image would have been.
        const noticeId = randomUUID()
        appendRuntimeEvent(
          ProofEventSchemas['turn.notice.recorded'].parse({
            type: 'event',
            name: 'turn.notice.recorded',
            eventId: noticeId,
            timestamp: event.timestamp,
            scope: threadScope(record),
            payload: {
              noticeId,
              turnId: projected.payload.turnId,
              kind: 'warning',
              message: 'A generated image could not be stored.',
            },
          }),
        )
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
        projected.name === 'tool.updated' ||
        projected.name === 'turn.notice.recorded')
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
    if (projected.name === 'turn.notice') {
      liveNotices.add(projected.payload.turnId)
      publishTransient(projected)
    } else appendRuntimeEvent(projected)
    if (active) stampItemId(record, active, event, projected, providerToolId)
    if (active && projected.name === 'message.reasoning') {
      active.openReasoning ??= new Set()
      if (projected.payload.phase === 'stop')
        active.openReasoning.delete(projected.payload.messageId)
      else active.openReasoning.add(projected.payload.messageId)
    }
    if (active && projected.name === 'interaction.requested') {
      const { interaction } = projected.payload
      if (event.event === 'question_request' && event.data.toolCallId) {
        active.questionTools ??= new Map()
        active.questionTools.set(
          interaction.interactionId,
          stableId(active.toolIds, event.data.toolCallId)!,
        )
      }
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
      if (record.subagent) childRequestsChanged(record, providerInteractionId, true)
    } else if (
      active &&
      (projected.name === 'interaction.resolved' || projected.name === 'interaction.expired')
    ) {
      const entry = record.interactions.get(projected.payload.response.interactionId)
      if (entry) {
        entry.settled = true
        entry.resolution = projected.payload.response
        // A refusal is the call's outcome from this moment: an event, so it
        // does not depend on what the provider does next or on this process.
        const refused = declinedToolCall(entry.interaction, projected.payload.response)
        const asked = active.questionTools?.get(projected.payload.response.interactionId)
        const input = answeredInput(entry.interaction, projected.payload.response)
        if (asked && input && toolCallsFor(active).isSeen(asked)) {
          appendRuntimeEvent(
            ProofEventSchemas['tool.updated'].parse({
              type: 'event',
              name: 'tool.updated',
              eventId: randomUUID(),
              timestamp: projected.timestamp,
              scope: threadScope(record),
              payload: { toolCallId: asked, turnId: active.turn.turnId, input },
            }),
          )
        }
        if (refused && toolCallsFor(active).decline(refused)) {
          const outputBytes = toolCallsFor(active).outputBytes(refused)
          appendRuntimeEvent(
            ProofEventSchemas['tool.updated'].parse({
              type: 'event',
              name: 'tool.updated',
              eventId: randomUUID(),
              timestamp: projected.timestamp,
              scope: threadScope(record),
              payload: {
                toolCallId: refused,
                turnId: active.turn.turnId,
                status: 'declined',
                finishedAt: projected.timestamp,
                ...(outputBytes > 0 ? { outputBytes } : {}),
              },
            }),
          )
        }
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
      if (record.subagent) childRequestsChanged(record, providerInteractionId, false)
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

  const touch = (record: ThreadRecord, requested?: SessionStatus) => {
    record.updatedAt = Date.now()
    if (!requested) return
    // Its provider is blocked on a native subagent's request, so the session
    // waits with it, as the rows say (event-projection.ts).
    const status =
      (requested === 'running' || requested === 'idle') && subagentsWaiting(record)
        ? 'waiting'
        : requested
    const changed = record.status !== status
    record.status = status
    if (record.subagent?.origin === 'openmanager') syncSpawnedSoon(record)
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
    waitingOn: status === 'waiting' ? (waitingKind(requestsUnder(record)) ?? null) : null,
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
    sendTitle(sessionId)
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
    // Running on background work alone is no new turn: the result stands.
    const backgroundOnly =
      status === 'running' && !record.activeTurn && !!record.backgroundTasks?.length
    if ((status === 'running' && !backgroundOnly) || status === 'waiting') record.doneAt = undefined
    // And as it does for cooking: asking, failing or finishing brings it back,
    // finishing beside background work that just runs on included.
    const uncook =
      record.cookingAt !== undefined &&
      (status === 'waiting' ||
        status === 'error' ||
        ((status === 'idle' || backgroundOnly) && record.doneAt !== undefined))
    if (uncook) record.cookingAt = undefined
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
          ...(uncook ? { cookingAt: null } : {}),
          doneAt: record.doneAt === undefined ? null : new Date(record.doneAt).toISOString(),
        },
      }),
    )
  }

  // ------------------------------------------------------------ subagents
  //
  // docs/decisions/subagents.md. A runtime reports each subagent with
  // `subtask_update` under a `taskId` of its own, and tags the subagent's work
  // with `subtaskId`. Each subagent is one record, filed on the thread whose
  // transcript holds the call that started it, and one child session, filed
  // under that thread's session, holding its work as the child's own turns.

  const subagentKey = (owner: ThreadRecord, taskId: string) =>
    `${owner.session.sessionId}\n${taskId}`

  /** Events a subagent's work is made of; the rest belong to its runtime. */
  const SUBAGENT_WORK: ReadonlySet<RuntimeEvent['event']> = new Set<RuntimeEvent['event']>([
    'agent_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
    'tool_call_content',
    'permission_request',
    'permission_resolved',
    'question_request',
    'question_resolved',
    'plan_review_request',
    'plan_review_resolved',
    'plan_update',
    'provider_notice',
  ])

  /** The provider's request id an event settles, for a request a child raised. */
  const settledRequestKey = (event: RuntimeEvent) =>
    event.event === 'permission_resolved' ||
    event.event === 'question_resolved' ||
    event.event === 'plan_review_resolved'
      ? `${event.providerId}\n${event.data.requestId}`
      : undefined

  /** Native subagents filed directly under a record, in memory. */
  const nativeChildrenOf = (record: ThreadRecord) =>
    [...threads.values()].filter(
      (item) =>
        item.subagent?.origin === 'native' &&
        item.session.parentSessionId === record.session.sessionId,
    )

  /**
   * The requests a record waits on: its turn's own, and those of its native
   * subagents at any depth, whose provider is this record's and is blocked
   * on them (docs/decisions/subagents.md, Permissions and questions).
   */
  const requestsUnder = (
    record: ThreadRecord,
    depth = 0,
  ): { kind: InteractionKind; createdAt: number }[] => [
    ...(record.activeTurn?.pendingInteractions.values() ?? []),
    ...(depth < 16
      ? nativeChildrenOf(record).flatMap((child) => requestsUnder(child, depth + 1))
      : []),
  ]

  const subagentsWaiting = (record: ThreadRecord) =>
    nativeChildrenOf(record).some((child) => requestsUnder(child).length > 0)

  /**
   * Restate each session above a native subagent's child once the child's
   * requests changed: waiting while one is open under it, and what its own
   * turn and background work say once none is (`touch` lays the subagents'
   * requests over it). The rows do the same in their own transaction
   * (event-projection.ts `refreshParentsOf`).
   */
  const refreshParentsWaiting = (child: ThreadRecord) => {
    let item = child
    for (let depth = 0; depth < 16; depth++) {
      if (item.subagent?.origin !== 'native' || !item.session.parentSessionId) return
      const parent = sessions.get(item.session.parentSessionId)
      if (!parent) return
      if (parent.status === 'waiting' || parent.status === 'running' || parent.status === 'idle') {
        touch(
          parent,
          parent.activeTurn?.pendingInteractions.size
            ? 'waiting'
            : parent.activeTurn
              ? 'running'
              : resting(parent),
        )
      }
      item = parent
    }
  }

  const subagentEvent = (holder: ThreadRecord, subagent: Subagent, timestamp: string) =>
    ProofEventSchemas['subagent.updated'].parse({
      type: 'event',
      name: 'subagent.updated',
      eventId: randomUUID(),
      timestamp,
      scope: threadScope(holder),
      payload: { subagent },
    })

  /** The record as it stands now: what the runtime reported, where it is filed, what its child waits on. */
  const restate = (entry: SubagentEntry, at: string): Subagent => {
    const previous = entry.record
    const waitingOn = entry.child?.activeTurn
      ? waitingKind(entry.child.activeTurn.pendingInteractions.values())
      : undefined
    return subagentRecord(
      entry.report,
      {
        subagentId: previous.subagentId,
        parentSessionId: previous.parentSessionId,
        turnId: previous.turnId,
        ...(previous.toolCallId ? { toolCallId: previous.toolCallId } : {}),
        ...(previous.parentSubagentId ? { parentSubagentId: previous.parentSubagentId } : {}),
        depth: previous.depth,
        origin: previous.origin,
        providerId: previous.providerId,
        ...(entry.child ? { childSessionId: entry.child.session.sessionId } : {}),
      },
      {
        startedAt: previous.startedAt,
        finishedAt: previous.finishedAt ?? at,
        updatedAt: at,
      },
      waitingOn,
    )
  }

  /**
   * Announce the record when it says something new. Whole, on the thread
   * that holds the call that started it, so a client applying it twice, or
   * only the newest, holds the same card.
   */
  const announceSubagent = (entry: SubagentEntry, at = new Date().toISOString()) => {
    const next = restate(entry, at)
    if (sameRecord(entry.record, next)) return
    // Memory follows the report either way: the batcher keeps a write that
    // failed and writes it before anything later, and the next restatement
    // is whole.
    appendRuntimeEvent(subagentEvent(entry.holder, next, at))
    entry.record = next
  }

  const rememberSubagent = (entry: SubagentEntry) => {
    subagentEntries.set(entry.key, entry)
    subagentsById.set(entry.record.subagentId, entry)
  }

  /**
   * A delegated turn: begun by the parent agent, its user message what the
   * parent asked. A runtime that has not said the prompt yet has said what
   * the subagent is for, and that stands in for it.
   */
  const delegatedTurn = (thread: Thread, asked: string, at: string) => {
    const turn: Turn = {
      turnId: randomUUID(),
      threadId: thread.threadId,
      state: 'running',
      startedAt: at,
      origin: 'delegated',
    }
    const userMessage: Message = {
      messageId: randomUUID(),
      threadId: thread.threadId,
      turnId: turn.turnId,
      role: 'user',
      content: [{ type: 'text', text: asked }],
    }
    const event = ProofEventSchemas['turn.started'].parse({
      type: 'event',
      name: 'turn.started',
      eventId: randomUUID(),
      timestamp: at,
      scope: { type: 'thread', environmentId, sessionId: thread.sessionId, threadId: thread.threadId },
      payload: { turn, userMessage },
    })
    return { turn, userMessage, event }
  }

  /** Hold a delegated turn that was written as the child's active turn. */
  const beginDelegatedTurn = (child: ThreadRecord, start: ReturnType<typeof delegatedTurn>) => {
    child.turns.push(start.turn)
    child.messages.push(start.userMessage)
    child.activeTurn = {
      turn: start.turn,
      userMessage: start.userMessage,
      interruptRequested: false,
      promptStarted: true,
      toolIds: new Map(),
      interactionIds: new Map(),
      pendingInteractions: new Map(),
    }
    touch(child, 'running')
  }

  /** Open a turn in the child for a subagent that started again (`SendMessage` revived it). */
  const openDelegatedTurn = (child: ThreadRecord, asked: string, at: string) => {
    const start = delegatedTurn(child.thread, asked, at)
    try {
      // Written before anything is filed under it, as any turn's start is.
      if (options.appendAtomic) options.appendAtomic([start.event])
      else appendEvent(start.event)
    } catch (error) {
      // The next report tries again; what arrives meanwhile has no turn to go to.
      options.onPersistenceError?.(error, 'turn.started')
      return
    }
    beginDelegatedTurn(child, start)
  }

  /** End the child's delegated turn the way its subagent ended. */
  const settleDelegatedTurn = (child: ThreadRecord, status: SubagentStatus, reason?: string) => {
    const active = child.activeTurn
    if (!active || active.turn.origin !== 'delegated') return
    const timestamp = new Date().toISOString()
    closeOpenReasoning(child, active, timestamp)
    const scope = threadScope(child)
    const { turnId } = active.turn
    const base = { type: 'event', eventId: randomUUID(), timestamp, scope } as const
    appendRuntimeEvent(
      status === 'completed'
        ? ProofEventSchemas['turn.completed'].parse({
            ...base,
            name: 'turn.completed',
            payload: { turnId },
          })
        : status === 'failed'
          ? ProofEventSchemas['turn.failed'].parse({
              ...base,
              name: 'turn.failed',
              payload: {
                turnId,
                reason: 'provider_error',
                message: TURN_FAILURE_MESSAGES.provider_error,
                ...(reason?.trim() ? { detail: preview(reason.trim(), 1000) } : {}),
              },
            })
          : ProofEventSchemas['turn.interrupted'].parse({
              ...base,
              name: 'turn.interrupted',
              payload: { turnId, reason: 'user' },
            }),
    )
    active.turn.state =
      status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted'
    child.activeTurn = undefined
    for (const [key, item] of childRequests) if (item === child) childRequests.delete(key)
    touch(child, status === 'failed' ? 'error' : resting(child))
    refreshParentsWaiting(child)
  }

  /**
   * A child filed before its provider named a session of its own (OpenCode
   * names it once its task runs): from now on it can be loaded and
   * prompted. Host-private and not activity, like any identity's stamp.
   */
  const attachChildSession = (child: ThreadRecord, providerSessionId: string) => {
    if (options.database) {
      try {
        options.database
          .prepare(
            'UPDATE sessions SET provider_session_id = ? WHERE session_id = ? AND provider_session_id IS NULL',
          )
          .run(providerSessionId, child.session.sessionId)
      } catch (error) {
        options.onPersistenceError?.(error, 'session.created')
        return
      }
    }
    child.detached = undefined
    child.runtimeSession = Promise.resolve(providerSessionId)
  }

  /**
   * The records of a child session the rows hold and memory does not. A
   * child with a provider session of its own resumes it on its first prompt,
   * as it did when it was filed; one without is its parent runtime's to fill.
   */
  const restoreChildRecord = (sessionId: string, cwd: string): ThreadRecord | undefined => {
    const existing = sessions.get(sessionId)
    if (existing || !options.database) return existing
    const summary = getSessionSummary(options.database, sessionId)
    if (!summary) return undefined
    const providerSessionId = getProviderSessionId(options.database, sessionId)
    for (const thread of listThreadsForSession(options.database, sessionId)) {
      const record: ThreadRecord = {
        session: {
          sessionId,
          workspaceId: summary.workspaceId,
          title: summary.title,
          ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
        },
        thread,
        providerId: summary.providerId as ProviderId,
        cwd,
        runtimeSession: providerSessionId
          ? Promise.resolve(providerSessionId)
          : detachedSession(),
        ...(providerSessionId ? {} : { detached: true }),
        ...(summary.subagent ? { subagent: summary.subagent } : {}),
        turns: [],
        messages: [],
        commandTurns: new Map(),
        interactions: new Map(),
        queue: readThreadQueue(options.database, thread.threadId),
        titleSource: summary.titleSource,
        status: summary.status,
        updatedAt: Date.parse(summary.updatedAt),
      }
      threads.set(thread.threadId, record)
      if (!sessions.has(sessionId)) sessions.set(sessionId, record)
    }
    return sessions.get(sessionId)
  }

  /**
   * A subagent the rows hold under this runtime's key and memory does not:
   * one reported before a restart, reported again (a revival, or a late
   * update). A record whose child is gone was the user's to delete.
   */
  const recallSubagent = (owner: ThreadRecord, taskId: string): SubagentEntry | undefined => {
    const database = options.database
    if (!database) return undefined
    options.flush?.()
    const stored = findSubagentByTask(database, owner.session.sessionId, taskId)
    if (!stored) return undefined
    // A nested subagent's record is filed on its parent subagent's child.
    if (!threads.has(stored.threadId)) restoreChildRecord(stored.record.parentSessionId, owner.cwd)
    const holder = threads.get(stored.threadId)
    if (!holder) return undefined
    const childSessionId = findSubagentSessionId(database, stored.record.subagentId)
    const child = childSessionId ? restoreChildRecord(childSessionId, owner.cwd) : undefined
    const key = subagentKey(owner, taskId)
    if (!child) forgottenChildren.add(key)
    const entry: SubagentEntry = {
      key,
      taskId,
      owner,
      holder,
      report: reportOf(taskId, stored.record),
      record: stored.record,
      ...(child ? { child } : {}),
    }
    rememberSubagent(entry)
    return entry
  }

  /** The last turn a thread holds, for a subagent reported while none runs. */
  const lastTurnOf = (record: ThreadRecord): string | undefined => {
    const remembered = record.turns.at(-1)?.turnId
    if (remembered || !options.database) return remembered
    options.flush?.()
    const row = options.database
      .prepare('SELECT turn_id FROM turns WHERE thread_id = ? ORDER BY started_at DESC, turn_id DESC LIMIT 1')
      .get(record.thread.threadId) as { turn_id: string } | undefined
    return row?.turn_id
  }

  /**
   * File a subagent the first time its runtime reports it: the record on
   * the thread whose transcript holds the call that started it, and its
   * child session under that thread's session, with the child's first turn,
   * in one write. A nested subagent is filed on its parent subagent's child,
   * so the sidebar tree follows the agent tree.
   */
  const fileSubagent = (
    owner: ThreadRecord,
    update: SubtaskUpdate,
    at: string,
    parentTaskId: string | undefined,
  ): SubagentEntry | undefined => {
    const key = subagentKey(owner, update.taskId)
    const parent =
      parentTaskId === undefined || parentTaskId === update.taskId
        ? undefined
        : (subagentEntries.get(subagentKey(owner, parentTaskId)) ??
          recallSubagent(owner, parentTaskId))
    const holder = parent?.child ?? owner
    const turnId = holder.activeTurn?.turn.turnId ?? lastTurnOf(holder)
    // Nothing in this thread could have started it.
    if (!turnId) return undefined
    const report = mergeReport({ taskId: update.taskId }, update)
    const subagentId = randomUUID()
    const toolCallId = holder.activeTurn
      ? stableId(holder.activeTurn.toolIds, update.toolCallId ?? update.taskId)
      : undefined
    const childSession: Session | undefined = forgottenChildren.has(key)
      ? undefined
      : {
          sessionId: randomUUID(),
          workspaceId: holder.session.workspaceId,
          title: null,
          parentSessionId: holder.session.sessionId,
        }
    const record = subagentRecord(
      report,
      {
        subagentId,
        parentSessionId: holder.session.sessionId,
        turnId,
        ...(toolCallId ? { toolCallId } : {}),
        ...(parent ? { parentSubagentId: parent.record.subagentId } : {}),
        depth: (parent?.record.depth ?? 0) + 1,
        origin: 'native',
        providerId: owner.providerId,
        ...(childSession ? { childSessionId: childSession.sessionId } : {}),
      },
      { startedAt: at, finishedAt: at, updatedAt: at },
      undefined,
    )
    const announced = subagentEvent(holder, record, at)
    const subagentTasks = {
      [subagentId]: { ownerSessionId: owner.session.sessionId, taskId: update.taskId },
    }
    const entry: SubagentEntry = { key, taskId: update.taskId, owner, holder, report, record }
    if (!childSession) {
      try {
        if (options.appendAtomic) options.appendAtomic([announced], { subagentTasks })
        else appendEvent(announced)
      } catch (error) {
        options.onPersistenceError?.(error, 'subagent.updated')
        return undefined
      }
      rememberSubagent(entry)
      return entry
    }
    childSession.title = record.title
    const thread: Thread = { threadId: randomUUID(), sessionId: childSession.sessionId }
    const subagent: SessionSubagent = { subagentId, origin: 'native', promptable: record.promptable }
    const start = isSettledSubagentStatus(record.status)
      ? undefined
      : delegatedTurn(thread, report.prompt?.trim() ? report.prompt : record.title, at)
    try {
      // The row, its thread, the record that names it and its first turn are
      // one write, so neither a card without its child nor a child without
      // its card is ever durable. A provider session the child already has
      // is stored by the same write, as a resumable child's always is.
      persistCreatedThread(childSession, thread, {
        providerId: owner.providerId,
        titleSource: 'provider',
        ...(report.childSessionId ? { identity: report.childSessionId } : {}),
        subagent,
        subagentTasks,
        alongside: [announced, ...(start ? [start.event] : [])],
      })
    } catch (error) {
      // The parent carries on; the subagent is filed on its next report.
      options.onPersistenceError?.(error, 'session.created')
      return undefined
    }
    const child: ThreadRecord = {
      session: childSession,
      thread,
      providerId: owner.providerId,
      titleSource: 'provider',
      cwd: owner.cwd,
      runtimeSession: report.childSessionId
        ? Promise.resolve(report.childSessionId)
        : detachedSession(),
      ...(report.childSessionId ? {} : { detached: true }),
      subagent,
      turns: [],
      messages: [],
      commandTurns: new Map(),
      interactions: new Map(),
      queue: EMPTY_THREAD_QUEUE,
      status: 'idle',
      updatedAt: Date.now(),
    }
    sessions.set(childSession.sessionId, child)
    threads.set(thread.threadId, child)
    entry.child = child
    rememberSubagent(entry)
    if (start) beginDelegatedTurn(child, start)
    return entry
  }

  /**
   * Take in one report of a subagent: file it the first time, then merge
   * what is new, open its child's turn when it starts or is revived, and
   * settle that turn when it ends. `under` is the subagent whose work the
   * report arrived as, for a runtime that names a nested one's parent only
   * that way.
   */
  const applySubtask = (
    owner: ThreadRecord,
    update: SubtaskUpdate,
    at: string,
    under?: string,
  ): SubagentEntry | undefined => {
    if (droppedSubagents.has(subagentKey(owner, update.taskId))) return undefined
    const entry =
      subagentEntries.get(subagentKey(owner, update.taskId)) ??
      recallSubagent(owner, update.taskId)
    if (!entry) {
      const filed = fileSubagent(owner, update, at, update.parentTaskId ?? under)
      // The subagent's card takes its place in the holder's transcript here,
      // so the text and thought it interrupts end: what the agent writes or
      // thinks once it returns starts below the card, as after a tool call.
      const active = filed?.holder.activeTurn
      if (active && filed.record.toolCallId) {
        active.textRunId = undefined
        active.reasoningRunId = undefined
        closeOpenReasoning(filed.holder, active, at)
      }
      return filed
    }
    const before = entry.report
    entry.report = mergeReport(before, update)
    const child = entry.child
    if (update.childSessionId && child?.detached) attachChildSession(child, update.childSessionId)
    const status = subagentStatusOf(entry.report.status) ?? 'running'
    const settled = isSettledSubagentStatus(status)
    // Started again (revived), or its first turn could not be written: a
    // person's turn in a child they can prompt holds it, and the subagent's
    // work waits for its own turn.
    if (child && !settled && !threadBusy(child)) {
      openDelegatedTurn(
        child,
        update.prompt?.trim() ? update.prompt : restate(entry, at).title,
        at,
      )
    }
    if (child && update.title?.trim() && update.title !== before.title) {
      applyTitle(child, preview(update.title.trim(), 500), 'provider')
    }
    announceSubagent(entry, at)
    if (settled && child) settleDelegatedTurn(child, status, entry.report.statusReason)
    return entry
  }

  /**
   * File one event of a subagent's work in its child, projected as the
   * child's own turn is. The child's turn scopes it: work that arrives once
   * the subagent has settled, or while a person's turn holds its child, has
   * no turn to go to.
   */
  const routeSubagentWork = (owner: ThreadRecord, event: RuntimeEvent, taskId: string) => {
    if (!SUBAGENT_WORK.has(event.event)) return
    const entry =
      subagentEntries.get(subagentKey(owner, taskId)) ??
      applySubtask(owner, { taskId }, event.timestamp)
    const child = entry?.child
    const active = child?.activeTurn
    if (!child || !active || active.turn.origin !== 'delegated') return
    projectRuntimeEvent(child, event, active)
  }

  /**
   * A child's request opened or settled: the provider's settlement must find
   * it, its card says what it waits on, and the sessions above it wait with it.
   */
  const childRequestsChanged = (
    child: ThreadRecord,
    providerRequestId: string | undefined,
    open: boolean,
  ) => {
    if (providerRequestId !== undefined) {
      const key = `${child.providerId}\n${providerRequestId}`
      if (open) childRequests.set(key, child)
      else childRequests.delete(key)
    }
    const entry = child.subagent ? subagentsById.get(child.subagent.subagentId) : undefined
    if (entry) announceSubagent(entry)
    refreshParentsWaiting(child)
  }

  /**
   * End what an owner's runtime will no longer report: its process exited,
   * or the turn that ran a subagent in the foreground was stopped or failed.
   */
  const interruptSubagentsOf = (
    owner: ThreadRecord,
    which: (entry: SubagentEntry) => boolean,
    reason: string,
  ) => {
    for (const entry of [...subagentEntries.values()]) {
      if (entry.owner !== owner || isSettledSubagentStatus(entry.record.status)) continue
      // A child of ours runs in a process of its own and ends with its own turns.
      if (entry.record.origin !== 'native') continue
      if (!which(entry)) continue
      applySubtask(
        owner,
        { taskId: entry.taskId, status: 'interrupted', statusReason: reason },
        new Date().toISOString(),
      )
    }
  }

  /**
   * Stop one subagent from its card. A settled one has nothing left to stop;
   * the runtime reports the stop itself, as `subagent.updated`.
   */
  const stopSubagent = <T>(entry: SubagentEntry, requestId: string, stopped: () => T) => {
    if (isSettledSubagentStatus(entry.record.status)) return stopped()
    if (entry.record.origin === 'openmanager') {
      stopSpawned(entry)
      return stopped()
    }
    if (!entry.record.stoppable || !runtime.stopSubtask) {
      return errorResult(requestId, 'capability_missing', 'This subagent cannot be stopped.')
    }
    return runtime.stopSubtask({ ...route(entry.owner), taskId: entry.taskId }).then(stopped, () =>
      errorResult(requestId, 'unavailable', 'The subagent could not be stopped. Try again.'),
    )
  }

  // ------------------------------------------- subagents of ours (spawn_agent)
  //
  // docs/decisions/subagents.md, The spawn tool. A child of ours is an
  // ordinary session on its own provider, filed under the session that
  // started it. Its record follows its own turns: running while one runs,
  // settled as its last one ended. Its answer is the text of its last run.

  /** What a child of ours did in its current run, which its turns alone do not keep. */
  type SpawnedRun = {
    turnId?: string
    text: string
    toolCalls: number
    activity?: string
    /** Someone stopped it: its run ends `cancelled`, not `interrupted`. */
    stopped?: boolean
  }
  const SPAWNED_TEXT_MAX = 200_000
  const spawnedRuns = new Map<string, SpawnedRun>()
  /** Turns the parent agent started in a child (`spawn_agent`, `send_agent`), by command id. */
  const parentAsked = new Set<string>()
  const settleWaiters = new Map<string, Set<() => void>>()
  const spawnedSyncs = new Set<ThreadRecord>()

  /**
   * A child of ours, from memory or, after a restart, from the rows: no
   * runtime reports it again, so nothing else would bring its record back.
   */
  const recallSpawned = (
    parentSessionId: string,
    subagentId: string,
  ): SubagentEntry | undefined => {
    const known = subagentsById.get(subagentId)
    if (known || !options.database) return known
    options.flush?.()
    const stored = findSubagentByTask(options.database, parentSessionId, subagentId)
    if (!stored || stored.record.origin !== 'openmanager') return undefined
    const loaded = (sessionId: string) => {
      if (!sessions.has(sessionId)) loadSession(sessionId)
      return sessions.get(sessionId)
    }
    const owner = loaded(parentSessionId)
    if (!owner) return undefined
    const childSessionId = findSubagentSessionId(options.database, subagentId)
    const child = childSessionId ? loaded(childSessionId) : undefined
    const entry: SubagentEntry = {
      key: subagentKey(owner, subagentId),
      taskId: subagentId,
      owner,
      holder: owner,
      report: reportOf(subagentId, stored.record),
      record: stored.record,
      ...(child ? { child } : {}),
    }
    rememberSubagent(entry)
    return entry
  }

  const spawnedEntry = (child: ThreadRecord): SubagentEntry | undefined =>
    child.subagent?.origin === 'openmanager' && child.session.parentSessionId
      ? recallSpawned(child.session.parentSessionId, child.subagent.subagentId)
      : undefined

  /** Every child of ours a session started, live or stored, oldest first. */
  const spawnedOf = (parentSessionId: string): Subagent[] => {
    const records = new Map<string, Subagent>()
    if (options.database) {
      options.flush?.()
      const rows = options.database
        .prepare('SELECT record_json FROM subagents WHERE owner_session_id = ?')
        .all(parentSessionId) as { record_json: string }[]
      for (const row of rows) {
        const parsed = SubagentSchema.safeParse(JSON.parse(row.record_json))
        if (parsed.success && parsed.data.origin === 'openmanager') {
          records.set(parsed.data.subagentId, parsed.data)
        }
      }
    }
    for (const entry of subagentsById.values()) {
      if (entry.record.origin === 'openmanager' && entry.record.parentSessionId === parentSessionId) {
        records.set(entry.record.subagentId, entry.record)
      }
    }
    return [...records.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  }

  const spawnedResult = (subagentId: string): string | undefined => {
    const child = subagentsById.get(subagentId)?.child
    const text = child ? spawnedRuns.get(child.session.sessionId)?.text.trim() : undefined
    return text || undefined
  }

  /** The children each queued notice names, by parent and queue item, until it runs. */
  const wakeItems = new Map<string, Map<string, Set<string>>>()

  /**
   * The parent read a child's answer itself (`wait_agent`) after a notice
   * naming it was queued: a notice left naming nobody new is taken back, so
   * the parent is not told twice.
   */
  const withdrawWake = (parentSessionId: string, subagentId: string) => {
    const items = wakeItems.get(parentSessionId)
    const parent = sessions.get(parentSessionId)
    if (!items || !parent) return
    for (const [queueItemId, ids] of items) {
      if (!ids.delete(subagentId) || ids.size > 0) continue
      items.delete(queueItemId)
      const waiting = parent.queue.items.find(
        (item) => item.queueItemId === queueItemId && item.delivery === 'queued',
      )
      if (waiting) writeQueue(parent, withoutItem(parent.queue, queueItemId))
    }
  }

  /** Queue the parent the environment's notice, and run it now if nothing holds the parent. */
  const wakeParent = (
    parentSessionId: string,
    text: string,
    subagentIds: readonly string[],
  ): boolean => {
    let parent = sessions.get(parentSessionId)
    if (!parent) {
      const loaded = loadSession(parentSessionId)
      if (loaded && 'refused' in loaded) return false
      parent = sessions.get(parentSessionId)
    }
    if (!parent || parent.detached) return false
    const queueItemId = randomUUID()
    const added = enqueue(
      parent,
      'subagents-finished',
      { text, commandId: queueItemId, origin: 'subagents' },
      'queued',
    )
    if ('type' in added) {
      options.onQueueProblem?.('subagents finished but the parent could not be told', {
        sessionId: parentSessionId,
        reason: added.error.message,
      })
      return false
    }
    let items = wakeItems.get(parentSessionId)
    if (!items) wakeItems.set(parentSessionId, (items = new Map()))
    items.set(queueItemId, new Set(subagentIds))
    drain(parent)
    return true
  }

  const wake = createSubagentWake({
    enqueue: (parentSessionId, text, subagentIds) =>
      wakeParent(parentSessionId, text, subagentIds),
    get: (_parent, subagentId) => subagentsById.get(subagentId)?.record,
    resultOf: (_parent, subagentId) => spawnedResult(subagentId),
  })

  /**
   * Restate a child of ours from its own turns. Called whenever its status is
   * touched and as its tools run; deferred to a microtask so the turn that
   * touched it has finished saying how it ended.
   */
  const syncSpawnedSoon = (child: ThreadRecord) => {
    if (spawnedSyncs.has(child)) return
    spawnedSyncs.add(child)
    queueMicrotask(() => {
      spawnedSyncs.delete(child)
      syncSpawned(child)
    })
  }

  const syncSpawned = (child: ThreadRecord) => {
    const entry = spawnedEntry(child)
    if (!entry) return
    const childId = child.session.sessionId
    let run = spawnedRuns.get(childId) ?? { text: '', toolCalls: 0 }
    const active = child.activeTurn
    if (active && run.turnId !== active.turn.turnId) {
      // A new run. One the parent asked for owes it the answer again; one a
      // person started in the child is theirs, and wakes nobody.
      const asked =
        active.turn.commandId !== undefined && parentAsked.delete(active.turn.commandId)
      run = { turnId: active.turn.turnId, text: '', toolCalls: 0 }
      if (asked) wake.reopen(entry.record.parentSessionId, entry.record.subagentId)
      else wake.markDelivered(entry.record.parentSessionId, entry.record.subagentId)
    }
    spawnedRuns.set(childId, run)
    const last = child.turns.at(-1)
    // Restored after a restart and not run since: its record already says how it ended.
    if (!active && !last) return
    const status: SubtaskUpdate['status'] = active
      ? 'running'
      : !last || last.state === 'running' || last.state === 'waiting'
        ? 'running'
        : last.state === 'completed'
          ? 'completed'
          : last.state === 'failed'
            ? 'failed'
            : run.stopped
              ? 'cancelled'
              : 'interrupted'
    const settled = isSettledSubagentStatus(status)
    entry.report = mergeReport(entry.report, {
      taskId: entry.taskId,
      status,
      toolCallCount: run.toolCalls,
      ...(run.activity ? { currentActivity: run.activity } : {}),
      ...(settled && run.text.trim() ? { resultText: run.text.trim() } : {}),
      ...(settled && last?.failure?.detail ? { statusReason: last.failure.detail } : {}),
      durationMs: Math.max(0, Date.now() - Date.parse(entry.record.startedAt)),
    })
    announceSubagent(entry)
    if (settled) {
      const waiters = settleWaiters.get(entry.record.subagentId)
      settleWaiters.delete(entry.record.subagentId)
      for (const resolve of waiters ?? []) resolve()
    }
    wake.observe(entry.record)
  }

  /** What a child of ours says and does, kept for its card and its answer. */
  const observeSpawnedEvent = (child: ThreadRecord, event: RuntimeEvent) => {
    if (event.subtaskId !== undefined) return
    // The model it runs on, as its provider says: a child asked for none runs
    // on whatever a chat there would, and its card names that.
    const reportedModel =
      event.event === 'session_created' || event.event === 'session_loaded'
        ? event.data.models?.currentModelId
        : event.event === 'current_model_update'
          ? event.data.currentModelId
          : undefined
    if (reportedModel) {
      const entry = spawnedEntry(child)
      if (entry && entry.report.modelId !== reportedModel) {
        entry.report = mergeReport(entry.report, { taskId: entry.taskId, modelId: reportedModel })
        announceSubagent(entry)
      }
      return
    }
    const run = spawnedRuns.get(child.session.sessionId)
    if (!run || !child.activeTurn || run.turnId !== child.activeTurn.turn.turnId) return
    if (event.event === 'agent_message_chunk') {
      const content = event.data.content
      if (content.type === 'text' && run.text.length < SPAWNED_TEXT_MAX) {
        run.text = (run.text + content.text).slice(0, SPAWNED_TEXT_MAX)
      }
      return
    }
    if (event.event === 'tool_call') {
      run.toolCalls += 1
      const title = event.data.title?.trim()
      if (title) run.activity = title
      syncSpawnedSoon(child)
    }
  }

  const stopSpawned = (entry: SubagentEntry) => {
    const child = entry.child
    if (!child?.activeTurn) return
    const run = spawnedRuns.get(child.session.sessionId)
    if (run) run.stopped = true
    // The user or the agent stopped it on purpose: nobody needs telling.
    wake.markDelivered(entry.record.parentSessionId, entry.record.subagentId)
    interruptTurn(child, child.activeTurn)
  }

  /**
   * The parent's call of `spawn_agent` the card takes the place of: the
   * oldest call of it in the running turn that no card has claimed. Calls
   * made in one message all arrive before the first one runs, and run in
   * the order they were made.
   */
  const pendingSpawnCall = (parent: ThreadRecord): string | undefined => {
    const active = parent.activeTurn
    if (!active) return undefined
    const claimed = new Set(
      [...subagentsById.values()]
        .filter((entry) => entry.record.turnId === active.turn.turnId)
        .map((entry) => entry.record.toolCallId),
    )
    return (active.spawnCalls ?? []).find((toolCallId) => !claimed.has(toolCallId))
  }

  const callerOf = (record: ThreadRecord): SpawnCaller => {
    let depth = 0
    let item: ThreadRecord | undefined = record
    while (item?.session.parentSessionId && depth < 16) {
      depth += 1
      item = sessions.get(item.session.parentSessionId)
    }
    return {
      sessionId: record.session.sessionId,
      providerId: record.providerId,
      ...(record.activeTurn ? { turnId: record.activeTurn.turn.turnId } : {}),
      depth,
    }
  }

  const spawnChild = async (args: Parameters<SpawnHost['spawn']>[0]): Promise<Subagent> => {
    const parent = sessions.get(args.parent.sessionId)
    if (!parent) throw new Error('This session is not known to OpenManager any more.')
    if (!Object.hasOwn(providers, args.providerId)) {
      throw new Error(`This environment cannot run ${args.providerId}.`)
    }
    const rejection = providerGate.rejection(args.providerId)
    if (rejection) throw new Error(rejection.message)
    const providerId = args.providerId as ProviderId
    const turnId = parent.activeTurn?.turn.turnId ?? lastTurnOf(parent)
    if (!turnId) throw new Error('This session has no turn to file the subagent in.')
    const at = new Date().toISOString()
    const subagentId = randomUUID()
    const toolCallId = pendingSpawnCall(parent)
    const depth = args.parent.depth + 1
    const report: SubtaskUpdate = {
      taskId: subagentId,
      status: 'running',
      title: args.title,
      prompt: args.prompt,
      ...(args.modelId ? { modelId: args.modelId } : {}),
      background: args.background,
      depth,
      stoppable: true,
      promptable: true,
    }
    const session: Session = {
      sessionId: randomUUID(),
      workspaceId: parent.session.workspaceId,
      title: preview(args.title, 500),
      parentSessionId: parent.session.sessionId,
    }
    const thread: Thread = { threadId: randomUUID(), sessionId: session.sessionId }
    const subagent: SessionSubagent = { subagentId, origin: 'openmanager', promptable: true }
    const record = subagentRecord(
      report,
      {
        subagentId,
        parentSessionId: parent.session.sessionId,
        turnId,
        ...(toolCallId ? { toolCallId } : {}),
        depth,
        origin: 'openmanager',
        providerId,
        childSessionId: session.sessionId,
      },
      { startedAt: at, updatedAt: at },
      undefined,
    )
    // The row, the card and the key it is found by are one write.
    // The parent agent named it on purpose, so the child's own provider (Cursor
    // names sessions from their first prompt) must not rename it.
    persistCreatedThread(session, thread, {
      providerId,
      titleSource: 'generated',
      subagent,
      subagentTasks: {
        [subagentId]: { ownerSessionId: parent.session.sessionId, taskId: subagentId },
      },
      alongside: [subagentEvent(parent, record, at)],
    })
    let child!: ThreadRecord
    const runtimeSession = Promise.resolve()
      .then(() => {
        if (sessions.get(session.sessionId) !== child) throw new Error('The subagent was removed.')
        return runtime.ensureSession(route(child))
      })
      .then((result) => persistRuntimeSession(child, result.sessionId))
    runtimeSession.catch(() => undefined)
    child = {
      session,
      thread,
      providerId,
      titleSource: 'generated',
      cwd: parent.cwd,
      runtimeSession,
      subagent,
      turns: [],
      messages: [],
      commandTurns: new Map(),
      interactions: new Map(),
      queue: EMPTY_THREAD_QUEUE,
      status: 'idle',
      updatedAt: Date.now(),
    }
    sessions.set(session.sessionId, child)
    threads.set(thread.threadId, child)
    const entry: SubagentEntry = {
      key: subagentKey(parent, subagentId),
      taskId: subagentId,
      owner: parent,
      holder: parent,
      report,
      record,
      child,
    }
    rememberSubagent(entry)
    if (args.modelId) {
      try {
        options.seedSessionComposer?.(session.sessionId, { modelId: args.modelId })
      } catch (error) {
        options.onPersistenceError?.(error, 'session.composer.updated')
      }
    }
    const commandId = randomUUID()
    parentAsked.add(commandId)
    const started = startTurn(
      child,
      'spawn_agent',
      { sessionId: session.sessionId, threadId: thread.threadId, text: args.prompt },
      commandId,
      { origin: 'delegated', ...(args.modelId ? { settings: { modelId: args.modelId } } : {}) },
    )
    if (started.type === 'error') {
      parentAsked.delete(commandId)
      entry.report = mergeReport(entry.report, {
        taskId: subagentId,
        status: 'failed',
        statusReason: started.error.message,
      })
      announceSubagent(entry)
      throw new Error(started.error.message)
    }
    return entry.record
  }

  const ownSpawned = (parentSessionId: string, subagentId: string) => {
    const entry = recallSpawned(parentSessionId, subagentId)
    return entry?.record.origin === 'openmanager' &&
      entry.record.parentSessionId === parentSessionId
      ? entry
      : undefined
  }

  const spawnHost: SpawnHost = {
    callerOf: (threadId) => {
      const record = threads.get(threadId)
      return record ? callerOf(record) : undefined
    },
    providers: () => options.spawnProviders?.() ?? [],
    spawn: spawnChild,
    list: spawnedOf,
    get: (parentSessionId, subagentId) => ownSpawned(parentSessionId, subagentId)?.record,
    waitSettled: (parentSessionId, subagentId, timeoutMs) => {
      const entry = ownSpawned(parentSessionId, subagentId)
      if (!entry) return Promise.reject(new Error('No such subagent.'))
      if (isSettledSubagentStatus(entry.record.status)) return Promise.resolve(entry.record)
      return new Promise<Subagent>((resolve) => {
        let waiters = settleWaiters.get(subagentId)
        if (!waiters) settleWaiters.set(subagentId, (waiters = new Set()))
        const done = () => {
          clearTimeout(timer)
          waiters!.delete(done)
          resolve(entry.record)
        }
        const timer = setTimeout(done, timeoutMs)
        waiters.add(done)
      })
    },
    resultOf: (parentSessionId, subagentId) =>
      ownSpawned(parentSessionId, subagentId) ? spawnedResult(subagentId) : undefined,
    markDelivered: (parentSessionId, subagentId) => {
      wake.markDelivered(parentSessionId, subagentId)
      withdrawWake(parentSessionId, subagentId)
    },
    send: async (parentSessionId, subagentId, message) => {
      const child = ownSpawned(parentSessionId, subagentId)?.child
      if (!child) throw new Error('Its session was deleted.')
      const commandId = randomUUID()
      parentAsked.add(commandId)
      if (!threadBusy(child) && child.queue.items.length === 0) {
        const started = startTurn(
          child,
          'send_agent',
          { sessionId: child.session.sessionId, threadId: child.thread.threadId, text: message },
          commandId,
          { origin: 'delegated' },
        )
        if (started.type !== 'error') return 'started'
      }
      const added = enqueue(
        child,
        'send_agent',
        { text: message, commandId, origin: 'delegated' },
        'queued',
      )
      if ('type' in added) {
        parentAsked.delete(commandId)
        throw new Error(added.error.message)
      }
      drain(child)
      return 'queued'
    },
    stop: async (parentSessionId, subagentId) => {
      const entry = ownSpawned(parentSessionId, subagentId)
      if (entry) stopSpawned(entry)
    },
  }

  /**
   * Remember a child the user is deleting, so a later report of its
   * subagent does not file it again. Read before the row goes.
   */
  const forgetChild = (sessionId: string) => {
    for (const entry of subagentEntries.values()) {
      if (entry.child?.session.sessionId !== sessionId) continue
      forgottenChildren.add(entry.key)
      return
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
    ...(record.pinnedAt === undefined ? {} : { pinnedAt: new Date(record.pinnedAt).toISOString() }),
    ...(record.cookingAt === undefined
      ? {}
      : { cookingAt: new Date(record.cookingAt).toISOString() }),
    doneAt: record.doneAt === undefined ? null : new Date(record.doneAt).toISOString(),
    ...(record.backgroundTasks?.length ? { backgroundTasks: record.backgroundTasks } : {}),
    ...(record.subagent ? { subagent: record.subagent } : {}),
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
    // A thread's own map holds only what this process served. A thread loaded
    // after a restart starts with it empty, and a retry that crosses the
    // restart must still find its turn, so a miss goes to the log.
    const replayed = !input.commandId
      ? undefined
      : (record?.commandTurns.get(input.commandId) ??
        findPersistedTurn(input.sessionId, input.threadId, input.commandId))
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
    if (record.detached) return errorResult(command.requestId, 'capability_missing', ONLY_ITS_AGENT)
    const providerRejection = rejectProvider(command.requestId, record.providerId)
    if (providerRejection) return providerRejection
    return startTurn(record, command.requestId, input, commandId, { modeId })
  }

  /** Whether something holds the thread: a turn, a stop or a plan build under way. */
  const threadBusy = (record: ThreadRecord) =>
    !!(record.activeTurn || record.cancellation || record.pendingBuild)

  /**
   * The images a message names, as the turn shows them and as the provider
   * reads them. Each must be an artifact of this session in its workspace.
   */
  const readAttachments = (
    record: ThreadRecord,
    requestId: string,
    artifactIds: readonly string[] | undefined,
    withBytes: boolean,
  ):
    | {
        content: Message['content']
        images: { type: 'image'; mimeType: string; data: string }[]
      }
    | ReturnType<typeof errorResult> => {
    const content: Message['content'] = []
    const images: { type: 'image'; mimeType: string; data: string }[] = []
    try {
      for (const artifactId of new Set(artifactIds ?? [])) {
        const metadata = options.artifacts?.get(record.session.sessionId, artifactId)
        if (!metadata || metadata.workspaceId !== record.session.workspaceId) {
          return errorResult(requestId, 'not_found', 'Artifact not found in this session.')
        }
        content.push(options.artifacts!.reference(metadata))
        if (withBytes) {
          images.push({
            type: 'image',
            mimeType: metadata.mimeType,
            data: options.artifacts!.read(metadata).toString('base64'),
          })
        }
      }
    } catch {
      return errorResult(requestId, 'unavailable', 'An attachment could not be read.')
    }
    return { content, images }
  }

  /**
   * Start a turn on a thread nothing holds: record it, then hand the prompt
   * to the provider. `queueAfter` is what the chat's queue becomes when the
   * turn is a queued message's: the two are written in one transaction, so
   * the message is either still waiting or running, never both or neither.
   */
  const startTurn = (
    record: ThreadRecord,
    requestId: string,
    input: { sessionId: string; threadId: string; text: string; artifactIds?: string[] },
    commandId: string,
    opts: {
      modeId?: string
      settings?: QueuedMessageSettings
      queueAfter?: ThreadQueue
      /** A turn no person sent here: a parent agent's (`delegated`), or the environment's (`subagents`). */
      origin?: 'delegated' | 'subagents'
    } = {},
  ) => {
    const opened = openTurn(record, requestId, input, { commandId }, opts)
    return 'turn' in opened ? turnSendResult(requestId, opened as TurnStart) : opened
  }

  /**
   * Open a turn and hand its prompt to the provider, then end it with the
   * provider's answer. The prompt is a message someone sent (`commandId`,
   * recorded as the turn's user message), or the environment's own on a turn
   * nobody sent (`background`): that one is never shown, and the turn is a
   * `background` one. The first turn opened after a move (`movedTo`) opens
   * with its marker, written with its start, and a sent prompt reaches the
   * provider after a line saying where the session is now. Answers the turn
   * as announced, or why it could not start.
   */
  const openTurn = (
    record: ThreadRecord,
    requestId: string,
    input: { sessionId: string; threadId: string; text: string; artifactIds?: string[] },
    from: { commandId: string } | { background: true },
    opts: {
      modeId?: string
      settings?: QueuedMessageSettings
      queueAfter?: ThreadQueue
      /** A turn no person sent here: a parent agent's (`delegated`), or the environment's (`subagents`). */
      origin?: 'delegated' | 'subagents'
    } = {},
  ): TurnStarted | ReturnType<typeof errorResult> => {
    const { modeId } = opts
    const commandId = 'commandId' in from ? from.commandId : undefined
    if (threadBusy(record)) {
      return errorResult(requestId, 'conflict', 'A turn is already in progress.')
    }
    // The provider may start a steered message it still holds as its next
    // turn; a prompt started now could be credited with it.
    if (record.queue.items.some((item) => item.delivery === 'steering')) {
      return errorResult(requestId, 'conflict', 'A message is still with the agent.')
    }
    // The rows may hold a turn no process runs: one whose recovery failed at
    // boot. A second turn beside it would leave the thread with two open.
    if (options.database) {
      options.flush?.()
      if (findOpenTurnId(options.database, input)) {
        return errorResult(requestId, 'conflict', 'A turn is already in progress.')
      }
    }
    const attachments = readAttachments(record, requestId, input.artifactIds, true)
    if ('type' in attachments) return attachments
    const artifactContent = attachments.content
    let promptImages = attachments.images
    const startedAt = new Date().toISOString()
    const turn: Turn = {
      turnId: randomUUID(),
      threadId: record.thread.threadId,
      state: 'running',
      startedAt,
      ...(commandId ? { commandId } : {}),
      ...(opts.origin
        ? { origin: opts.origin }
        : commandId
          ? {}
          : { origin: 'background' as const }),
    }
    const userMessage: Message | undefined = commandId
      ? {
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
      : undefined
    const started: TurnStarted = userMessage ? { turn, userMessage, commandId } : { turn }
    // Without a database the provider's `prompt_started` announces a sent
    // turn; the queue still says the message left it. One nobody sent is
    // always announced here: its `prompt_started` would show the
    // environment's prompt as the user's.
    const events: ProofEvent[] = []
    if (options.database || !userMessage) {
      events.push(
        ProofEventSchemas['turn.started'].parse({
          type: 'event',
          name: 'turn.started',
          eventId: randomUUID(),
          timestamp: startedAt,
          scope: threadScope(record),
          payload: started,
        }),
      )
    }
    // Only with the turn's own start, so the marker comes before anything in it.
    const movedTo = events.length > 0 ? record.movedTo : undefined
    if (movedTo) {
      const notice: DurableTurnNotice = {
        noticeId: randomUUID(),
        turnId: turn.turnId,
        kind: 'info',
        message: `Moved to ${movedTo.name} (${movedTo.path}) and resumed there`,
        move: movedTo,
      }
      events.push(
        ProofEventSchemas['turn.notice.recorded'].parse({
          type: 'event',
          name: 'turn.notice.recorded',
          eventId: randomUUID(),
          timestamp: startedAt,
          scope: threadScope(record),
          payload: notice,
        }),
      )
    }
    // The environment's own prompt already says where the session is.
    const promptText =
      movedTo && userMessage
        ? `${movedNote(movedTo.name, movedTo.path)}\n\n${input.text}`
        : input.text
    if (opts.queueAfter) events.push(queueEvent(record, opts.queueAfter))
    if (events.length > 0) {
      try {
        // A failed host command must not leave a start in the streaming
        // buffer that a later retry could flush as an orphaned turn.
        if (options.appendAtomic) options.appendAtomic(events)
        else for (const item of events) appendEvent(item)
      } catch (error) {
        options.onPersistenceError?.(error, 'turn.started')
        return errorResult(requestId, 'unavailable', 'The message could not be saved. Try again.')
      }
      if (opts.queueAfter) record.queue = opts.queueAfter
      if (movedTo) record.movedTo = undefined
    }
    record.turns.push(turn)
    if (userMessage && commandId) {
      record.messages.push(userMessage)
      record.commandTurns.set(commandId, started as TurnStart)
    }
    // The environment's notice is not what the chat is about.
    if (userMessage && commandId && opts.origin !== 'subagents') {
      const title = titleFromPrompt(input.text)
      if (title) applyTitle(record, title, 'fallback')
      titleFromFirstPrompt(record, userMessage)
    }
    const active: ActiveTurn = {
      turn,
      ...(userMessage ? { userMessage } : { promptId: randomUUID() }),
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
        const desiredConfig = {
          ...(opts.settings?.modelId ? { modelId: opts.settings.modelId } : {}),
          ...(opts.settings?.configValues ? { values: opts.settings.configValues } : {}),
          ...(modeId ? { modeId } : {}),
        }
        return runtime.prompt({
          ...route(record, sessionId),
          ...(Object.keys(desiredConfig).length > 0 ? { desiredConfig } : {}),
          prompt: {
            text: promptText,
            blocks: [
              ...(promptText ? [{ type: 'text' as const, text: promptText }] : []),
              ...promptImages,
            ],
          },
          userMessageId: userMessage?.messageId ?? active.promptId,
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
    return started
  }

  // ---------------------------------------------------------------- queue

  const queueEvent = (record: ThreadRecord, queue: ThreadQueue) =>
    ProofEventSchemas['thread.queue.updated'].parse({
      type: 'event',
      name: 'thread.queue.updated',
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      scope: threadScope(record),
      payload: queue,
    })

  /**
   * Commit a new queue, with any events it belongs with, in one write. Memory
   * follows only a committed write, so what the queue says in memory is what
   * every client was told. Answers whether it committed.
   */
  const writeQueue = (
    record: ThreadRecord,
    queue: ThreadQueue,
    alongside: readonly ProofEvent[] = [],
  ): boolean => {
    const events = [...alongside, queueEvent(record, queue)]
    try {
      if (options.appendAtomic) options.appendAtomic(events)
      else for (const event of events) appendEvent(event)
    } catch (error) {
      options.onPersistenceError?.(error, 'thread.queue.updated')
      return false
    }
    record.queue = queue
    return true
  }

  const withoutItem = (queue: ThreadQueue, queueItemId: string): ThreadQueue => ({
    items: queue.items.filter((item) => item.queueItemId !== queueItemId),
    pausedBy: queue.pausedBy,
  })

  /** Whether a message id was already queued here or already ran as a turn. */
  const knownQueueItem = (record: ThreadRecord, commandId: string) =>
    record.queue.items.some((item) => item.queueItemId === commandId) ||
    record.commandTurns.has(commandId) ||
    // A delivered steer is a user message carrying the message's id.
    record.messages.some((message) => message.messageId === commandId) ||
    findPersistedTurn(record.session.sessionId, record.thread.threadId, commandId) !== undefined ||
    (options.database !== undefined &&
      options.database.prepare('SELECT 1 FROM messages WHERE message_id = ?').get(commandId) !==
        undefined)

  /**
   * Run the next queued message, when nothing holds the thread and nothing
   * holds the queue back: not a pause, and not a message the provider still
   * has (its fate decides what runs next). The message leaves the queue in
   * the same write that starts its turn. One that cannot start stays first in
   * line and pauses the queue, so the next one does not jump it.
   */
  /**
   * The session and every sub-agent session under it: a child always shares
   * its parent's workspace, so a move takes the whole tree. Read from the rows
   * when there are any (a child need not be loaded), else from memory.
   */
  const sessionTree = (sessionId: string): string[] => {
    if (options.database) {
      options.flush?.()
      return (
        options.database
          .prepare(
            `WITH RECURSIVE tree(session_id) AS (
               SELECT ? UNION SELECT s.session_id FROM sessions s
                 JOIN tree t ON s.parent_session_id = t.session_id)
             SELECT session_id FROM tree`,
          )
          .all(sessionId) as { session_id: string }[]
      ).map((row) => row.session_id)
    }
    const tree = new Set([sessionId])
    for (let grew = true; grew; ) {
      grew = false
      for (const item of threads.values()) {
        const parent = item.session.parentSessionId
        if (parent && tree.has(parent) && !tree.has(item.session.sessionId)) {
          tree.add(item.session.sessionId)
          grew = true
        }
      }
    }
    return [...tree]
  }

  /**
   * Why the session whose agent is working in `threadId` now cannot move, if
   * it cannot: asked before the folder is added as a project, so a refused
   * move adds nothing.
   */
  const moveRefusal = (threadId: string): string | undefined => {
    const record = threads.get(threadId)
    if (!record?.activeTurn) return 'This session has no turn under way to move from.'
    if (record.session.parentSessionId) {
      return 'A sub-agent cannot move its session; the agent that started it can.'
    }
    if (!(options.movableProviders ?? MOVABLE_PROVIDERS).includes(record.providerId)) {
      return `Moving a session to another folder is not supported for ${record.providerId} yet.`
    }
    return undefined
  }

  /**
   * File a move to another workspace for the session whose agent is working
   * in `threadId` now. Applied when that turn completes (`settleMove`); a
   * second call in the same turn replaces the first.
   */
  const requestMove = (threadId: string, workspaceId: string, name?: string): MoveRequest => {
    const refusal = moveRefusal(threadId)
    if (refusal) return { ok: false, message: refusal }
    const record = threads.get(threadId)!
    let target: WorkspaceRuntimeRoute | undefined
    try {
      target = resolveWorkspace(workspaceId)
    } catch {
      /* unavailable */
    }
    if (!target) return { ok: false, message: 'That folder cannot be opened on this environment.' }
    // "No project" gives each session a folder of its own under the
    // environment's data directory; nothing moves into it.
    if (target.sessionCwd) {
      return { ok: false, message: 'A session cannot move into "No project"; name a project folder.' }
    }
    if (workspaceId === record.session.workspaceId) {
      pendingMoves.delete(record.session.sessionId)
      return { ok: false, message: `This session already works in ${target.cwd}.` }
    }
    pendingMoves.set(record.session.sessionId, {
      workspaceId,
      ...(name ? { name } : {}),
      threadId,
      turnId: record.activeTurn!.turn.turnId,
    })
    return {
      ok: true,
      workspaceId,
      cwd: target.cwd,
      backgroundTasks: record.backgroundTasks?.length ?? 0,
    }
  }

  /**
   * A turn ended: apply the move it asked for once it completed, and resume
   * the session in its new folder (`applyMove`). A turn that failed or was
   * stopped drops it, and nothing resumes; the agent asks again if it still
   * wants it. A turn that already took over (a steered message's own) carries
   * the move to its own end; steered messages the provider still holds make
   * the move wait on what becomes of them (`steerResolved`).
   */
  const settleMove = (record: ThreadRecord, turnId: string, completed: boolean) => {
    const sessionId = record.session.sessionId
    const move = pendingMoves.get(sessionId)
    if (!move || move.threadId !== record.thread.threadId) return
    // Only what becomes of the steers it waits on decides it, never another turn.
    if (move.steerIds || move.turnId !== turnId) return
    if (completed && record.activeTurn) {
      move.turnId = record.activeTurn.turn.turnId
      return
    }
    const held = record.queue.items.filter((item) => item.delivery === 'steering')
    if (completed && held.length > 0) {
      move.turnId = undefined
      move.steerIds = new Set(held.map((item) => item.queueItemId))
      return
    }
    pendingMoves.delete(sessionId)
    if (completed) applyMove(record, move)
  }

  /**
   * A steered message a waiting move counts on (`steerIds`) is no longer held
   * by the provider. Run as a turn, or folded into one, it carries the move
   * to that turn's end. Given back, it runs again from the queue, and the
   * move applies now, as the asking turn's completion would have, so the
   * message runs in the new folder after the resume. Shown nowhere (it
   * reached the agent after its turn ended), it took nothing over: once no
   * other held steer can, the move is dropped rather than left to apply
   * whenever a later turn completes.
   */
  const steerResolved = (
    record: ThreadRecord,
    steerId: string,
    outcome: { turnId: string } | 'returned' | 'dropped',
  ) => {
    const sessionId = record.session.sessionId
    const move = pendingMoves.get(sessionId)
    if (move?.threadId !== record.thread.threadId || !move.steerIds?.delete(steerId)) return
    if (typeof outcome === 'object') {
      move.steerIds = undefined
      move.turnId = outcome.turnId
      return
    }
    if (outcome === 'returned') move.givenBack = true
    if (move.steerIds.size > 0) return
    move.steerIds = undefined
    if (move.givenBack && record.activeTurn) {
      move.turnId = record.activeTurn.turn.turnId
      return
    }
    pendingMoves.delete(sessionId)
    if (move.givenBack) {
      applyMove(record, move)
      return
    }
    options.onMoveProblem?.('a move was dropped: the steered message after it never ran', {
      sessionId,
      workspaceId: move.workspaceId,
    })
  }

  /**
   * Move the session, and every sub-agent session under it, to the workspace
   * its agent asked for, then resume it there (`resumeMoved`). A plan build
   * the user approved meanwhile holds the thread: it runs first, in the new
   * folder, and carries the move's marker instead (`movedTo`).
   */
  const applyMove = (record: ThreadRecord, move: PendingMove) => {
    const sessionId = record.session.sessionId
    if (threads.get(record.thread.threadId) !== record) return
    let target: WorkspaceRuntimeRoute | undefined
    try {
      target = resolveWorkspace(move.workspaceId)
    } catch {
      /* unavailable */
    }
    if (!target || target.sessionCwd) {
      options.onMoveProblem?.('a session could not move: its new folder is unavailable', {
        sessionId,
        workspaceId: move.workspaceId,
      })
      return
    }
    // What the session runs with now becomes its own choice, so the new
    // project's preferences do not change its model halfway through.
    try {
      const current = options.queuedSettings?.({
        providerId: record.providerId,
        workspaceId: record.session.workspaceId,
        threadId: record.thread.threadId,
      })
      if (current?.modelId || current?.configValues) {
        options.seedSessionComposer?.(sessionId, {
          ...(current.modelId ? { modelId: current.modelId } : {}),
          ...(current.configValues ? { configValues: current.configValues } : {}),
        })
      }
    } catch {
      /* the move matters more than keeping the model */
    }
    try {
      const tree = sessionTree(sessionId)
      const timestamp = new Date().toISOString()
      const events = tree.map((id) =>
        ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: randomUUID(),
          timestamp,
          scope: { type: 'environment', environmentId },
          payload: { sessionId: id, workspaceId: move.workspaceId },
        }),
      )
      if (options.appendAtomic) options.appendAtomic(events)
      else events.forEach(appendEvent)
      // Memory follows the committed rows: every thread of the tree runs in
      // the new folder from its next prompt, which supersedes its process.
      const moved = new Set(tree)
      for (const item of threads.values()) {
        if (!moved.has(item.session.sessionId)) continue
        item.session.workspaceId = move.workspaceId
        item.cwd = target.cwd
        item.moved = true
      }
    } catch (error) {
      options.onPersistenceError?.(error, 'session.updated')
      return
    }
    try {
      target.onSessionStarted?.()
    } catch {
      /* bookkeeping only */
    }
    record.movedTo = {
      workspaceId: move.workspaceId,
      name: move.name ?? (basename(target.cwd) || target.cwd),
      path: target.cwd,
    }
    // The build was approved before the move applied: it is the agent's next
    // turn either way, and a resume ahead of it would hold the thread when
    // the build starts. It opens in the new folder with the marker.
    if (record.pendingBuild) return
    // Before the queue drains (`settleQueue` follows): a message the user
    // queued meanwhile runs after the agent has picked up in the new folder.
    resumeMoved(record, record.movedTo)
  }

  /**
   * Start the turn that resumes a moved session in its new folder, the moment
   * the move applies. Nobody sent it: the provider reads a short prompt saying
   * where it is now, and the transcript shows the move's marker in its place,
   * written with the turn's start (`openTurn`). The move stands even when the
   * turn cannot start; the host hears why, and the next turn carries the marker.
   */
  const resumeMoved = (
    record: ThreadRecord,
    move: { workspaceId: string; name: string; path: string },
  ) => {
    const opened = openTurn(
      record,
      'move-resume',
      {
        sessionId: record.session.sessionId,
        threadId: record.thread.threadId,
        text: movedPrompt(move.name, move.path),
      },
      { background: true },
    )
    if ('turn' in opened) return
    options.onMoveProblem?.('a moved session could not resume in its new folder', {
      sessionId: record.session.sessionId,
      workspaceId: move.workspaceId,
      reason: opened.error.message,
    })
  }

  const drain = (record: ThreadRecord) => {
    if (threads.get(record.thread.threadId) !== record) return
    const queue = record.queue
    if (queue.pausedBy || threadBusy(record)) return
    if (queue.items.some((item) => item.delivery === 'steering')) return
    const next = queue.items[0]
    if (!next) return
    const result = startTurn(
      record,
      'queue-drain',
      {
        sessionId: record.session.sessionId,
        threadId: record.thread.threadId,
        text: next.text,
        ...(next.artifactIds ? { artifactIds: next.artifactIds } : {}),
      },
      next.queueItemId,
      {
        settings: next.settings,
        queueAfter: withoutItem(queue, next.queueItemId),
        ...(next.origin ? { origin: next.origin } : {}),
      },
    )
    if (result.type !== 'error') return
    options.onQueueProblem?.('a queued message could not start', {
      sessionId: record.session.sessionId,
      queueItemId: next.queueItemId,
      reason: result.error.message,
    })
    // `threadBusy` was checked above, so a conflict here is a turn the rows
    // hold open with nothing running it: waiting would wait forever.
    writeQueue(record, { items: record.queue.items, pausedBy: 'failure' })
  }

  /**
   * What a turn's end does to the queue. A completed or stopped turn lets the
   * next message run: Stop ends this turn, not the plan the user queued
   * behind it. A failed or restart-cut turn pauses a queue that has anything
   * in it. A message the provider holds for steering stays `steering`: only
   * the provider can say it gave it back (`steer_withdrawn`, which its exit
   * also sends), and guessing would let a resume send it a second time; once
   * given back it runs first.
   */
  const settleQueue = (
    record: ThreadRecord,
    ended: 'turn.completed' | 'turn.interrupted' | 'turn.failed',
    restarted: boolean,
  ) => {
    if (threads.get(record.thread.threadId) !== record) return
    // A turn already followed it: a steered message's own, which takes the
    // queue from here.
    if (record.activeTurn) return
    const queue = record.queue
    if (queue.items.length === 0) return
    if (ended === 'turn.completed' || (ended === 'turn.interrupted' && !restarted)) {
      drain(record)
      return
    }
    const pausedBy: ThreadQueuePause = restarted ? 'restart' : 'failure'
    if (queue.pausedBy === pausedBy) return
    writeQueue(record, { items: queue.items, pausedBy })
  }

  /** The prompt the provider reads for a message: its text and its images. */
  const promptOf = (text: string, images: { type: 'image'; mimeType: string; data: string }[]) => ({
    text,
    blocks: [...(text ? [{ type: 'text' as const, text }] : []), ...images],
  })

  /**
   * Hand a `steering` message to the provider. Anything that stops it
   * reaching the turn puts it back in line as `queued`, and a thread with
   * nothing running lets it run as the next turn.
   */
  const steerToProvider = (
    record: ThreadRecord,
    item: QueuedMessage,
    images: { type: 'image'; mimeType: string; data: string }[],
  ) => {
    const steer = runtime.steer
    const giveBack = (reason: unknown) => {
      options.onQueueProblem?.('a steered message went back to the queue', {
        sessionId: record.session.sessionId,
        queueItemId: item.queueItemId,
        reason: reason instanceof Error ? reason.message : String(reason),
      })
      returnSteer(record, item.queueItemId)
    }
    if (!steer) {
      giveBack('this environment cannot steer')
      return
    }
    void record.runtimeSession
      .then((sessionId) =>
        steer.call(runtime, {
          ...route(record, sessionId),
          sessionId,
          prompt: promptOf(item.text, images),
          steerId: item.queueItemId,
        }),
      )
      .catch(giveBack)
  }

  /**
   * A steered message is back in line: the provider never took it. It was
   * meant for the running turn, so it runs before anything that was only
   * queued, behind the steers given back before it.
   */
  const returnSteer = (record: ThreadRecord, queueItemId: string) => {
    if (threads.get(record.thread.threadId) !== record) return
    const item = record.queue.items.find((entry) => entry.queueItemId === queueItemId)
    if (!item || item.delivery !== 'steering') return
    const ahead = new Set(
      [...(record.givenBackSteers ?? [])].filter((id) =>
        record.queue.items.some((entry) => entry.queueItemId === id),
      ),
    )
    const committed = writeQueue(record, {
      items: givenBackFirst(record.queue.items, ahead, (entry) => entry === item),
      pausedBy: record.queue.pausedBy,
    })
    if (!committed) return
    record.givenBackSteers = ahead.add(queueItemId)
    // A move its turn asked for applies first, so it runs in the new folder.
    steerResolved(record, queueItemId, 'returned')
    // The turn it was for may have ended while the provider still held it.
    queueMicrotask(() => drain(record))
  }

  /** The user message a queued one becomes, inside `turnId`. */
  const messageOf = (record: ThreadRecord, item: QueuedMessage, turnId: string): Message => {
    const read = readAttachments(record, 'steer', item.artifactIds, false)
    // The agent read the message either way; images whose files went
    // missing since leave the words on the record rather than nothing.
    const attachments = 'type' in read ? { content: [] } : read
    return {
      // The message's own id, so a retried send of it finds it here.
      messageId: item.queueItemId,
      threadId: record.thread.threadId,
      turnId,
      role: 'user',
      content: [
        ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
        ...attachments.content,
      ],
    }
  }

  /**
   * The provider took a steered message into the running turn. It becomes a
   * user message of that turn, placed where the agent read it, and leaves the
   * queue in the same write.
   */
  const deliverSteer = (record: ThreadRecord, steerId: string, timestamp: string) => {
    const item = record.queue.items.find((entry) => entry.queueItemId === steerId)
    if (!item) return
    const active = record.activeTurn
    steerResolved(record, steerId, active ? { turnId: active.turn.turnId } : 'dropped')
    const message = active ? messageOf(record, item, active.turn.turnId) : undefined
    if (!active || !message) {
      // The agent has it, but there is no running turn to show it in (the
      // turn was ended here first). Running it again would send it twice.
      options.onQueueProblem?.('a steered message arrived after its turn ended', {
        sessionId: record.session.sessionId,
        queueItemId: steerId,
      })
      writeQueue(record, withoutItem(record.queue, steerId))
      return
    }
    const deltas = message.content.map((content) =>
      ProofEventSchemas['message.delta'].parse({
        type: 'event',
        name: 'message.delta',
        eventId: randomUUID(),
        timestamp,
        scope: threadScope(record),
        payload: {
          messageId: message.messageId,
          turnId: active.turn.turnId,
          role: 'user',
          content,
        },
      }),
    )
    if (!writeQueue(record, withoutItem(record.queue, steerId), deltas)) return
    record.messages.push(message)
    // What the agent says next answers the steered message: a new run.
    active.textRunId = undefined
    active.reasoningRunId = undefined
  }

  /**
   * The turn a steered message was sent into ended before the provider took
   * it, and the provider began a turn of its own for it. That turn is the
   * message's, as if it had waited in the queue: it is recorded with the
   * message as its prompt, and the message leaves the queue in the same write.
   */
  const startSteeredTurn = (record: ThreadRecord, event: RuntimeEvent, steerId: string) => {
    const item = record.queue.items.find((entry) => entry.queueItemId === steerId)
    if (record.activeTurn) {
      // Only reachable if the provider folded it after all; file it there.
      deliverSteer(record, steerId, event.timestamp)
      return
    }
    const turn: Turn = {
      turnId: randomUUID(),
      threadId: record.thread.threadId,
      state: 'running',
      startedAt: event.timestamp,
      ...(item ? { commandId: item.queueItemId } : {}),
    }
    const userMessage = item
      ? { ...messageOf(record, item, turn.turnId), messageId: randomUUID() }
      : undefined
    if (!item || !userMessage) {
      // A message this queue no longer has: the turn is still the provider's
      // to run, and its output needs somewhere to go.
      startBackgroundTurn(record, event)
      return
    }
    const started: TurnStart = { turn, userMessage, commandId: item.queueItemId }
    const startEvent = ProofEventSchemas['turn.started'].parse({
      type: 'event',
      name: 'turn.started',
      eventId: randomUUID(),
      timestamp: event.timestamp,
      scope: threadScope(record),
      payload: started,
    })
    if (!writeQueue(record, withoutItem(record.queue, steerId), [startEvent])) {
      // Unrecorded, the provider's output for it would fail every write.
      // Filed under a background turn instead, the next frame tries again.
      record.unrecordedBackgroundTurn = event
      return
    }
    record.turns.push(turn)
    record.messages.push(userMessage)
    record.commandTurns.set(item.queueItemId, started)
    record.activeTurn = {
      turn,
      userMessage,
      interruptRequested: false,
      promptStarted: true,
      runtimeMessageId: event.messageId,
      toolIds: new Map(),
      interactionIds: new Map(),
      pendingInteractions: new Map(),
    }
    touch(record, 'running')
    // It took over from the turn it was sent into, and with it any move that asked for.
    steerResolved(record, steerId, { turnId: turn.turnId })
  }

  /**
   * Stop the running turn, as Stop does: the provider is asked to cancel, and
   * once it has, the turn ends as interrupted and the queue runs on. A turn
   * already being stopped is left to that stop.
   */
  const interruptTurn = (record: ThreadRecord, active: ActiveTurn) => {
    if (active.interruptRequested) return
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
        // The turn's end found the thread still busy with this stop;
        // the next message runs now that it is not.
        drain(record)
      })
  }

  /**
   * Send a steered message without waiting for the agent's step to end. The
   * provider gives it back first: while it holds a steer, it ignores an
   * interrupt. Given back, the message is first in line (`steer_withdrawn`);
   * the turn it was for is then stopped as Stop stops it, and the message
   * runs as the next turn. One the provider has already started is left to
   * arrive as it is: stopping now would stop the message's own turn.
   */
  const sendSteerNow = (record: ThreadRecord, queueItemId: string) => {
    const withdraw = runtime.withdrawSteer
    if (!withdraw) return
    const active = record.activeTurn
    void record.runtimeSession
      .then((sessionId) =>
        withdraw.call(runtime, { ...route(record, sessionId), sessionId, steerId: queueItemId }),
      )
      .then((withdrawn) => {
        if (!withdrawn || threads.get(record.thread.threadId) !== record) return
        // The turn may have ended meanwhile; the message then runs as soon as
        // it is back in line, with nothing left to stop.
        if (active && record.activeTurn === active) interruptTurn(record, active)
      })
      .catch((error: unknown) => {
        options.onQueueProblem?.('a steered message could not be sent early', {
          sessionId: record.session.sessionId,
          queueItemId,
          reason: error instanceof Error ? error.message : String(error),
        })
      })
  }

  /**
   * Resolve the thread a queue command names, as a send does: access first,
   * then the record, loading a chat the rows hold after a restart.
   */
  const queueTarget = (
    requestId: string,
    input: { sessionId: string; threadId: string },
    context: CommandContext | undefined,
  ): ThreadRecord | ReturnType<typeof errorResult> => {
    const recordOf = () => {
      const threadRecord = threads.get(input.threadId)
      return threadRecord?.session.sessionId === input.sessionId ? threadRecord : undefined
    }
    let record = recordOf()
    const workspaceId = record?.session.workspaceId ?? persistedWorkspaceId(input.sessionId)
    if (workspaceId === undefined) return errorResult(requestId, 'not_found', 'Thread not found.')
    if (!resolveWorkspace(workspaceId, context)) {
      return rejectWorkspace(requestId, workspaceId, SEND_WORKSPACE_UNAVAILABLE)
    }
    if (!record) {
      const loaded = loadSession(input.sessionId, context)
      if (loaded && 'refused' in loaded) return refused(requestId, loaded.refused)
      record = recordOf()
    }
    if (record?.detached) return errorResult(requestId, 'capability_missing', ONLY_ITS_AGENT)
    return record ?? errorResult(requestId, 'not_found', 'Thread not found.')
  }

  /**
   * Add a message to the queue, as `queued` or as `steering`. The id is the
   * client's, so a retry of a message already queued or already run answers
   * the same. The selection is captured now: the message runs on what the
   * composer showed when it was sent.
   */
  const enqueue = (
    record: ThreadRecord,
    requestId: string,
    input: {
      text: string
      commandId: string
      artifactIds?: string[]
      origin?: QueuedMessage['origin']
    },
    delivery: QueuedMessage['delivery'],
  ):
    | { item: QueuedMessage; images: { type: 'image'; mimeType: string; data: string }[] }
    | ReturnType<typeof errorResult> => {
    const attachments = readAttachments(
      record,
      requestId,
      input.artifactIds,
      delivery === 'steering',
    )
    if ('type' in attachments) return attachments
    if (record.queue.items.length >= THREAD_QUEUE_MAX) {
      return errorResult(
        requestId,
        'conflict',
        `A chat can hold ${THREAD_QUEUE_MAX} messages back at a time. Wait for one to run, or remove one.`,
      )
    }
    const item: QueuedMessage = {
      queueItemId: input.commandId,
      text: input.text,
      ...(input.artifactIds?.length ? { artifactIds: [...new Set(input.artifactIds)] } : {}),
      settings:
        options.queuedSettings?.({
          providerId: record.providerId,
          workspaceId: record.session.workspaceId,
          threadId: record.thread.threadId,
        }) ?? {},
      delivery,
      createdAt: new Date().toISOString(),
      ...(input.origin ? { origin: input.origin } : {}),
    }
    if (
      !writeQueue(record, { items: [...record.queue.items, item], pausedBy: record.queue.pausedBy })
    ) {
      return errorResult(requestId, 'unavailable', 'The message could not be saved. Try again.')
    }
    return { item, images: attachments.images }
  }

  const service = {
    /** What `spawn_agent` and its sibling tools act through. */
    spawnHost,
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
        notices: [],
        order: [],
        interactions: [...record.interactions.values()]
          .filter((entry) => !entry.settled && record.activeTurn?.turn.turnId === entry.turnId)
          .map((entry) => ({ turnId: entry.turnId, interaction: entry.interaction })),
        listing: {},
        queue: record.queue,
        subagents: [...subagentEntries.values()]
          .filter((entry) => entry.holder === record)
          .map((entry) => entry.record),
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
     * Pause every queue that still holds messages after a restart, and take
     * back what the provider held for steering: that provider process is
     * gone. The turn the restart cut short counts as stopped, so nothing
     * drains on its own; a queue the user had paused keeps its reason. Said
     * through the event log, so a client with a saved cursor hears it too.
     * Call once, before any session can run.
     */
    pauseQueuesAfterRestart(): number {
      const database = options.database
      if (!database) return 0
      options.flush?.()
      const rows = database
        .prepare(
          "SELECT thread_id, session_id FROM threads WHERE queue_json IS NOT NULL AND json_array_length(queue_json, '$.items') > 0",
        )
        .all() as { thread_id: string; session_id: string }[]
      const timestamp = new Date().toISOString()
      const events: ProofEvent[] = []
      for (const row of rows) {
        const queue = readThreadQueue(database, row.thread_id)
        const steering = queue.items.some((item) => item.delivery === 'steering')
        if (queue.items.length === 0 || (queue.pausedBy && !steering)) continue
        events.push(
          ProofEventSchemas['thread.queue.updated'].parse({
            type: 'event',
            name: 'thread.queue.updated',
            eventId: randomUUID(),
            timestamp,
            scope: {
              type: 'thread',
              environmentId,
              sessionId: row.session_id,
              threadId: row.thread_id,
            },
            payload: {
              items: givenBackFirst(queue.items, new Set(), (item) => item.delivery === 'steering'),
              pausedBy: queue.pausedBy ?? 'restart',
            },
          }),
        )
      }
      if (events.length === 0) return 0
      if (options.appendAtomic) options.appendAtomic(events)
      else for (const event of events) appendEvent(event)
      return events.length
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
      // Its sessions go with it (the rows cascade), so their provider
      // sessions are retired as a deleted session's are: read first, while
      // the rows are still there.
      const ids = new Set(
        [...sessions.values()]
          .filter((record) => record.session.workspaceId === workspaceId)
          .map((record) => record.session.sessionId),
      )
      if (options.database) {
        options.flush?.()
        const rows = options.database
          .prepare('SELECT session_id FROM sessions WHERE workspace_id = ?')
          .all(workspaceId) as { session_id: string }[]
        for (const row of rows) ids.add(row.session_id)
      }
      const retiring = retirements([...ids])
      let closed = 0
      for (const record of [...sessions.values()]) {
        if (record.session.workspaceId !== workspaceId) continue
        // A child already went with its parent earlier in this pass.
        if (!sessions.has(record.session.sessionId)) continue
        for (const item of dropSessionRecords(record.session.sessionId)) abandon(item)
        closed += 1
      }
      retire(retiring)
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
      if (record.detached) {
        return { code: 'capability_missing' as const, message: ONLY_ITS_AGENT }
      }
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
        // Before anything is announced: a folder that cannot be made leaves
        // no session behind.
        let cwd: string
        try {
          cwd = target.sessionCwd?.(sessionId) ?? target.cwd
        } catch {
          return rejectWorkspace(command.requestId, input.workspaceId, WORKSPACE_UNAVAILABLE)
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
          cwd,
          runtimeSession,
          turns: [],
          messages: [],
          commandTurns: new Map(),
          interactions: new Map(),
          queue: EMPTY_THREAD_QUEUE,
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
        // The draft's mode too, so the process starts in it rather than in
        // the provider's default until the first turn sets it.
        const launchMode = input.firstMessage !== undefined ? input.modeId : undefined
        if (
          (launched && (launched.modelId !== undefined || launched.configValues !== undefined)) ||
          launchMode !== undefined
        ) {
          try {
            options.seedSessionComposer?.(session.sessionId, {
              ...(launched?.modelId !== undefined ? { modelId: launched.modelId } : {}),
              ...(launched?.configValues !== undefined
                ? { configValues: launched.configValues }
                : {}),
              ...(launchMode !== undefined ? { modeId: launchMode } : {}),
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
        // Read before the rows go: what each deleted session's provider holds.
        const retiring =
          parsed.data.name === 'session.delete' ? retirements(sessionTree(sessionId)) : []
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
          sendTitle(sessionId)
          return ProofResponseSchemas['session.rename'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: { session: { ...session, title: parsed.data.payload.title } },
          })
        }
        for (const item of dropSessionRecords(sessionId)) abandon(item)
        retire(retiring)
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
        // A settled session is put away for good: it leaves Cooking too, so
        // moving it back, or a new turn, brings it to the active list.
        const cooking =
          record?.cookingAt !== undefined || ('cookingAt' in session && !!session.cookingAt)
        const event = ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: randomUUID(),
          timestamp,
          scope: { type: 'environment', environmentId },
          payload: { sessionId, settledAt, ...(settled && cooking ? { cookingAt: null } : {}) },
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
          if (settled) item.cookingAt = undefined
        }
        return ProofResponseSchemas['session.settle'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { settledAt },
        })
      }

      if (command.name === 'session.pin') {
        const parsed = ProofCommandSchemas['session.pin'].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid session request.')
        options.flush?.()
        const { sessionId, pinned } = parsed.data.payload
        const session =
          sessions.get(sessionId)?.session ??
          (options.database ? getSessionSummary(options.database, sessionId) : undefined)
        if (!session) return errorResult(command.requestId, 'not_found', 'Session not found.')
        const timestamp = new Date().toISOString()
        const pinnedAt = pinned ? timestamp : null
        const event = ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: randomUUID(),
          timestamp,
          scope: { type: 'environment', environmentId },
          payload: { sessionId, pinnedAt },
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
          item.pinnedAt = pinned ? Date.parse(timestamp) : undefined
        }
        return ProofResponseSchemas['session.pin'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { pinnedAt },
        })
      }

      if (command.name === 'session.cook') {
        const parsed = ProofCommandSchemas['session.cook'].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid session request.')
        options.flush?.()
        const { sessionId, cooking } = parsed.data.payload
        const record = sessions.get(sessionId)
        const summary = options.database
          ? getSessionSummary(options.database, sessionId)
          : record
            ? summaryOf(record)
            : undefined
        if (!summary) return errorResult(command.requestId, 'not_found', 'Session not found.')
        // A session that already needs the user (asking, done, or failed)
        // stays where they will see it: what would bring it back has already
        // happened. This also catches a turn that ends just before the request.
        if (
          cooking &&
          (summary.status === 'waiting' || summary.status === 'error' || summary.doneAt)
        ) {
          return errorResult(
            command.requestId,
            'conflict',
            'A session that needs you cannot be sent cooking.',
          )
        }
        const timestamp = new Date().toISOString()
        const cookingAt = cooking ? timestamp : null
        const event = ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: randomUUID(),
          timestamp,
          scope: { type: 'environment', environmentId },
          payload: { sessionId, cookingAt },
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
          item.cookingAt = cooking ? Date.parse(timestamp) : undefined
        }
        return ProofResponseSchemas['session.cook'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: { cookingAt },
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
          if (!providers[record.providerId].capabilities.supportsBackgroundTasks) continue
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

      if (command.name === 'subagent.stop') {
        const parsed = ProofCommandSchemas['subagent.stop'].safeParse(command)
        if (!parsed.success)
          return errorResult(command.requestId, 'validation', 'Invalid subagent request.')
        options.flush?.()
        const { sessionId, subagentId } = parsed.data.payload
        const stopped = () =>
          ProofResponseSchemas['subagent.stop'].parse({
            type: 'response',
            requestId: command.requestId,
            payload: null,
          })
        const entry = subagentsById.get(subagentId)
        if (entry) {
          if (entry.record.parentSessionId !== sessionId) {
            return errorResult(command.requestId, 'not_found', 'Subagent not found.')
          }
          return stopSubagent(entry, command.requestId, stopped)
        }
        // Known only to the rows: no runtime of this process runs it, and a
        // restart settled what the last one left running.
        const stored = options.database
          ? getStoredSubagent(options.database, subagentId)
          : undefined
        if (stored?.record.parentSessionId !== sessionId) {
          return errorResult(command.requestId, 'not_found', 'Subagent not found.')
        }
        return stopped()
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
        if (!record.detached && !providers[record.providerId].capabilities.canLoadSession) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'Provider cannot resume sessions.',
          )
        }
        // A child its parent's runtime fills has no provider session to warm.
        if (!record.detached) {
          void record.runtimeSession
            .then((sessionId) => runtime.ensureSession(route(record, sessionId)))
            .catch(() => undefined)
        }
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

      if (command.name === 'queue.add' || command.name === 'turn.steer') {
        const steering = command.name === 'turn.steer'
        const parsed = steering
          ? ProofCommandSchemas['turn.steer'].safeParse(command)
          : ProofCommandSchemas['queue.add'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid message request.')
        }
        const input = parsed.data.payload
        const target = queueTarget(command.requestId, input, context)
        if ('type' in target) return target
        const record = target
        const providerRejection = rejectProvider(command.requestId, record.providerId)
        if (providerRejection) return providerRejection
        const answer = (outcome: 'steering' | 'queued') =>
          steering
            ? ProofResponseSchemas['turn.steer'].parse({
                type: 'response',
                requestId: command.requestId,
                payload: { queueItemId: input.commandId, outcome },
              })
            : ProofResponseSchemas['queue.add'].parse({
                type: 'response',
                requestId: command.requestId,
                payload: { queueItemId: input.commandId },
              })
        // A retry: the message is waiting or already ran. Answered as it
        // stands now, which is what a client needs to know.
        if (knownQueueItem(record, input.commandId)) {
          const waiting = record.queue.items.find((item) => item.queueItemId === input.commandId)
          return answer(waiting?.delivery === 'steering' ? 'steering' : 'queued')
        }
        // Steering needs a turn of the user's that the provider is running,
        // that nobody is stopping, on a provider that can take a message
        // into it. Otherwise the message waits for the next turn.
        const active = record.activeTurn
        const steerable =
          'turnId' in input &&
          providers[record.providerId].capabilities.canSteer &&
          !!runtime.steer &&
          !!active &&
          active.turn.turnId === input.turnId &&
          active.promptStarted === true &&
          // A turn the provider began by itself has no prompt to add to.
          active.userMessage !== undefined &&
          !active.interruptRequested &&
          !record.cancellation &&
          !record.pendingBuild
        const added = enqueue(record, command.requestId, input, steerable ? 'steering' : 'queued')
        if ('type' in added) return added
        if (steerable) steerToProvider(record, added.item, added.images)
        // Nothing running and nothing held back: it runs now.
        else drain(record)
        return answer(steerable ? 'steering' : 'queued')
      }

      if (command.name === 'queue.remove') {
        const parsed = ProofCommandSchemas['queue.remove'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid queue request.')
        }
        const input = parsed.data.payload
        const target = queueTarget(command.requestId, input, context)
        if ('type' in target) return target
        const item = target.queue.items.find((entry) => entry.queueItemId === input.queueItemId)
        if (!item) {
          return errorResult(command.requestId, 'conflict', 'This message was already sent.')
        }
        if (item.delivery === 'steering') {
          return errorResult(
            command.requestId,
            'conflict',
            'This message is already with the agent. It joins at the next step.',
          )
        }
        // The parent agent or the environment sent it, and was told it will run.
        if (item.origin) {
          return errorResult(
            command.requestId,
            'conflict',
            'An agent sent this message, so only it can take it back.',
          )
        }
        if (!writeQueue(target, withoutItem(target.queue, input.queueItemId))) {
          return errorResult(command.requestId, 'unavailable', 'The queue could not be saved.')
        }
        return ProofResponseSchemas['queue.remove'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: null,
        })
      }

      if (command.name === 'queue.resume') {
        const parsed = ProofCommandSchemas['queue.resume'].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid queue request.')
        }
        const target = queueTarget(command.requestId, parsed.data.payload, context)
        if ('type' in target) return target
        const providerRejection = rejectProvider(command.requestId, target.providerId)
        if (providerRejection) return providerRejection
        if (target.queue.pausedBy) {
          if (!writeQueue(target, { items: target.queue.items, pausedBy: null })) {
            return errorResult(command.requestId, 'unavailable', 'The queue could not be saved.')
          }
        }
        drain(target)
        return ProofResponseSchemas['queue.resume'].parse({
          type: 'response',
          requestId: command.requestId,
          payload: null,
        })
      }

      if (command.name === STEER_SEND_NOW_CAPABILITY) {
        const parsed = SteerCommandSchemas[STEER_SEND_NOW_CAPABILITY].safeParse(command)
        if (!parsed.success) {
          return errorResult(command.requestId, 'validation', 'Invalid steer request.')
        }
        const input = parsed.data.payload
        const target = queueTarget(command.requestId, input, context)
        if ('type' in target) return target
        const providerRejection = rejectProvider(command.requestId, target.providerId)
        if (providerRejection) return providerRejection
        if (!runtime.withdrawSteer || !providers[target.providerId].capabilities.canCancelPrompt) {
          return errorResult(
            command.requestId,
            'capability_missing',
            'This provider cannot send a steered message early.',
          )
        }
        const item = target.queue.items.find((entry) => entry.queueItemId === input.queueItemId)
        if (!item) {
          return errorResult(command.requestId, 'conflict', 'This message was already sent.')
        }
        if (item.delivery !== 'steering') {
          return errorResult(
            command.requestId,
            'conflict',
            'This message is not waiting for the agent.',
          )
        }
        sendSteerNow(target, item.queueItemId)
        return SteerResponseSchemas[STEER_SEND_NOW_CAPABILITY].parse({
          type: 'response',
          requestId: command.requestId,
          payload: null,
        })
      }

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
        // A subagent's turn runs in its parent's runtime: stopping it is
        // stopping the subagent.
        const delegated =
          active.turn.origin === 'delegated' && record.subagent
            ? subagentsById.get(record.subagent.subagentId)
            : undefined
        if (delegated) {
          return stopSubagent(delegated, command.requestId, () =>
            ProofResponseSchemas['turn.interrupt'].parse({
              type: 'response',
              requestId: command.requestId,
              payload: { turnId: active.turn.turnId },
            }),
          )
        }
        interruptTurn(record, active)
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
              // Whatever happens to the build, the queue is no longer held.
              queueMicrotask(() => drain(record))
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

    moveRefusal,
    requestMove,

    /**
     * The session a runtime thread is working for right now, for a tool the
     * agent calls mid-turn (`share_file`). Undefined between turns: what an
     * agent shares belongs to the turn it shares it in.
     */
    agentTurnOf(threadId: string) {
      const record = threads.get(threadId)
      if (!record?.activeTurn) return undefined
      return {
        sessionId: record.session.sessionId,
        workspaceId: record.session.workspaceId,
        cwd: record.cwd,
        turnId: record.activeTurn.turn.turnId,
      }
    },

    /**
     * File a stored artifact the agent shared into its live turn, as a reply
     * message of its own, where an image a tool returned would be: the client
     * reads it by reference, so no bytes enter the event log. Only into the
     * turn the share began in: a copy that outlived it belongs to no reply.
     */
    presentArtifact(threadId: string, turnId: string, metadata: ArtifactMetadata): boolean {
      const record = threads.get(threadId)
      const active = record?.activeTurn
      if (!record || !active || active.turn.turnId !== turnId || !options.artifacts) return false
      const timestamp = new Date().toISOString()
      // Its own message: text the agent writes next starts a new one after it.
      active.textRunId = undefined
      closeOpenReasoning(record, active, timestamp)
      return appendRuntimeEvent(
        ProofEventSchemas['message.delta'].parse({
          type: 'event',
          name: 'message.delta',
          eventId: randomUUID(),
          timestamp,
          scope: threadScope(record),
          payload: {
            messageId: randomUUID(),
            turnId: active.turn.turnId,
            role: 'assistant',
            content: options.artifacts.reference(metadata),
          },
        }),
      )
    },

    onRuntimeEvent(event: RuntimeEvent) {
      const record = threads.get(event.threadId)
      if (!record) return

      if (record.subagent?.origin === 'openmanager') observeSpawnedEvent(record, event)
      // A call of our own spawn tool: the card it files takes its place.
      if (
        event.event === 'tool_call' &&
        event.subtaskId === undefined &&
        record.activeTurn &&
        /(^|[^a-z])spawn_agent$/.test(event.data.toolName ?? event.data.title ?? '')
      ) {
        const hostId = stableId(record.activeTurn.toolIds, event.data.toolCallId)
        const calls = (record.activeTurn.spawnCalls ??= [])
        if (hostId && !calls.includes(hostId)) calls.push(hostId)
      }

      // A runtime that created a session where it meant to load one (no
      // identity, or one the agent had forgotten), including a respawn inside
      // a prompt: stamped now, synchronously, before that prompt is sent.
      if (event.event === 'session_created' && event.sessionId && !loadOnly(record)) {
        try {
          stampIdentity(record, event.sessionId)
        } catch (error) {
          options.onPersistenceError?.(error, 'session.created')
        }
        // And in memory: every later prompt, open and respawn names the
        // provider session `runtimeSession` resolves to. Left on the forgotten
        // one, the next process would resume that again, miss it, and start
        // yet another fresh session, losing this one's history.
        const created = event.sessionId
        void record.runtimeSession.then(
          (current) => {
            if (current !== created) record.runtimeSession = Promise.resolve(created)
          },
          () => undefined,
        )
      }

      // A subagent's reports and its work go to its record and its child,
      // whether or not this thread has a turn running: a background subagent
      // outlives the turn that started it (docs/decisions/subagents.md, Routing).
      if (event.event === 'subtask_update') {
        applySubtask(record, event.data, event.timestamp, event.subtaskId)
        return
      }
      if (event.subtaskId !== undefined) {
        routeSubagentWork(record, event, event.subtaskId)
        return
      }
      const settledRequest = settledRequestKey(event)
      const requester = settledRequest ? childRequests.get(settledRequest) : undefined
      if (requester) {
        if (requester.activeTurn) projectRuntimeEvent(requester, event, requester.activeTurn)
        return
      }
      if (event.event === 'process_exited') {
        interruptSubagentsOf(record, () => true, 'The agent process exited.')
      }

      if (event.event === 'background_tasks_update') {
        applyBackgroundTasks(record, event.data.tasks)
        return
      }
      if (event.event === 'background_turn_started') {
        startBackgroundTurn(record, event)
        return
      }
      if (event.event === 'steer_delivered') {
        deliverSteer(record, event.data.steerId, event.timestamp)
        return
      }
      if (event.event === 'steer_turn_started') {
        startSteeredTurn(record, event, event.data.steerId)
        return
      }
      if (event.event === 'steer_withdrawn') {
        returnSteer(record, event.data.steerId)
        return
      }
      const unrecorded = record.unrecordedBackgroundTurn
      if (unrecorded && event.messageId !== undefined && event.messageId === unrecorded.messageId) {
        startBackgroundTurn(record, unrecorded)
      }

      if (event.event === 'prompt_started') {
        const active = record.activeTurn
        const promptId = active?.userMessage?.messageId ?? active?.promptId
        if (!active || promptId === undefined || event.data.userMessageId !== promptId) return
        active.runtimeMessageId = event.messageId
        // Only now has the provider opened the session and accepted the mode.
        // A launch that fails before this leaves every composer where it was.
        if (active.modeId) options.onSessionMode?.(record.session.sessionId, active.modeId)
        // The environment's own prompt is never shown: its turn was announced
        // when it opened.
        if (active.userMessage) projectRuntimeEvent(record, event, active)
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
        event.event === 'turn_identified' ||
        event.category === 'stream' ||
        event.category === 'tool' ||
        event.category === 'permission' ||
        event.event === 'question_request' ||
        event.event === 'question_resolved' ||
        event.event === 'plan_review_request' ||
        event.event === 'plan_review_resolved' ||
        event.event === 'plan_update' ||
        event.event === 'provider_notice' ||
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
        // Nor is its id.
        const ends =
          event.event === 'prompt_completed' ||
          event.event === 'turn_identified' ||
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
      } else if (
        event.event === 'process_exited' &&
        event.data.expected &&
        active &&
        !active.runtimeMessageId
      ) {
        // A process the host stopped before this turn's prompt reached the
        // provider: the one a moved session left in its old folder, replaced
        // as the prompt opens a new one. It is not this turn's process; if
        // the new one cannot start, the prompt itself fails the turn.
        return
      }
      // An agent echoing the environment's own prompt back: it is not the
      // user's, and the turn has no user message to file it under.
      if (event.event === 'user_message_chunk' && active?.promptId) return

      if (!active) {
        projectRuntimeEvent(record, event, undefined)
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
