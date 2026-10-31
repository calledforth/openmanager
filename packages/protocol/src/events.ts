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
  SessionSummarySchema,
  SessionStatusSchema,
  InteractionKindSchema,
  ThreadSchema,
  TurnStartedSchema,
  TurnFailureReasonSchema,
  TurnInterruptionSchema,
  BackgroundTaskListSchema,
  ContentBlockSchema,
  ToolCallStateSchema,
  InteractionSchema,
  InteractionResponseSchema,
} from './domains.js'
import {
  ComposerListingSchema,
  ComposerPreferenceTargetSchema,
  PreferenceRevisionSchema,
  ProviderComposerProfileSchema,
  SessionComposerStateSchema,
  WorkspaceComposerPreferenceSchema,
} from './composer.js'
import { DraftSchema, DraftTombstoneSchema } from './drafts.js'

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

/**
 * The shape of stored events. Bump it whenever any event schema below
 * changes; `tests/event-format.test.ts` pins a digest per version, and a
 * server whose log was written under an older version raises every stream's
 * replay floor at boot, so no stored event is replayed in a form this
 * version cannot state (docs/sync-foundations.md §4.7.7).
 */
export const EVENT_FORMAT_VERSION = 3 as const

/** A turn's state once an interaction event is applied: still asking, or running again. */
export const InteractionTurnStateSchema = z.enum(['running', 'waiting'])

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
  /**
   * The whole sidebar row, as the projection writes it: provider, status and
   * time included, in the canonical form a listing reads back (null settle
   * and done times, no activity), so a client that only hears this event
   * holds what a fresh load would (docs/sync-foundations.md §4.7.2).
   */
  'session.created': event(
    'session.created',
    EnvironmentScopeSchema,
    z.object({ session: SessionSummarySchema }),
  ),
  'session.updated': event(
    'session.updated',
    EnvironmentScopeSchema,
    z.object({
      sessionId: EntityIdSchema,
      title: z.string().nullable().optional(),
      titleSource: SessionTitleSourceSchema.optional(),
      status: SessionStatusSchema.optional(),
      /**
       * Present when the session's activity time moved: its place in the
       * list. A title never moves it. The client reads it only from here.
       */
      updatedAt: TimestampSchema.optional(),
      /** Present only when the session was settled (a time) or brought back (null). */
      settledAt: TimestampSchema.nullable().optional(),
      /** Present only when a turn completed (a time) or the user acknowledged it (null). */
      doneAt: TimestampSchema.nullable().optional(),
      /** Present only when the session's background work changed: every task still running. */
      backgroundTasks: BackgroundTaskListSchema.optional(),
      /**
       * A status carries these when they apply to it, and a status without
       * them clears them. See `SessionSummary`.
       */
      waitingOn: InteractionKindSchema.nullable().optional(),
      inBackground: z.boolean().optional(),
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
  /**
   * What a provider last listed in this workspace, which a new chat there
   * offers until it has a session of its own. Names only the fields that
   * changed: settings are relisted on a model switch, commands hardly ever.
   */
  'composer.listing.updated': event(
    'composer.listing.updated',
    EnvironmentScopeSchema,
    ComposerPreferenceTargetSchema.extend(ComposerListingSchema.shape),
  ),
  /**
   * The remembered selection a new draft in this workspace opens with, and
   * the revision this change gave it.
   */
  'composer.preferences.updated': event(
    'composer.preferences.updated',
    EnvironmentScopeSchema,
    ComposerPreferenceTargetSchema.extend({
      preference: WorkspaceComposerPreferenceSchema,
      revision: PreferenceRevisionSchema,
    }),
  ),
  /**
   * A composer draft as last saved, by any paired client. The whole draft, so
   * applying one twice is safe and the newest revision wins.
   */
  'draft.saved': event('draft.saved', EnvironmentScopeSchema, z.object({ draft: DraftSchema })),
  /**
   * A draft was sent or discarded. `sessionId` names the session whose draft
   * was cleared; it is null for a new-session draft, which is gone for good.
   */
  'draft.deleted': event(
    'draft.deleted',
    EnvironmentScopeSchema,
    DraftTombstoneSchema.extend({ sessionId: EntityIdSchema.nullable() }),
  ),
  /** A provider's models, modes or defaults as the environment last learned them. */
  'provider.catalog.updated': event(
    'provider.catalog.updated',
    EnvironmentScopeSchema,
    z.object({ profile: ProviderComposerProfileSchema }),
  ),
  'thread.created': event('thread.created', SessionScopeSchema, z.object({ thread: ThreadSchema })),
  /**
   * What the provider offers this chat. Thread scope, so only a browser with
   * the chat open receives it. Names only the fields that changed, each whole,
   * so a model switch does not store the commands again and applying one twice
   * is safe. An empty list is a change like any other.
   */
  'thread.listing.updated': event(
    'thread.listing.updated',
    ThreadScopeSchema,
    ComposerListingSchema,
  ),
  'turn.started': event(
    'turn.started',
    ThreadScopeSchema,
    TurnStartedSchema.refine((started) => started.turn.startedAt !== undefined, {
      message: 'The server always says when a turn started.',
      path: ['turn', 'startedAt'],
    }),
  ),
  'turn.completed': event(
    'turn.completed',
    ThreadScopeSchema,
    z.object({ turnId: EntityIdSchema }),
  ),
  'turn.interrupted': event(
    'turn.interrupted',
    ThreadScopeSchema,
    z.object({ turnId: EntityIdSchema, reason: TurnInterruptionSchema }),
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
    z.object({
      turnId: EntityIdSchema,
      interaction: InteractionSchema,
      turnState: InteractionTurnStateSchema,
    }),
  ),
  'interaction.resolved': event(
    'interaction.resolved',
    ThreadScopeSchema,
    z.object({
      turnId: EntityIdSchema,
      response: InteractionResponseSchema,
      resolvedByClientId: EntityIdSchema.nullable().optional(),
      turnState: InteractionTurnStateSchema,
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
      turnState: InteractionTurnStateSchema,
    }),
  ),
  /**
   * The server closed a request nobody answered: its turn ended
   * (`turn_ended`) or the server restarted (`server_restarted`). Written
   * before the turn's terminal event, in the same transaction.
   */
  'interaction.cancelled': event(
    'interaction.cancelled',
    ThreadScopeSchema,
    z.object({
      turnId: EntityIdSchema,
      response: InteractionResponseSchema.refine(
        (response) =>
          response.outcome.outcome === 'cancelled' &&
          (response.outcome.reason === 'turn_ended' ||
            response.outcome.reason === 'server_restarted'),
        'A cancelled interaction must say why the server cancelled it',
      ),
      turnState: InteractionTurnStateSchema,
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
  ProofEventSchemas['composer.listing.updated'],
  ProofEventSchemas['composer.preferences.updated'],
  ProofEventSchemas['provider.catalog.updated'],
  ProofEventSchemas['draft.saved'],
  ProofEventSchemas['draft.deleted'],
  ProofEventSchemas['thread.created'],
  ProofEventSchemas['thread.listing.updated'],
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
  ProofEventSchemas['interaction.cancelled'],
])
export type ProofEvent = z.infer<typeof ProofEventSchema>
