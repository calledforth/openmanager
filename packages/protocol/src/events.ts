import { z } from 'zod'
import { SessionTitleSourceSchema } from './session-title.js'
import { EventEnvelopeSchema } from './envelopes.js'
import {
  EntityIdSchema,
  TimestampSchema,
  EnvironmentScopeSchema,
  SessionScopeSchema,
  ThreadScopeSchema,
  WorkspaceSchema,
  SessionSchema,
  SessionStatusSchema,
  ThreadSchema,
  TurnStartSchema,
  ContentBlockSchema,
  ToolCallStateSchema,
  InteractionSchema,
  InteractionResponseSchema,
} from './domains.js'
import {
  ComposerPreferenceTargetSchema,
  ProviderComposerProfileSchema,
  SessionComposerStateSchema,
  WorkspaceComposerPreferenceSchema,
} from './composer.js'

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
  'workspace.removed': event(
    'workspace.removed',
    EnvironmentScopeSchema,
    z.object({ workspaceId: EntityIdSchema }),
  ),
  'session.created': event(
    'session.created',
    EnvironmentScopeSchema,
    z.object({ session: SessionSchema }),
  ),
  'session.updated': event(
    'session.updated',
    EnvironmentScopeSchema,
    z.object({
      sessionId: EntityIdSchema,
      title: z.string().nullable().optional(),
      titleSource: SessionTitleSourceSchema.optional(),
      status: SessionStatusSchema.optional(),
    }),
  ),
  'session.deleted': event(
    'session.deleted',
    EnvironmentScopeSchema,
    z.object({ sessionId: EntityIdSchema }),
  ),
  /**
   * Composer state is pushed, not refetched: `session.updated` says nothing
   * about a selection, and a refetch cannot be replayed after a reconnect.
   * Each payload is the whole current value, so applying one twice is safe.
   */
  'session.composer.updated': event(
    'session.composer.updated',
    EnvironmentScopeSchema,
    z.object({ sessionId: EntityIdSchema, composer: SessionComposerStateSchema }),
  ),
  /** The remembered selection a new draft in this workspace opens with. */
  'composer.preferences.updated': event(
    'composer.preferences.updated',
    EnvironmentScopeSchema,
    ComposerPreferenceTargetSchema.extend({ preference: WorkspaceComposerPreferenceSchema }),
  ),
  /** A provider's models, modes or defaults as the environment last learned them. */
  'provider.catalog.updated': event(
    'provider.catalog.updated',
    EnvironmentScopeSchema,
    z.object({ profile: ProviderComposerProfileSchema }),
  ),
  'thread.created': event('thread.created', SessionScopeSchema, z.object({ thread: ThreadSchema })),
  'turn.started': event('turn.started', ThreadScopeSchema, TurnStartSchema),
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
  'tool.updated': event('tool.updated', ThreadScopeSchema, ToolCallStateSchema),
  'interaction.requested': event(
    'interaction.requested',
    ThreadScopeSchema,
    z.object({ turnId: EntityIdSchema, interaction: InteractionSchema }),
  ),
  'interaction.resolved': event(
    'interaction.resolved',
    ThreadScopeSchema,
    z.object({
      turnId: EntityIdSchema,
      response: InteractionResponseSchema,
      resolvedByClientId: EntityIdSchema.nullable().optional(),
    }),
  ),
  'interaction.expired': event(
    'interaction.expired',
    ThreadScopeSchema,
    z.object({
      turnId: EntityIdSchema,
      response: InteractionResponseSchema.refine(
        (response) =>
          response.outcome.outcome === 'cancelled' && response.outcome.reason === 'timeout',
        'An expired interaction must carry a timeout outcome',
      ),
    }),
  ),
} as const

export const ProofEventSchema = z.discriminatedUnion('name', [
  ProofEventSchemas['workspace.updated'],
  ProofEventSchemas['workspace.removed'],
  ProofEventSchemas['session.created'],
  ProofEventSchemas['session.updated'],
  ProofEventSchemas['session.deleted'],
  ProofEventSchemas['session.composer.updated'],
  ProofEventSchemas['composer.preferences.updated'],
  ProofEventSchemas['provider.catalog.updated'],
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
  ProofEventSchemas['interaction.expired'],
])
export type ProofEvent = z.infer<typeof ProofEventSchema>
