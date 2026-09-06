import { z } from 'zod'
import {
  CommandEnvelopeSchema,
  ResponseEnvelopeSchema,
  ErrorEnvelopeSchema,
  EventEnvelopeSchema,
} from './envelopes.js'
import {
  EntityIdSchema,
  SubscriptionScopeSchema,
  EnvironmentScopeSchema,
  SessionScopeSchema,
  ThreadScopeSchema,
  EnvironmentSchema,
  WorkspaceSchema,
  SessionSchema,
  ThreadSchema,
  TurnSchema,
  MessageSchema,
  ContentBlockSchema,
  InteractionSchema,
  type SubscriptionScope,
} from './domains.js'
import { ProofEventSchema, ProofEventSchemas } from './events.js'

export const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const CursorSchema = z.object({
  scope: SubscriptionScopeSchema,
  /** A new generation whenever the host cannot preserve this scope's sequence history. */
  epoch: EntityIdSchema,
  /** Last applied event, inclusive. Zero represents the empty stream. */
  sequence: SequenceSchema,
})
export type Cursor = z.infer<typeof CursorSchema>

export function sameScope(left: SubscriptionScope, right: SubscriptionScope): boolean {
  if (left.type !== right.type || left.environmentId !== right.environmentId) return false
  if (left.type === 'environment') return true
  if (right.type === 'environment' || left.sessionId !== right.sessionId) return false
  return left.type !== 'thread' || (right.type === 'thread' && left.threadId === right.threadId)
}

export const DurableEventSchema = z
  .object({
    cursor: CursorSchema.extend({ sequence: SequenceSchema.min(1) }),
    event: ProofEventSchema,
  })
  .superRefine((record, ctx) => {
    if (!sameScope(record.cursor.scope, record.event.scope)) {
      ctx.addIssue({
        code: 'custom',
        path: ['event', 'scope'],
        message: 'Event scope must match its cursor',
      })
    }
    if (record.event.name === 'turn.notice') {
      ctx.addIssue({
        code: 'custom',
        path: ['event', 'name'],
        message: 'Transient notices do not receive durable cursors',
      })
    }
  })
export type DurableEvent = z.infer<typeof DurableEventSchema>

export const SnapshotReasonSchema = z.enum([
  'initial',
  'gap_expired',
  'cursor_ahead',
  'stream_reset',
])
export type SnapshotReason = z.infer<typeof SnapshotReasonSchema>

const EnvironmentSnapshotSchema = z
  .object({
    cursor: CursorSchema.extend({ scope: EnvironmentScopeSchema }),
    state: z.object({
      environment: EnvironmentSchema,
      workspaces: z.array(WorkspaceSchema),
      sessions: z.array(SessionSchema),
    }),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.cursor.scope.environmentId !== snapshot.state.environment.environmentId) {
      ctx.addIssue({
        code: 'custom',
        path: ['state', 'environment'],
        message: 'Snapshot environment must match its scope',
      })
    }
  })
const SessionSnapshotSchema = z
  .object({
    cursor: CursorSchema.extend({ scope: SessionScopeSchema }),
    state: z.object({ session: SessionSchema, threads: z.array(ThreadSchema) }),
  })
  .superRefine((snapshot, ctx) => {
    const id = snapshot.cursor.scope.sessionId
    if (
      snapshot.state.session.sessionId !== id ||
      snapshot.state.threads.some((thread) => thread.sessionId !== id)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Snapshot resources must belong to its session',
      })
    }
  })
const ThreadSnapshotSchema = z
  .object({
    cursor: CursorSchema.extend({ scope: ThreadScopeSchema }),
    state: z.object({
      thread: ThreadSchema,
      turns: z.array(TurnSchema),
      messages: z.array(MessageSchema),
      reasoning: z.array(
        z.object({
          messageId: EntityIdSchema,
          turnId: EntityIdSchema,
          phase: z.enum(['start', 'delta', 'stop']),
          content: z.array(ContentBlockSchema),
          tokens: z.number().int().nonnegative().optional(),
        }),
      ),
      tools: z.array(ProofEventSchemas['tool.updated'].shape.payload),
      interactions: z.array(z.object({ turnId: EntityIdSchema, interaction: InteractionSchema })),
    }),
  })
  .superRefine((snapshot, ctx) => {
    const scope = snapshot.cursor.scope
    const state = snapshot.state
    if (
      state.thread.threadId !== scope.threadId ||
      state.thread.sessionId !== scope.sessionId ||
      state.turns.some((turn) => turn.threadId !== scope.threadId) ||
      state.messages.some((message) => message.threadId !== scope.threadId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Snapshot resources must belong to its thread',
      })
    }
    const turnIds = new Set(state.turns.map((turn) => turn.turnId))
    const referencedTurns = [
      ...state.messages,
      ...state.reasoning,
      ...state.tools,
      ...state.interactions,
    ]
    if (referencedTurns.some((item) => !turnIds.has(item.turnId))) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Snapshot references a missing turn',
      })
    }
  })

export const ScopeSnapshotSchema = z.union([
  EnvironmentSnapshotSchema,
  SessionSnapshotSchema,
  ThreadSnapshotSchema,
])
export type ScopeSnapshot = z.infer<typeof ScopeSnapshotSchema>

export const ReplayCommandSchema = CommandEnvelopeSchema.extend({
  name: z.literal('subscription.replay'),
  payload: z.object({ scope: SubscriptionScopeSchema, cursor: CursorSchema.nullable() }),
}).superRefine((command, ctx) => {
  if (command.payload.cursor && !sameScope(command.payload.scope, command.payload.cursor.scope)) {
    ctx.addIssue({
      code: 'custom',
      path: ['payload', 'cursor', 'scope'],
      message: 'Cursor belongs to a different environment or scope',
    })
  }
})
export type ReplayCommand = z.infer<typeof ReplayCommandSchema>

const ReplayPayloadSchema = z
  .object({
    mode: z.literal('replay'),
    subscriptionId: EntityIdSchema,
    from: CursorSchema,
    to: CursorSchema,
    events: z.array(DurableEventSchema),
  })
  .superRefine((payload, ctx) => {
    const { from, to, events } = payload
    const invalidRange =
      !sameScope(from.scope, to.scope) ||
      from.epoch !== to.epoch ||
      to.sequence - from.sequence !== events.length
    const eventIds = new Set<string>()
    const invalidEvent = events.some((record, index) => {
      const duplicate = eventIds.has(record.event.eventId)
      eventIds.add(record.event.eventId)
      return (
        duplicate ||
        !sameScope(from.scope, record.cursor.scope) ||
        record.cursor.epoch !== from.epoch ||
        record.cursor.sequence !== from.sequence + index + 1
      )
    })
    if (invalidRange || invalidEvent) {
      ctx.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'Replay must contain exactly the contiguous range (from, to] without duplicates',
      })
    }
  })
const SnapshotPayloadSchema = z.object({
  mode: z.literal('snapshot'),
  subscriptionId: EntityIdSchema,
  reason: SnapshotReasonSchema,
  snapshot: ScopeSnapshotSchema,
})
export const ReplayResponseSchema = ResponseEnvelopeSchema.extend({
  payload: z.discriminatedUnion('mode', [ReplayPayloadSchema, SnapshotPayloadSchema]),
})
export type ReplayResponse = z.infer<typeof ReplayResponseSchema>

/** Live delivery for a recovered subscription; sequences belong to scopes, not sockets. */
export const SubscriptionEventSchema = EventEnvelopeSchema.extend({
  name: z.literal('subscription.event'),
  payload: z.object({ subscriptionId: EntityIdSchema, record: DurableEventSchema }),
})
export type SubscriptionEvent = z.infer<typeof SubscriptionEventSchema>

/** Runtime can turn this into a correlated validation error without exposing a foreign snapshot. */
export class ReplayCursorError extends Error {
  readonly code = 'validation' as const
  constructor(message: string) {
    super(message)
    this.name = 'ReplayCursorError'
  }
}
export type ReplayDecision = { mode: 'replay' } | { mode: 'snapshot'; reason: SnapshotReason }

/** Retention boundaries are captured atomically with head by the execution host. */
export function decideReplay(
  scope: SubscriptionScope,
  cursor: Cursor | null,
  head: Cursor,
  oldestAvailableSequence: number | null,
): ReplayDecision {
  const requested = SubscriptionScopeSchema.parse(scope)
  const current = CursorSchema.parse(head)
  const previous = cursor === null ? null : CursorSchema.parse(cursor)
  if (!sameScope(requested, current.scope) || (previous && !sameScope(requested, previous.scope))) {
    throw new ReplayCursorError('Cursor belongs to a different environment or scope')
  }
  // null means no events retained, including an empty stream. No head+1 sentinel.
  if (
    oldestAvailableSequence !== null &&
    (!Number.isSafeInteger(oldestAvailableSequence) ||
      oldestAvailableSequence < 1 ||
      oldestAvailableSequence > current.sequence)
  ) {
    throw new ReplayCursorError('Invalid retention boundary')
  }
  if (!previous) return { mode: 'snapshot', reason: 'initial' }
  if (previous.epoch !== current.epoch) return { mode: 'snapshot', reason: 'stream_reset' }
  if (previous.sequence > current.sequence) return { mode: 'snapshot', reason: 'cursor_ahead' }
  if (
    oldestAvailableSequence === null
      ? previous.sequence < current.sequence
      : previous.sequence < oldestAvailableSequence - 1
  )
    return { mode: 'snapshot', reason: 'gap_expired' }
  return { mode: 'replay' }
}

/** Validate the result against the actual reconnect request, not just its wire shape. */
export function parseReplayResult(command: ReplayCommand, input: unknown) {
  const pending = ReplayCommandSchema.parse(command)
  const result = z.union([ReplayResponseSchema, ErrorEnvelopeSchema]).parse(input)
  if (result.requestId !== pending.requestId)
    throw new ReplayCursorError('Replay result request ID does not match')
  if (result.type === 'error') return result
  const payload = result.payload
  const resultCursor = payload.mode === 'snapshot' ? payload.snapshot.cursor : payload.to
  if (!sameScope(pending.payload.scope, resultCursor.scope))
    throw new ReplayCursorError('Replay result scope does not match')
  const previous = pending.payload.cursor
  if (payload.mode === 'replay') {
    if (
      !previous ||
      payload.from.epoch !== previous.epoch ||
      payload.from.sequence !== previous.sequence
    ) {
      throw new ReplayCursorError('Replay starts at a different cursor')
    }
  } else {
    const reason = payload.reason
    const validReason =
      reason === 'initial'
        ? previous === null
        : previous !== null &&
          (reason === 'stream_reset'
            ? previous.epoch !== resultCursor.epoch
            : previous.epoch === resultCursor.epoch &&
              (reason === 'cursor_ahead'
                ? previous.sequence > resultCursor.sequence
                : previous.sequence < resultCursor.sequence))
    if (!validReason)
      throw new ReplayCursorError('Snapshot reason contradicts the requested cursor')
  }
  return result
}
