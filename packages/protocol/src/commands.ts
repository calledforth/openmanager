import { z } from 'zod'
import { CommandEnvelopeSchema, ErrorEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'
import {
  EntityIdSchema,
  EnvironmentSchema,
  WorkspaceSchema,
  WorkspaceIconDataUrlSchema,
  SessionSchema,
  SessionSummarySchema,
  SessionListCursorSchema,
  HistoryCursorSchema,
  PageLimitSchema,
  ThreadSchema,
  TurnSchema,
  TurnStartSchema,
  MessageSchema,
  ReasoningBlockSchema,
  ToolCallStateSchema,
  ActivityRefSchema,
  SubscriptionScopeSchema,
  InteractionResponseSchema,
  InteractionSchema,
  PlanHistoryEntrySchema,
  TimestampSchema,
} from './domains.js'
import { WorkspaceComposerPreferenceSchema } from './composer.js'

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })
// Advertised separately so older environments cannot silently ignore explicit routing.
export const SESSION_CREATE_EXPLICIT_CAPABILITY = 'session.create.explicit' as const
export const PLAN_BUILD_CAPABILITY = 'plan.build' as const
const TurnTextSchema = z.string().min(1)
const EmptyPayloadSchema = z.null()
const SessionTargetSchema = z.object({ sessionId: EntityIdSchema })
const ThreadTargetSchema = z.object({ sessionId: EntityIdSchema, threadId: EntityIdSchema })

export const ProofCommandSchemas = {
  'environment.get': command('environment.get', EmptyPayloadSchema),
  'workspace.list': command('workspace.list', EmptyPayloadSchema),
  // The path is environment-local text the environment validates and
  // canonicalizes; a browser has no picker for a folder on another machine.
  'workspace.add': command(
    'workspace.add',
    z.object({
      path: z.string().min(1).max(4096),
      name: z.string().trim().min(1).max(256).optional(),
    }),
  ),
  'workspace.remove': command('workspace.remove', z.object({ workspaceId: EntityIdSchema })),
  // A representative icon for the sidebar, resolved on the environment from
  // the folder itself (openmanager.json, then well-known icon files). Named by
  // ID like every workspace read (D9); a folder without one answers null.
  'workspace.icon': command('workspace.icon', z.object({ workspaceId: EntityIdSchema })),
  'session.list': command(
    'session.list',
    z.object({
      workspaceId: EntityIdSchema.optional(),
      cursor: SessionListCursorSchema.optional(),
      limit: PageLimitSchema.optional(),
    }),
  ),
  // A draft launches in one command: the environment files the draft's picks,
  // starts the provider, and runs the first turn in the picked mode. A mode
  // only takes effect on a first turn, so it needs one. Images uploaded while
  // it was a draft ride that first message, as they would on `turn.send`.
  'session.create': command(
    'session.create',
    z
      .object({
        environmentId: EntityIdSchema,
        workspaceId: EntityIdSchema,
        providerId: EntityIdSchema,
        title: z.string().max(512).optional(),
        // Empty only when an attachment carries the first message.
        firstMessage: z.string().optional(),
        /** Picks made in the draft. Filed as the workspace's "last used" before
         * the provider starts, which is what a new session is seeded from. */
        preference: WorkspaceComposerPreferenceSchema.optional(),
        /** The mode the first turn runs in, when it is not the provider's default. */
        modeId: z.string().min(1).max(1_024).optional(),
        /** Images the draft uploaded for its workspace, claimed by the new session. */
        artifactIds: z.array(EntityIdSchema).min(1).max(10).optional(),
      })
      .refine(
        (create) =>
          create.firstMessage === undefined ||
          create.firstMessage.length > 0 ||
          create.artifactIds !== undefined,
        { message: 'A first message needs text or an attachment.', path: ['firstMessage'] },
      )
      .refine((create) => create.modeId === undefined || create.firstMessage !== undefined, {
        message: 'A mode applies to the first message, so it needs one.',
        path: ['modeId'],
      })
      .refine((create) => create.artifactIds === undefined || create.firstMessage !== undefined, {
        message: 'Attachments ride the first message, so they need one.',
        path: ['artifactIds'],
      }),
  ),
  'session.open': command('session.open', SessionTargetSchema),
  'session.rename': command(
    'session.rename',
    SessionTargetSchema.extend({ title: z.string().trim().min(1).max(512).nullable() }),
  ),
  'session.delete': command('session.delete', SessionTargetSchema),
  // Settling moves a finished session out of the active list; `settled: false`
  // brings it back. Either way the change reaches every client as `session.updated`.
  // Settling a running or waiting session is a `conflict`; bringing one back never is.
  'session.settle': command('session.settle', SessionTargetSchema.extend({ settled: z.boolean() })),
  // Clears `doneAt` once the user has looked at a finished session, so every
  // client stops showing it as done. A session that is not done is a no-op.
  'session.acknowledge': command('session.acknowledge', SessionTargetSchema),
  'session.history': command(
    'session.history',
    ThreadTargetSchema.extend({
      cursor: HistoryCursorSchema.optional(),
      limit: PageLimitSchema.optional(),
    }),
  ),
  // `commandId` makes a send retryable: the environment answers a repeat of an
  // id it has already run with that same turn instead of starting a second one.
  // Optional on the wire so an older client still sends; the environment mints
  // one for itself in that case.
  'turn.send': command(
    'turn.send',
    ThreadTargetSchema.extend({
      // Empty only when an attachment carries the turn: an image, no caption.
      text: z.string(),
      commandId: EntityIdSchema.optional(),
      artifactIds: z.array(EntityIdSchema).max(10).optional(),
    }).refine((turn) => turn.text.length > 0 || (turn.artifactIds?.length ?? 0) > 0, {
      message: 'A turn needs text or an attachment.',
      path: ['text'],
    }),
  ),
  'turn.interrupt': command(
    'turn.interrupt',
    ThreadTargetSchema.extend({ turnId: EntityIdSchema }),
  ),
  // One resolve command for approvals, questions and plans; `response.kind`
  // says which. `commandId` makes it retryable the way a send is: a repeat of
  // the id that settled the interaction succeeds, while any other answer to a
  // settled interaction is a conflict. Optional so an older client still answers.
  'interaction.respond': command(
    'interaction.respond',
    ThreadTargetSchema.extend({
      response: InteractionResponseSchema,
      commandId: EntityIdSchema.optional(),
      // Accept and implement. Only valid for an accepted plan; ordinary accept
      // and reject continue to forward just the provider's review verdict.
      build: z.object({ text: TurnTextSchema, modeId: EntityIdSchema.optional() }).optional(),
    }),
  ),
  'subscription.subscribe': command(
    'subscription.subscribe',
    z.object({ scope: SubscriptionScopeSchema }),
  ),
  'subscription.unsubscribe': command(
    'subscription.unsubscribe',
    z.object({ subscriptionId: EntityIdSchema }),
  ),
} as const

export const ProofCommandSchema = z.discriminatedUnion('name', [
  ProofCommandSchemas['environment.get'],
  ProofCommandSchemas['workspace.list'],
  ProofCommandSchemas['workspace.add'],
  ProofCommandSchemas['workspace.remove'],
  ProofCommandSchemas['workspace.icon'],
  ProofCommandSchemas['session.list'],
  ProofCommandSchemas['session.create'],
  ProofCommandSchemas['session.open'],
  ProofCommandSchemas['session.rename'],
  ProofCommandSchemas['session.delete'],
  ProofCommandSchemas['session.settle'],
  ProofCommandSchemas['session.acknowledge'],
  ProofCommandSchemas['session.history'],
  ProofCommandSchemas['turn.send'],
  ProofCommandSchemas['turn.interrupt'],
  ProofCommandSchemas['interaction.respond'],
  ProofCommandSchemas['subscription.subscribe'],
  ProofCommandSchemas['subscription.unsubscribe'],
])
export type ProofCommand = z.infer<typeof ProofCommandSchema>
export type ProofCommandName = ProofCommand['name']

/** Choose by the pending command name: responses deliberately have no name field. */
export const ProofResponseSchemas = {
  'environment.get': response(z.object({ environment: EnvironmentSchema })),
  'workspace.list': response(z.object({ workspaces: z.array(WorkspaceSchema) })),
  'workspace.add': response(z.object({ workspace: WorkspaceSchema })),
  'workspace.remove': response(z.null()),
  'workspace.icon': response(z.object({ iconDataUrl: WorkspaceIconDataUrlSchema.nullable() })),
  'session.list': response(
    z.object({
      sessions: z.array(SessionSummarySchema),
      nextCursor: SessionListCursorSchema.nullable(),
    }),
  ),
  'session.create': response(
    z.object({
      session: SessionSchema,
      thread: ThreadSchema,
      // Absent on older environments and when no first message was requested.
      firstTurn: TurnStartSchema.optional(),
    }),
  ),
  'session.open': response(
    z.object({
      session: SessionSummarySchema,
      threads: z.array(ThreadSchema),
    }),
  ),
  'session.rename': response(z.object({ session: SessionSchema })),
  'session.delete': response(z.null()),
  'session.settle': response(z.object({ settledAt: TimestampSchema.nullable() })),
  'session.acknowledge': response(z.null()),
  'session.history': response(
    z.object({
      messages: z.array(MessageSchema),
      turns: z.array(TurnSchema),
      interactions: z.array(z.object({ threadId: EntityIdSchema, interaction: InteractionSchema })),
      plans: z.array(PlanHistoryEntrySchema).optional(),
      /**
       * The reasoning blocks and tool calls of the turns on this page, and the
       * order they and the page's messages happened in. Absent from an older
       * environment, which keeps messages only.
       */
      reasoning: z.array(ReasoningBlockSchema).optional(),
      tools: z.array(ToolCallStateSchema).optional(),
      order: z.array(ActivityRefSchema).optional(),
      nextCursor: HistoryCursorSchema.nullable(),
    }),
  ),
  'turn.send': response(TurnStartSchema),
  'turn.interrupt': response(z.object({ turnId: EntityIdSchema })),
  'interaction.respond': response(z.null()),
  'subscription.subscribe': response(
    z.object({ subscriptionId: EntityIdSchema, scope: SubscriptionScopeSchema }),
  ),
  'subscription.unsubscribe': response(z.null()),
} as const satisfies Record<ProofCommandName, z.ZodType>

export type ProofResponse<N extends ProofCommandName = ProofCommandName> = z.infer<
  (typeof ProofResponseSchemas)[N]
>
export type ProofResult<N extends ProofCommandName = ProofCommandName> =
  ProofResponse<N> | (z.infer<typeof ErrorEnvelopeSchema> & { requestId: string })

/** Validate a terminal result against its pending command, including correlation. */
export function parseProofResult<N extends ProofCommandName>(
  pending: { name: N; requestId: string },
  input: unknown,
): ProofResult<N> {
  const result = z.union([ProofResponseSchemas[pending.name], ErrorEnvelopeSchema]).parse(input)
  if (result.requestId !== pending.requestId)
    throw new Error('Protocol result does not match the pending request ID')
  return result as ProofResult<N>
}
