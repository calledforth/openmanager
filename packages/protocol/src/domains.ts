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
})
export const ContentBlockSchema = z.discriminatedUnion('type', [
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
export const InteractionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    interactionId: EntityIdSchema,
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
export type WorkspaceCapabilities = z.infer<typeof WorkspaceCapabilitiesSchema>
export type Session = z.infer<typeof SessionSchema>
export type SessionStatus = z.infer<typeof SessionStatusSchema>
export type SessionSummary = z.infer<typeof SessionSummarySchema>
export type SessionListCursor = z.infer<typeof SessionListCursorSchema>
export type HistoryCursor = z.infer<typeof HistoryCursorSchema>
export type Thread = z.infer<typeof ThreadSchema>
export type Turn = z.infer<typeof TurnSchema>
export type Message = z.infer<typeof MessageSchema>
export type TurnStart = z.infer<typeof TurnStartSchema>
export type ContentBlock = z.infer<typeof ContentBlockSchema>
export type Interaction = z.infer<typeof InteractionSchema>
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>
