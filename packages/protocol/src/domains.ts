import { z } from 'zod'

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
export const WorkspaceSchema = z.object({ workspaceId: EntityIdSchema, name: z.string() })
export const SessionSchema = z.object({
  sessionId: EntityIdSchema,
  workspaceId: EntityIdSchema,
  title: z.string().nullable(),
})
export const ThreadSchema = z.object({ threadId: EntityIdSchema, sessionId: EntityIdSchema })
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

export type EntityId = z.infer<typeof EntityIdSchema>
export type SubscriptionScope = z.infer<typeof SubscriptionScopeSchema>
export type Environment = z.infer<typeof EnvironmentSchema>
export type Workspace = z.infer<typeof WorkspaceSchema>
export type Session = z.infer<typeof SessionSchema>
export type Thread = z.infer<typeof ThreadSchema>
export type Turn = z.infer<typeof TurnSchema>
export type Message = z.infer<typeof MessageSchema>
export type ContentBlock = z.infer<typeof ContentBlockSchema>
export type Interaction = z.infer<typeof InteractionSchema>
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>
