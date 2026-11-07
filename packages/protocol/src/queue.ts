import { z } from 'zod'
import { EntityIdSchema, TimestampSchema } from './domains.js'
import { ComposerConfigValuesSchema } from './session-composer.js'

/**
 * How many messages one chat can hold back at a time. The whole queue travels
 * in every `thread.queue.updated` and in the chat's snapshot, and each message
 * can carry a prompt's worth of text, so the bound keeps one change event a
 * small frame. Nobody types twenty messages ahead of an agent.
 */
export const THREAD_QUEUE_MAX = 20

/** Images one queued message can carry: the same bound `turn.send` has. */
export const QUEUED_MESSAGE_ARTIFACTS_MAX = 10

/**
 * The composer selection a message was sent with. A queued message runs with
 * it, not with whatever the composer shows when its turn comes. The mode is not
 * captured: it is the session's live state, which the agent changes itself (a
 * plan approved into build), and setting a captured mode would undo that.
 */
export const QueuedMessageSettingsSchema = z.strictObject({
  modelId: EntityIdSchema.optional(),
  configValues: ComposerConfigValuesSchema.optional(),
})

/**
 * A message waiting for its turn.
 *
 * `delivery` says where it is. `queued`: it waits here until the running turn
 * ends, then runs as the next turn. `steering`: it was handed to the provider
 * to join the running turn at the agent's next step; it leaves the queue when
 * the provider takes it (and shows in that turn), or comes back as `queued`
 * when the provider gives it back (the turn was stopped first).
 */
export const QueuedMessageSchema = z.strictObject({
  /** The id the client minted for it; a drained message's turn carries it as `commandId`. */
  queueItemId: EntityIdSchema,
  text: z.string(),
  artifactIds: z.array(EntityIdSchema).max(QUEUED_MESSAGE_ARTIFACTS_MAX).optional(),
  settings: QueuedMessageSettingsSchema,
  delivery: z.enum(['queued', 'steering']),
  createdAt: TimestampSchema,
})

/**
 * Why a queue is not draining. Stop is not a reason: it ends the running turn,
 * and the next message runs. `failure`: the turn failed, or the next message
 * could not start. `restart`: the server restarted with messages waiting.
 */
export const ThreadQueuePauseSchema = z.enum(['failure', 'restart'])

/** The messages a chat holds back, in the order they will run. */
export const ThreadQueueSchema = z.strictObject({
  items: z.array(QueuedMessageSchema).max(THREAD_QUEUE_MAX),
  /** Null when the queue drains on its own as each turn completes. */
  pausedBy: ThreadQueuePauseSchema.nullable(),
})

export const EMPTY_THREAD_QUEUE = Object.freeze({ items: [], pausedBy: null }) as ThreadQueue

export type QueuedMessageSettings = z.infer<typeof QueuedMessageSettingsSchema>
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>
export type ThreadQueuePause = z.infer<typeof ThreadQueuePauseSchema>
export type ThreadQueue = z.infer<typeof ThreadQueueSchema>
