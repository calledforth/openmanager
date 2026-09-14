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
  MessageSchema,
  SubscriptionScopeSchema,
  InteractionResponseSchema,
  InteractionSchema,
} from './domains.js'

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })
// Advertised separately so older environments cannot silently ignore explicit routing.
export const SESSION_CREATE_EXPLICIT_CAPABILITY = 'session.create.explicit' as const
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
  'session.create': command(
    'session.create',
    z.object({
      environmentId: EntityIdSchema,
      workspaceId: EntityIdSchema,
      providerId: EntityIdSchema,
      title: z.string().max(512).optional(),
      firstMessage: TurnTextSchema.optional(),
    }),
  ),
  'session.open': command('session.open', SessionTargetSchema),
  'session.history': command(
    'session.history',
    ThreadTargetSchema.extend({
      cursor: HistoryCursorSchema.optional(),
      limit: PageLimitSchema.optional(),
    }),
  ),
  'turn.send': command('turn.send', ThreadTargetSchema.extend({ text: TurnTextSchema })),
  'turn.interrupt': command(
    'turn.interrupt',
    ThreadTargetSchema.extend({ turnId: EntityIdSchema }),
  ),
  'interaction.respond': command(
    'interaction.respond',
    ThreadTargetSchema.extend({ response: InteractionResponseSchema }),
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
      firstTurn: z.object({ turn: TurnSchema, userMessage: MessageSchema }).optional(),
    }),
  ),
  'session.open': response(
    z.object({
      session: SessionSummarySchema,
      threads: z.array(ThreadSchema),
    }),
  ),
  'session.history': response(
    z.object({
      messages: z.array(MessageSchema),
      turns: z.array(TurnSchema),
      interactions: z.array(z.object({ threadId: EntityIdSchema, interaction: InteractionSchema })),
      nextCursor: HistoryCursorSchema.nullable(),
    }),
  ),
  'turn.send': response(z.object({ turn: TurnSchema, userMessage: MessageSchema })),
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
