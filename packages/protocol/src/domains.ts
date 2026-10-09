import { z } from 'zod'
import { SessionTitleSourceSchema } from './session-title.js'
import { SessionComposerStateSchema } from './session-composer.js'
import {
  TOOL_INPUT_MAX_BYTES,
  TOOL_LOCATION_PATH_MAX_LENGTH,
  TOOL_LOCATIONS_MAX,
  TOOL_NAME_MAX_LENGTH,
  TOOL_OUTPUT_MAX_BYTES,
} from './tool-output.js'

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

export const EnvironmentSchema = z.object({ environmentId: EntityIdSchema, name: z.string() })
/**
 * A folder registered on the environment. `path` is the canonical on-disk
 * root as the environment resolved it; clients display it but still address
 * the workspace by ID (D9). `exists` is checked when the workspace is listed,
 * so a folder moved or deleted since registration reads as missing.
 */
/**
 * A cheap summary of what a workspace offers, computed when it is listed and
 * never by walking the tree: whether the root is a git checkout (one `.git`
 * stat) and which providers the environment can start right now.
 */
export const WorkspaceCapabilitiesSchema = z.object({
  git: z.boolean(),
  providers: z.array(EntityIdSchema),
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
  capabilities: WorkspaceCapabilitiesSchema.default({ git: false, providers: [] }),
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
  /** Absent until the session has a selection, and on older environments. */
  composer: SessionComposerStateSchema.optional(),
})
export const ThreadSchema = z.object({ threadId: EntityIdSchema, sessionId: EntityIdSchema })

/** Default and ceiling for `session.list` / `session.history` pages. */
export const PAGE_LIMIT_DEFAULT = 50
export const PAGE_LIMIT_MAX = 100
export const PageLimitSchema = z.number().int().min(1).max(PAGE_LIMIT_MAX)
/**
 * Keyset for newest-first session lists. The next page starts strictly after
 * this `(updatedAt, sessionId)` pair; omit it for the first page.
 */
export const SessionListCursorSchema = z.object({
  updatedAt: TimestampSchema,
  sessionId: EntityIdSchema,
})
/**
 * Exclusive upper bound on a thread's message ordinal. Omit for the newest
 * page; walk backwards by sending the oldest ordinal from the previous page.
 */
export const HistoryCursorSchema = z.object({
  ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
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
 * Where a tool call is. `declined` and `cancelled` are outcomes of their own,
 * not failures: the user (or a rule acting for them) refused to let the tool
 * run, or the turn stopped before the tool reported a result.
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
  path: z.string().min(1).max(TOOL_LOCATION_PATH_MAX_LENGTH),
  line: z.number().int().nonnegative().optional(),
})
/**
 * A tool call's output, bounded to `TOOL_OUTPUT_MAX_BYTES`: the whole of it
 * while it fits, then its start (`text`), its newest end (`tail`) and how
 * many bytes were left out between them. See `tool-output.ts`.
 */
export const ToolOutputSchema = z
  .object({
    text: z.string().max(TOOL_OUTPUT_MAX_BYTES),
    omittedBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    tail: z.string().max(TOOL_OUTPUT_MAX_BYTES).optional(),
  })
  .refine((output) => output.tail === undefined || output.omittedBytes !== undefined, {
    message: 'Only a truncated output has a tail.',
    path: ['tail'],
  })
/** Lines an edit added and removed, only ever as the provider reported them. */
export const ToolLineChangesSchema = z.object({
  added: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  removed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
/** A tool's input as the environment keeps it: JSON, bounded, edit bodies removed. */
export const ToolInputSchema = z
  .json()
  .refine((input) => JSON.stringify(input).length <= TOOL_INPUT_MAX_BYTES, {
    message: 'Tool input exceeds its bound.',
  })
/** What the environment keeps of a tool call, and what a page or a snapshot carries. */
export const ToolCallStateSchema = z.object({
  toolCallId: EntityIdSchema,
  turnId: EntityIdSchema,
  /** The provider's own name for the tool, unchanged: `Bash`, `mcp__github__search`. */
  toolName: z.string().min(1).max(TOOL_NAME_MAX_LENGTH).optional(),
  /** A human title, when the provider gives one; separate from the name. */
  title: z.string().optional(),
  kind: ToolKindSchema.optional(),
  status: ToolCallStatusSchema.optional(),
  input: ToolInputSchema.optional(),
  output: ToolOutputSchema.optional(),
  locations: z.array(ToolLocationSchema).max(TOOL_LOCATIONS_MAX).optional(),
  lineChanges: ToolLineChangesSchema.optional(),
  /** When the call opened, and when it reached a final status. */
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
})
/**
 * What a `tool.updated` event carries: any of the fields above, which replace
 * what was held (`output` included), or `outputDelta`, newly streamed output
 * appended with `appendToolOutput`. Never both: their order would be ambiguous.
 */
export const ToolCallUpdateSchema = ToolCallStateSchema.extend({
  outputDelta: z.string().min(1).max(TOOL_OUTPUT_MAX_BYTES).optional(),
}).refine((update) => update.output === undefined || update.outputDelta === undefined, {
  message: 'A tool update replaces its output or appends to it, not both.',
  path: ['outputDelta'],
})
/**
 * One thing that took its place in a turn's transcript, named by the id it is
 * stored under. A list of these is the order messages, reasoning blocks and
 * tool calls happened in, which their id-keyed lists alone cannot say.
 */
export const ActivityRefSchema = z.object({
  kind: z.enum(['message', 'reasoning', 'tool']),
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

/** Separate from pending interactions so historical plans never reopen review UI. */
export const PlanHistoryEntrySchema = z.object({
  threadId: EntityIdSchema,
  turnId: EntityIdSchema,
  plan: InteractionSchema.options[2],
  state: z.enum(['pending', 'resolved', 'expired', 'cancelled']),
  outcome: PlanReviewOutcomeSchema.optional(),
})
export type PlanHistoryEntry = z.infer<typeof PlanHistoryEntrySchema>

export type EntityId = z.infer<typeof EntityIdSchema>
export type SubscriptionScope = z.infer<typeof SubscriptionScopeSchema>
export type Environment = z.infer<typeof EnvironmentSchema>
export type Workspace = z.infer<typeof WorkspaceSchema>
export type WorkspaceGit = z.infer<typeof WorkspaceGitSchema>
export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilitiesSchema>
export type Session = z.infer<typeof SessionSchema>
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export type SessionSummary = z.infer<typeof SessionSummarySchema>
export type SessionListCursor = z.infer<typeof SessionListCursorSchema>
export type HistoryCursor = z.infer<typeof HistoryCursorSchema>
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
export type TurnStart = z.infer<typeof TurnStartSchema>
export type TurnStarted = z.infer<typeof TurnStartedSchema>
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>
export type ContentBlock = z.infer<typeof ContentBlockSchema>
export type Interaction = z.infer<typeof InteractionSchema>
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>
