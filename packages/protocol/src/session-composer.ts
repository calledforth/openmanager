import { z } from 'zod'

const id = z.string().min(1).max(1_024)
const label = z.string().min(1).max(512)
const description = z.string().max(8_192).optional()

export const ComposerConfigValueSchema = z.union([z.string().max(8_192), z.boolean()])
export const ComposerConfigValuesSchema = z.record(id, ComposerConfigValueSchema)

/** A setting the provider offers on a live session, with the value it reports. */
export const ComposerConfigOptionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('select'),
    id,
    name: label,
    description,
    category: z.string().max(128).optional(),
    currentValue: z.string().max(8_192),
    options: z
      .array(z.strictObject({ value: z.string().max(8_192), name: label, description }))
      .max(256),
  }),
  z.strictObject({
    type: z.literal('boolean'),
    id,
    name: label,
    description,
    category: z.string().max(128).optional(),
    currentValue: z.boolean(),
  }),
])

/**
 * A slash command the provider offers on a live session. Invoking one is plain
 * prompt text (`/name …`), so the listing is all a client needs.
 */
export const ComposerCommandOptionSchema = z.strictObject({
  name: z.string().min(1).max(256),
  description: z.string().max(8_192),
  /** Hint for the free text a command takes after its name. */
  placeholder: z.string().max(512).optional(),
})

/**
 * How full the session's context window is, as the provider last reported it.
 * `size` is never zero: a meter without a denominator is not a meter.
 */
export const ComposerUsageSchema = z.strictObject({
  used: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  /** Cumulative cost of the session so far. */
  cost: z
    .strictObject({ amount: z.number().nonnegative(), currency: z.string().min(1).max(16) })
    .optional(),
})

/**
 * What one session's composer shows. The selection belongs to the session:
 * two sessions in one workspace can run different models. The workspace
 * preference only seeds a session that has no selection of its own yet.
 *
 * `modelId` and `configValues` are the user's choice, which the environment
 * re-applies before a prompt. `modeId` follows the provider, which may switch
 * modes itself mid-turn. `configOptions` and `availableCommands` are the
 * provider's latest listings. `usage` is the provider's latest reading; a
 * provider that reports none leaves it absent, and the composer shows no meter.
 */
export const SessionComposerStateSchema = z.strictObject({
  modelId: id.optional(),
  modeId: id.optional(),
  configValues: ComposerConfigValuesSchema.optional(),
  configOptions: z.array(ComposerConfigOptionSchema).max(256).optional(),
  availableCommands: z.array(ComposerCommandOptionSchema).max(1_024).optional(),
  usage: ComposerUsageSchema.optional(),
})

export type ComposerConfigValue = z.infer<typeof ComposerConfigValueSchema>
export type ComposerConfigOption = z.infer<typeof ComposerConfigOptionSchema>
export type ComposerCommandOption = z.infer<typeof ComposerCommandOptionSchema>
export type ComposerUsage = z.infer<typeof ComposerUsageSchema>
export type SessionComposerState = z.infer<typeof SessionComposerStateSchema>
