import { z } from 'zod'
import { CommandEnvelopeSchema, ErrorEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'
import {
  EntityIdSchema,
  EnvironmentSchema,
  WorkspaceSchema,
  SessionSchema,
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
const EmptyPayloadSchema = z.null()
const SessionTargetSchema = z.object({ sessionId: EntityIdSchema })
const ThreadTargetSchema = z.object({ sessionId: EntityIdSchema, threadId: EntityIdSchema })

export const ProofCommandSchemas = {
  'environment.get': command('environment.get', EmptyPayloadSchema),
  'workspace.list': command('workspace.list', EmptyPayloadSchema),
  'session.list': command('session.list', z.object({ workspaceId: EntityIdSchema })),
  'session.create': command(
    'session.create',
    z.object({ workspaceId: EntityIdSchema, title: z.string().max(512).optional() }),
  ),
  'session.open': command('session.open', SessionTargetSchema),
  'turn.send': command('turn.send', ThreadTargetSchema.extend({ text: z.string().min(1) })),
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
  ProofCommandSchemas['session.list'],
  ProofCommandSchemas['session.create'],
  ProofCommandSchemas['session.open'],
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
  'session.list': response(z.object({ sessions: z.array(SessionSchema) })),
  'session.create': response(z.object({ session: SessionSchema, thread: ThreadSchema })),
  'session.open': response(
    z.object({
      session: SessionSchema,
      threads: z.array(ThreadSchema),
      messages: z.array(MessageSchema),
      turns: z.array(TurnSchema),
      interactions: z.array(z.object({ threadId: EntityIdSchema, interaction: InteractionSchema })),
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
