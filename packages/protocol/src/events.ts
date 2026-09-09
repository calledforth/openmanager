import { z } from 'zod'
import { EventEnvelopeSchema } from './envelopes.js'
import {
  EntityIdSchema,
  TimestampSchema,
  EnvironmentScopeSchema,
  SessionScopeSchema,
  ThreadScopeSchema,
  WorkspaceSchema,
  SessionSchema,
  ThreadSchema,
  TurnSchema,
  MessageSchema,
  ContentBlockSchema,
  InteractionSchema,
  InteractionResponseSchema,
} from './domains.js'

const event = <N extends string, S extends z.ZodType, P extends z.ZodType>(
  name: N,
  scope: S,
  payload: P,
) =>
  EventEnvelopeSchema.extend({
    name: z.literal(name),
    eventId: EntityIdSchema,
    timestamp: TimestampSchema,
    scope,
    payload,
  })

export const TurnFailureReasonSchema = z.enum([
  'provider_process_exited',
  'provider_process_crashed',
  'provider_error',
  'authentication_required',
  'capability_missing',
])
export type TurnFailureReason = z.infer<typeof TurnFailureReasonSchema>

export const ProofEventSchemas = {
  'workspace.updated': event(
    'workspace.updated',
    EnvironmentScopeSchema,
    z.object({ workspace: WorkspaceSchema }),
  ),
  'session.created': event(
    'session.created',
    EnvironmentScopeSchema,
    z.object({ session: SessionSchema }),
  ),
  'session.updated': event(
    'session.updated',
    EnvironmentScopeSchema,
    z.object({ sessionId: EntityIdSchema, title: z.string().nullable().optional() }),
  ),
  'session.deleted': event(
    'session.deleted',
    EnvironmentScopeSchema,
    z.object({ sessionId: EntityIdSchema }),
  ),
  'thread.created': event('thread.created', SessionScopeSchema, z.object({ thread: ThreadSchema })),
  'turn.started': event(
    'turn.started',
    ThreadScopeSchema,
    z.object({ turn: TurnSchema, userMessage: MessageSchema }),
  ),
  'turn.completed': event(
    'turn.completed',
    ThreadScopeSchema,
    z.object({ turnId: EntityIdSchema }),
  ),
  'turn.interrupted': event(
    'turn.interrupted',
    ThreadScopeSchema,
    z.object({ turnId: EntityIdSchema }),
  ),
  'turn.failed': event(
    'turn.failed',
    ThreadScopeSchema,
    z.object({
      turnId: EntityIdSchema,
      reason: TurnFailureReasonSchema,
      message: z.string(),
    }),
  ),
  'turn.notice': event(
    'turn.notice',
    ThreadScopeSchema,
    z.object({ turnId: EntityIdSchema, message: z.string() }),
  ),
  'message.delta': event(
    'message.delta',
    ThreadScopeSchema,
    z.object({
      messageId: EntityIdSchema,
      turnId: EntityIdSchema,
      role: z.enum(['user', 'assistant']),
      content: ContentBlockSchema,
    }),
  ),
  'message.reasoning': event(
    'message.reasoning',
    ThreadScopeSchema,
    z.object({
      messageId: EntityIdSchema,
      turnId: EntityIdSchema,
      phase: z.enum(['start', 'delta', 'stop']),
      content: ContentBlockSchema.optional(),
      tokens: z.number().int().nonnegative().optional(),
    }),
  ),
  'tool.updated': event(
    'tool.updated',
    ThreadScopeSchema,
    z.object({
      toolCallId: EntityIdSchema,
      turnId: EntityIdSchema,
      title: z.string().optional(),
      kind: z
        .enum([
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
        .optional(),
      status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
    }),
  ),
  'interaction.requested': event(
    'interaction.requested',
    ThreadScopeSchema,
    z.object({ turnId: EntityIdSchema, interaction: InteractionSchema }),
  ),
  'interaction.resolved': event(
    'interaction.resolved',
    ThreadScopeSchema,
    z.object({ turnId: EntityIdSchema, response: InteractionResponseSchema }),
  ),
} as const

export const ProofEventSchema = z.discriminatedUnion('name', [
  ProofEventSchemas['workspace.updated'],
  ProofEventSchemas['session.created'],
  ProofEventSchemas['session.updated'],
  ProofEventSchemas['session.deleted'],
  ProofEventSchemas['thread.created'],
  ProofEventSchemas['turn.started'],
  ProofEventSchemas['turn.completed'],
  ProofEventSchemas['turn.interrupted'],
  ProofEventSchemas['turn.failed'],
  ProofEventSchemas['turn.notice'],
  ProofEventSchemas['message.delta'],
  ProofEventSchemas['message.reasoning'],
  ProofEventSchemas['tool.updated'],
  ProofEventSchemas['interaction.requested'],
  ProofEventSchemas['interaction.resolved'],
])
export type ProofEvent = z.infer<typeof ProofEventSchema>
