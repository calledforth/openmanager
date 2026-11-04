import { z } from 'zod'
import { EnvironmentSchema } from './domains.js'
import { CommandEnvelopeSchema, EventEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'

/**
 * Renaming the environment itself: the name every device shows for it. Only
 * the name changes. Sessions, drafts, routes and paired devices all belong to
 * the environment's ID, so none of them notice.
 *
 * An environment advertises the capability when it can be renamed; a client
 * offers renaming only then.
 */
export const ENVIRONMENT_RENAME_CAPABILITY = 'environment.rename' as const
/**
 * Sent to every connection once the environment's name changes, so each
 * device shows the new one without reconnecting. A current reading, not
 * history: a client that was away reads the name from bootstrap instead.
 */
export const ENVIRONMENT_CHANGED_EVENT = 'environment.changed' as const

/** The longest name an environment can be given: the cap its identity file has. */
export const ENVIRONMENT_NAME_MAX_LENGTH = 128

/**
 * An environment's name as a person sets it. The same rules as a device's:
 * surrounding space is dropped, it must still say something, and control and
 * format characters are refused, so one machine's name cannot be made to read
 * as another's.
 */
export const EnvironmentNameSchema = z
  .string()
  .trim()
  .min(1, 'A name is required.')
  .max(
    ENVIRONMENT_NAME_MAX_LENGTH,
    `A name can be at most ${ENVIRONMENT_NAME_MAX_LENGTH} characters.`,
  )
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'A name cannot contain control or format characters.')

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

export const EnvironmentNameCommandSchemas = {
  [ENVIRONMENT_RENAME_CAPABILITY]: command(
    ENVIRONMENT_RENAME_CAPABILITY,
    z.strictObject({ label: EnvironmentNameSchema }),
  ),
} as const

export const EnvironmentNameResponseSchemas = {
  [ENVIRONMENT_RENAME_CAPABILITY]: response(z.strictObject({ environment: EnvironmentSchema })),
} as const

export const EnvironmentChangedEventSchema = EventEnvelopeSchema.extend({
  name: z.literal(ENVIRONMENT_CHANGED_EVENT),
  payload: z.object({ environment: EnvironmentSchema }),
})

export type EnvironmentChangedEvent = z.infer<typeof EnvironmentChangedEventSchema>
export type EnvironmentNameCommandName = keyof typeof EnvironmentNameCommandSchemas
