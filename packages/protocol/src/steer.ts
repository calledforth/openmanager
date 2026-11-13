import { z } from 'zod'
import { EntityIdSchema } from './domains.js'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

/**
 * Send a steered message now. A message steered into a running turn waits
 * for the agent's current step: a shell command, for one, always runs to its
 * end first. This ends that step instead: the environment takes the message
 * back from the provider, stops the turn as Stop does, and runs the message
 * as the next turn, ahead of anything queued.
 *
 * A message the provider has already started is not stopped: the answer is
 * the same, and the message simply arrives. One that is not `steering` (it
 * was sent, or is only queued) is a `conflict`.
 *
 * Additive: a client checks the capability before offering it, so it needs
 * no protocol version of its own.
 */
export const STEER_SEND_NOW_CAPABILITY = 'turn.steer.send_now' as const

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

export const SteerCommandSchemas = {
  [STEER_SEND_NOW_CAPABILITY]: command(
    STEER_SEND_NOW_CAPABILITY,
    z.object({ sessionId: EntityIdSchema, threadId: EntityIdSchema, queueItemId: EntityIdSchema }),
  ),
} as const

export const SteerResponseSchemas = {
  [STEER_SEND_NOW_CAPABILITY]: response(z.null()),
} as const
