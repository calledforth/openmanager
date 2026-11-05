import { z } from 'zod'
import { SessionTitleSourceSchema } from './session-title.js'
import { SessionComposerStateSchema } from './session-composer.js'

/** Host-owned resource identity, distinct from a command's request ID. */
export const EntityIdSchema = z.string().min(1).max(256).regex(/^\S+$/)
export const TimestampSchema = z.iso.datetime({ offset: true })

// Strict scopes prevent an accidentally omitted discriminator/extra ID from
// silently broadening a narrow subscription into an environment subscription.
export const EnvironmentScopeSchema = z.strictObject({
  type: z.literal('environment'),
  environmentId: EntityIdSchema,
})
export const SessionScopeSchema = z.strictObject({
  type: z.literal('session'),
  environmentId: EntityIdSchema,
  sessionId: EntityIdSchema,
})
export const ThreadScopeSchema = z.strictObject({
  type: z.literal('thread'),
  environmentId: EntityIdSchema,
  sessionId: EntityIdSchema,
  threadId: EntityIdSchema,
})
export const SubscriptionScopeSchema = z.discriminatedUnion('type', [
  EnvironmentScopeSchema,
  SessionScopeSchema,
  ThreadScopeSchema,
])

/**
 * The kind of machine an environment runs on. WSL is its own kind: a Windows
 * host and a WSL distro on it report the same hostname, and this is what tells
 * them apart.
 */
export const ENVIRONMENT_PLATFORMS = ['windows', 'wsl', 'linux', 'macos'] as const
export const EnvironmentPlatformSchema = z.enum(ENVIRONMENT_PLATFORMS)
export type EnvironmentPlatform = z.infer<typeof EnvironmentPlatformSchema>

const ENVIRONMENT_PLATFORM_NAMES: Record<EnvironmentPlatform, string> = {
  windows: 'Windows',
  wsl: 'WSL',
  linux: 'Linux',
  macos: 'macOS',
}

/** A platform as people read it, e.g. "WSL"; undefined for one this client does not know. */
export function environmentPlatformName(platform: unknown): string | undefined {
  return EnvironmentPlatformSchema.safeParse(platform).success
    ? ENVIRONMENT_PLATFORM_NAMES[platform as EnvironmentPlatform]
    : undefined
}

export const EnvironmentSchema = z.object({
  environmentId: EntityIdSchema,
  name: z.string(),
  /** Absent from older servers; a platform this client does not know reads as absent. */
  platform: EnvironmentPlatformSchema.optional().catch(undefined),
})
/**
 * A folder registered on the environment. `path` is the canonical on-disk
 * root as the environment resolved it; clients display it but still address
 * the workspace by ID (D9). `exists` is checked when the workspace is listed,
 * so a folder moved or deleted since registration reads as missing.
 */
/**
 * A cheap summary of what a workspace offers, observed on a command that uses
 * the workspace and stored with it, never by walking the tree: whether the
 * root is a git checkout (one `.git` stat). Which providers can start a
 * session is a current reading of provider health (`ProviderHealth.available`),
 * not a fact about the workspace (docs/sync-foundations.md §4.4).
 */
export const WorkspaceCapabilitiesSchema = z.object({
  git: z.boolean(),
})
/**
 * Where a git workspace's checkout points, read from `HEAD` when the workspace
 * is listed or used. `branch` is null on a detached HEAD; `worktree` marks a
 * linked worktree (its `.git` is a file naming the main repository's gitdir).
 */
export const WorkspaceGitSchema = z.object({
  branch: z.string().max(256).nullable(),
  worktree: z.boolean(),
})
export const WorkspaceSchema = z.object({
  workspaceId: EntityIdSchema,
  name: z.string(),
  path: z.string(),
  /** When a session last started here; null until one has. */
  lastUsedAt: TimestampSchema.nullable(),
  /**
   * Latest session activity here (a start or a later turn); orders recents.
   * Defaulted so an environment that predates it still lists (no version bump).
   */
  lastActivityAt: TimestampSchema.nullable().default(null),
  exists: z.boolean(),
  /** Omitted by older environments; fall back to `exists` in that case. */
  availability: z.enum(['available', 'missing', 'inaccessible']).optional(),
  /** Defaulted for the same reason: an older environment reads as offering nothing. */
  capabilities: WorkspaceCapabilitiesSchema.default({ git: false }),
  /** Absent outside a git checkout and on older environments. */
  git: WorkspaceGitSchema.optional(),
})
/**
 * A workspace icon travels inline as a `data:image/...;base64,` URL so a
 * browser can render it without a second authenticated fetch. The size cap
 * matches what the environment will read from disk.
 */
export const WORKSPACE_ICON_MAX_DATA_URL_LENGTH = 400_000
export const WorkspaceIconDataUrlSchema = z
  .string()
  .max(WORKSPACE_ICON_MAX_DATA_URL_LENGTH)
  .regex(/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/)

export const SessionSchema = z.object({
  sessionId: EntityIdSchema,
  workspaceId: EntityIdSchema,
  title: z.string().nullable(),
  /**
   * The session that delegated this one (a subagent transcript). Absent on
   * top-level sessions and on environments that predate child sessions. A
   * child always shares its parent's workspace and is deleted with it.
   */
  parentSessionId: EntityIdSchema.optional(),
})
/** Server-owned lifecycle, persisted in sessions.status; see docs/session-status.md. */
export const SessionStatusSchema = z.enum(['idle', 'running', 'waiting', 'error'])
/** What a waiting session is waiting on: the kind of its pending request. */
export const InteractionKindSchema = z.enum(['permission', 'question', 'plan'])
/** The most background tasks one session reports at a time. */
export const BACKGROUND_TASKS_MAX = 64
/**
 * Work the provider keeps running after the turn that started it has ended: a
 * backgrounded command, a subagent, a watch loop. `taskId` is the host's own
 * id for it and is what `session.background.stop` names.
 */
export const BackgroundTaskSchema = z.object({
  taskId: EntityIdSchema,
  kind: z.enum(['agent', 'shell', 'monitor', 'workflow', 'other']),
  description: z.string().max(1000),
})
export const BackgroundTaskListSchema = z.array(BackgroundTaskSchema).max(BACKGROUND_TASKS_MAX)
/**
 * Sidebar row. Deliberately excludes threads and messages so a list or
 * environment snapshot cannot pull a transcript across the wire.
 */
export const SessionSummarySchema = SessionSchema.extend({
  /** Provenance keeps automatic titles from replacing a manual rename. */
  titleSource: SessionTitleSourceSchema.optional(),
  status: SessionStatusSchema,
  providerId: EntityIdSchema,
  updatedAt: TimestampSchema,
  /**
   * When the user put the session away. Null or absent means it is active.
   * The environment clears it when the session starts a turn or asks the
   * user something, so finished work never hides work that needs attention.
   */
  settledAt: TimestampSchema.nullable().optional(),
  /**
   * When the user pinned the session to the top of the active list. Absent
   * or null means it is not pinned; a summary leaves it out while it is not,
   * so nothing that creates a session has to say so. Only the user changes it:
   * settling keeps it, and so does any turn.
   */
  pinnedAt: TimestampSchema.nullable().optional(),
  /**
   * When the last turn completed, while the user has not opened the session
   * since. Null or absent means there is nothing unseen: the environment clears
   * it on `session.acknowledge` and whenever the next turn starts.
   */
  doneAt: TimestampSchema.nullable().optional(),
  /**
   * Background work still running in this session. A session with any reads
   * as `running` even between turns. Absent when there is none, and on older
   * environments.
   */
  backgroundTasks: BackgroundTaskListSchema.optional(),
  /**
   * The kind of request a `waiting` session is waiting on. When several are
   * open, a question wins, then the oldest. Absent unless the session is
   * waiting, and on older environments.
   */
  waitingOn: InteractionKindSchema.optional(),
  /**
   * True while a `running` session is running only because of its background
   * work: no turn is in flight. Absent otherwise, and on older environments.
   */
  inBackground: z.literal(true).optional(),
  /** Absent until the session has a selection, and on older environments. */
  composer: SessionComposerStateSchema.optional(),
})
export const ThreadSchema = z.object({ threadId: EntityIdSchema, sessionId: EntityIdSchema })

/** Why a turn failed: the host's classification, never a provider's own words. */
export const TurnFailureReasonSchema = z.enum([
  'provider_process_exited',
  'provider_process_crashed',
  'provider_error',
  'authentication_required',
  'capability_missing',
  /** The conversation no longer fits the model's context window. */
  'context_window_exceeded',
  /** The account's usage allowance is spent until `resetsAt`, when known. */
  'usage_limit',
  /** The provider is refusing requests for now; a later retry may pass. */
  'rate_limited',
  /** The provider has no capacity right now; a later retry may pass. */
  'overloaded',
  /** The model declined the request. */
  'refused',
])
export type TurnFailureReason = z.infer<typeof TurnFailureReasonSchema>
/**
 * What a failed turn says, per reason: the one table every writer and reader
 * uses, so the live event, the stored row and an older row read back agree.
 */
export const TURN_FAILURE_MESSAGES: Record<TurnFailureReason, string> = {
  provider_process_exited: 'The provider process exited before the turn completed.',
  provider_process_crashed: 'The provider process crashed before the turn completed.',
  provider_error: 'The provider failed to complete the turn.',
  authentication_required: 'The provider requires authentication.',
  capability_missing: 'The provider does not support this operation.',
  context_window_exceeded: "The conversation is too long for the model's context window.",
  usage_limit: "You've reached your usage limit.",
  rate_limited: 'The provider is rate limiting requests.',
  overloaded: 'The provider is overloaded right now.',
  refused: 'The model declined this request.',
}
/**
 * What the user can do about a failed turn, judged by the environment for the
 * provider that ran it: send the prompt again, compact the conversation, or
 * sign the provider in. Absent when nothing in the app helps.
 */
export const TurnRecoveryActionSchema = z.enum(['retry', 'compact', 'sign_in'])
export type TurnRecoveryAction = z.infer<typeof TurnRecoveryActionSchema>
/** How a turn failed. Kept with the turn, so a snapshot says what the live event said. */
export const TurnFailureSchema = z.object({
  reason: TurnFailureReasonSchema,
  message: z.string(),
  action: TurnRecoveryActionSchema.optional(),
  /** When the limit behind a `usage_limit` lifts, if the provider said. */
  resetsAt: TimestampSchema.optional(),
  /**
   * The provider's own explanation, shown under the host's message, never
   * instead of it: it often says what to change in words only the provider has.
   */
  detail: z.string().optional(),
})
export type TurnFailure = z.infer<typeof TurnFailureSchema>
/** Who ended an interrupted turn: the user, or a restart that cut it off. */
export const TurnInterruptionSchema = z.enum(['user', 'server_restarted'])
export type TurnInterruption = z.infer<typeof TurnInterruptionSchema>
export const TurnSchema = z.object({
  turnId: EntityIdSchema,
  threadId: EntityIdSchema,
  state: z.enum(['running', 'waiting', 'completed', 'interrupted', 'failed']),
  /**
   * When the turn started and settled, so a transcript can label finished
   * work with how long it took. Absent on older environments and, for
   * `finishedAt`, while the turn is still open.
   */
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  /**
   * Who began the turn. `background` is a turn the provider started by itself:
   * a background task finished and the agent is acting on the result. Absent
   * on a turn the user sent, and on older environments.
   */
  origin: z.enum(['background']).optional(),
  /**
   * The command that started the turn, so a client matches its own send to
   * the turn by id rather than by text. Absent on a turn nobody sent.
   */
  commandId: EntityIdSchema.optional(),
  /** Why a `failed` turn failed, as its `turn.failed` said. Persisted, so a snapshot carries it. */
  failure: TurnFailureSchema.optional(),
  /** Who interrupted an `interrupted` turn, as its `turn.interrupted` said. */
  interruptedBy: TurnInterruptionSchema.optional(),
})
export const ArtifactReferenceSchema = z.object({
  type: z.literal('artifact'),
  artifactId: EntityIdSchema,
  mimeType: z.string().min(1),
  name: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  /**
   * The tool call whose result produced this image, when the agent's tool made
   * it rather than the user attaching it. The image is shown in the reply; the
   * id lets a client show it under that tool's row as well.
   */
  toolCallId: EntityIdSchema.optional(),
})
export const ContentBlockSchema = z.discriminatedUnion('type', [
  ArtifactReferenceSchema,
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mimeType: z.string().min(1), data: z.string() }),
  z.object({ type: z.literal('audio'), mimeType: z.string().min(1), data: z.string() }),
  z.object({
    type: z.literal('resource_link'),
    uri: z.string().min(1),
    name: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  z.object({
    type: z.literal('resource'),
    uri: z.string().optional(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    data: z.string().optional(),
  }),
])
export const MessageSchema = z.object({
  messageId: EntityIdSchema,
  threadId: EntityIdSchema,
  turnId: EntityIdSchema,
  role: z.enum(['user', 'assistant']),
  content: z.array(ContentBlockSchema),
})
/**
 * One reasoning block of a turn, as `message.reasoning` events accumulate it:
 * a run of its own with its own message id, distinct from the turn's text.
 */
export const ReasoningBlockSchema = z.object({
  messageId: EntityIdSchema,
  turnId: EntityIdSchema,
  phase: z.enum(['start', 'delta', 'stop']),
  content: z.array(ContentBlockSchema),
  tokens: z.number().int().nonnegative().optional(),
})
/** A status a tool call does not leave again. */
export function isSettledToolStatus(status: string | undefined): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'declined' || status === 'cancelled'
  )
}
export const ToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
])
/**
 * `cancelled`: the turn ended, or the server restarted, while the tool was
 * still open; the server closes it with an explicit `tool.updated`.
 * `declined`: the user, or a rule acting for them, refused to let it run.
 * Both are outcomes of their own, not failures.
 */
export const ToolCallStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'declined',
  'cancelled',
])
/** A file a tool call touched or was pointed at. */
export const ToolLocationSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
})
/** Lines an edit added and removed, only ever as the provider reported them. */
export const ToolLineChangesSchema = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
})
/**
 * What a client holds of a tool call. A row reads from these alone.
 *
 * `output` is present only while the tool runs: what it has written so far.
 * Once it settles the text stays on the environment, and `outputBytes` says how
 * much there is to fetch from `toolOutputPath`. Chat never carries file
 * contents or diffs, so a read or an edit has only its paths and line counts.
 */
export const ToolCallStateSchema = z.object({
  toolCallId: EntityIdSchema,
  turnId: EntityIdSchema,
  /** The provider's own name for the tool, unchanged: `Bash`, `mcp__github__search`. */
  toolName: z.string().min(1).optional(),
  /** A human title, when the provider gives one; separate from the name. */
  title: z.string().optional(),
  kind: ToolKindSchema.optional(),
  status: ToolCallStatusSchema.optional(),
  input: z.json().optional(),
  output: z.string().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  locations: z.array(ToolLocationSchema).optional(),
  lineChanges: ToolLineChangesSchema.optional(),
  /** When the call opened, and when it reached a final status. */
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
})
/**
 * What a `tool.updated` event carries: any of the fields above, which replace
 * what was held (`output` included), or `outputDelta`, text appended to it.
 * Never both, since their order would be ambiguous, and neither on the update
 * that settles the call: a settled tool's text does not travel in events.
 */
export const ToolCallUpdateSchema = ToolCallStateSchema.extend({
  outputDelta: z.string().min(1).optional(),
})
  .refine((update) => update.output === undefined || update.outputDelta === undefined, {
    message: 'A tool update replaces its output or appends to it, not both.',
    path: ['outputDelta'],
  })
  .refine(
    (update) =>
      !isSettledToolStatus(update.status) ||
      (update.output === undefined && update.outputDelta === undefined),
    { message: 'A settled tool carries no output text.', path: ['output'] },
  )
/**
 * Notices that only describe what is happening right now. They travel as
 * `turn.notice`, are never stored, and last until `turn.notice.cleared`: the
 * provider is retrying a request, or compacting the conversation.
 */
export const TransientTurnNoticeKindSchema = z.enum(['retrying', 'compacting'])
/**
 * Notices that stay part of the turn. They travel as `turn.notice.recorded`,
 * are stored with the turn and come back in its snapshot, in the place they
 * happened: the conversation was compacted, the model was switched after a
 * refusal or declined without one, a usage limit is close, or the provider
 * said something worth keeping (`info`, `warning`).
 */
export const DurableTurnNoticeKindSchema = z.enum([
  'compacted',
  'model_fallback',
  'refusal',
  'usage_warning',
  'info',
  'warning',
])
const turnNotice = <K extends z.ZodType>(kind: K) =>
  z.object({
    noticeId: EntityIdSchema,
    turnId: EntityIdSchema,
    kind,
    /** The whole notice as plain text; the fields below only refine it. */
    message: z.string(),
    /** A second line the provider gave, such as a policy explanation. */
    detail: z.string().optional(),
    /** `retrying`: how far the provider is through its retries, and why. */
    retry: z
      .object({
        attempt: z.number().int().positive(),
        maxAttempts: z.number().int().positive().optional(),
        cause: TurnFailureReasonSchema.optional(),
        /** When the next attempt is due. */
        retryAt: TimestampSchema.optional(),
      })
      .optional(),
    /** `model_fallback`: the model the turn moved off, and the one it moved to. */
    model: z.object({ from: z.string().optional(), to: z.string().min(1) }).optional(),
    /** `compacted`: what started the compaction and how much it saved. */
    compaction: z
      .object({
        trigger: z.enum(['manual', 'auto']),
        tokensBefore: z.number().int().nonnegative().optional(),
        tokensAfter: z.number().int().nonnegative().optional(),
      })
      .optional(),
    /** `usage_warning`: when the limit it warns about resets. */
    resetsAt: TimestampSchema.optional(),
  })
export const TransientTurnNoticeSchema = turnNotice(TransientTurnNoticeKindSchema)
export const DurableTurnNoticeSchema = turnNotice(DurableTurnNoticeKindSchema)
/**
 * One thing that took its place in a turn's transcript, named by the id it is
 * stored under. A list of these is the order messages, reasoning blocks, tool
 * calls and durable notices happened in, which their id-keyed lists alone
 * cannot say.
 */
export const ActivityRefSchema = z.object({
  kind: z.enum(['message', 'reasoning', 'tool', 'notice']),
  id: EntityIdSchema,
  turnId: EntityIdSchema,
})

/**
 * What a started turn looks like to the client that asked for it: the turn,
 * the user message the environment recorded, and the command id that started
 * it. The id is absent from environments that predate it, so a client falls
 * back to the id it sent.
 */
export const TurnStartSchema = z.object({
  turn: TurnSchema,
  userMessage: MessageSchema,
  commandId: EntityIdSchema.optional(),
})
/**
 * A turn as the environment announces it. Usually the user's, carrying the
 * message that asked for it. A `background` turn has no `userMessage`: nobody
 * sent one.
 */
export const TurnStartedSchema = TurnStartSchema.partial({ userMessage: true }).refine(
  (started) => (started.userMessage === undefined) === (started.turn.origin === 'background'),
  { message: 'Only a background turn starts without a user message.', path: ['userMessage'] },
)

const CancellationReasonSchema = z.enum([
  'user',
  'timeout',
  'session_closed',
  'tool_cancelled',
  'runtime_disposed',
  /** The turn ended while the request was still open. */
  'turn_ended',
  /** The server restarted while the request was still open. */
  'server_restarted',
])
const CancelledSchema = z.object({
  outcome: z.literal('cancelled'),
  reason: CancellationReasonSchema.optional(),
})
export const PermissionOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('selected'), optionId: EntityIdSchema }),
  CancelledSchema,
])
export const QuestionOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('answered'),
    answers: z.array(
      z.object({
        questionId: EntityIdSchema,
        selectedOptionIds: z.array(EntityIdSchema).optional(),
        text: z.string().optional(),
      }),
    ),
  }),
  CancelledSchema,
])
export const PlanReviewOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted') }),
  z.object({ outcome: z.literal('rejected'), reason: z.string().optional() }),
  CancelledSchema,
])
export const InteractionResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    interactionId: EntityIdSchema,
    outcome: PermissionOutcomeSchema,
  }),
  z.object({
    kind: z.literal('question'),
    interactionId: EntityIdSchema,
    outcome: QuestionOutcomeSchema,
  }),
  z.object({
    kind: z.literal('plan'),
    interactionId: EntityIdSchema,
    outcome: PlanReviewOutcomeSchema,
  }),
])
export const PlanTodoSchema = z.object({
  id: EntityIdSchema,
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
})
/** Durable host metadata; optional only for compatibility with older environments. */
export const InteractionLifecycleSchema = z.object({
  state: z.enum(['pending', 'resolved', 'expired', 'cancelled']),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
  resolvedByClientId: EntityIdSchema.nullable(),
})
export const InteractionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    interactionId: EntityIdSchema,
    lifecycle: InteractionLifecycleSchema.optional(),
    toolCall: z.object({
      toolCallId: EntityIdSchema,
      title: z.string(),
      kind: z.string().optional(),
    }),
    options: z
      .array(
        z.object({
          optionId: EntityIdSchema,
          name: z.string(),
          kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
        }),
      )
      .min(1),
    expiresAt: TimestampSchema.optional(),
  }),
  z.object({
    kind: z.literal('question'),
    interactionId: EntityIdSchema,
    lifecycle: InteractionLifecycleSchema.optional(),
    title: z.string().optional(),
    questions: z
      .array(
        z.object({
          questionId: EntityIdSchema,
          prompt: z.string(),
          options: z.array(
            z.object({
              optionId: EntityIdSchema,
              label: z.string(),
              description: z.string().optional(),
            }),
          ),
          allowMultiple: z.boolean().optional(),
          allowFreeText: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    kind: z.literal('plan'),
    interactionId: EntityIdSchema,
    lifecycle: InteractionLifecycleSchema.optional(),
    name: z.string().optional(),
    overview: z.string().optional(),
    markdown: z.string(),
    todos: z.array(PlanTodoSchema),
    phases: z.array(z.object({ name: z.string(), todos: z.array(PlanTodoSchema) })).optional(),
    continuation: z.enum(['same_turn', 'follow_up_turn']),
  }),
])

export type EntityId = z.infer<typeof EntityIdSchema>
export type SubscriptionScope = z.infer<typeof SubscriptionScopeSchema>
export type Environment = z.infer<typeof EnvironmentSchema>
export type Workspace = z.infer<typeof WorkspaceSchema>
export type WorkspaceGit = z.infer<typeof WorkspaceGitSchema>
export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilitiesSchema>
export type Session = z.infer<typeof SessionSchema>
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export type SessionSummary = z.infer<typeof SessionSummarySchema>
export type InteractionKind = z.infer<typeof InteractionKindSchema>
export type Thread = z.infer<typeof ThreadSchema>
export type Turn = z.infer<typeof TurnSchema>
export type Message = z.infer<typeof MessageSchema>
export type ReasoningBlock = z.infer<typeof ReasoningBlockSchema>
export type ToolCallState = z.infer<typeof ToolCallStateSchema>
export type ToolCallUpdate = z.infer<typeof ToolCallUpdateSchema>
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>
export type ToolLocation = z.infer<typeof ToolLocationSchema>
export type ToolLineChanges = z.infer<typeof ToolLineChangesSchema>
export type ActivityRef = z.infer<typeof ActivityRefSchema>
export type TransientTurnNotice = z.infer<typeof TransientTurnNoticeSchema>
export type DurableTurnNotice = z.infer<typeof DurableTurnNoticeSchema>
export type TurnStart = z.infer<typeof TurnStartSchema>
export type TurnStarted = z.infer<typeof TurnStartedSchema>
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>
export type ContentBlock = z.infer<typeof ContentBlockSchema>
export type Interaction = z.infer<typeof InteractionSchema>
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>
