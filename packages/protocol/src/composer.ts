import { z } from 'zod'
import { CommandEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'
import { EntityIdSchema } from './domains.js'
import { ProviderBootstrapSchema } from './providers.js'

export const PROVIDER_CATALOG_CAPABILITY = 'provider.catalog.get' as const
export const COMPOSER_PREFERENCES_GET_CAPABILITY = 'composer.preferences.get' as const
export const COMPOSER_PREFERENCES_SET_CAPABILITY = 'composer.preferences.set' as const
export const COMPOSER_MODEL_SET_CAPABILITY = 'composer.model.set' as const
export const COMPOSER_MODE_SET_CAPABILITY = 'composer.mode.set' as const
export const COMPOSER_CONFIG_OPTION_SET_CAPABILITY = 'composer.config_option.set' as const

const command = <N extends string, P extends z.ZodType>(name: N, payload: P) =>
  CommandEnvelopeSchema.extend({ name: z.literal(name), payload })
const response = <P extends z.ZodType>(payload: P) => ResponseEnvelopeSchema.extend({ payload })

export const ComposerModelOptionSchema = z.strictObject({
  modelId: z.string().min(1).max(1_024),
  name: z.string().min(1).max(512),
  description: z.string().max(8_192).optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  effortLevels: z.array(z.string().min(1).max(128)).max(64).optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
})

export const ComposerModeOptionSchema = z.strictObject({
  id: z.string().min(1).max(1_024),
  name: z.string().min(1).max(512),
  description: z.string().max(8_192).optional(),
})

export const ProviderComposerProfileSchema = z.strictObject({
  providerId: EntityIdSchema,
  agentInfo: z
    .strictObject({
      name: z.string().max(512).optional(),
      version: z.string().max(512).optional(),
    })
    .optional(),
  availableModels: z.array(ComposerModelOptionSchema).max(2_048).optional(),
  availableModes: z.array(ComposerModeOptionSchema).max(256).optional(),
  defaultModelId: z.string().min(1).max(1_024).optional(),
  defaultModeId: z.string().min(1).max(1_024).optional(),
  updatedAt: z.number().int().nonnegative(),
})

export const ComposerConfigValuesSchema = z.record(
  z.string().min(1).max(1_024),
  z.union([z.string().max(8_192), z.boolean()]),
)

export const WorkspaceComposerPreferenceSchema = z.strictObject({
  modelId: z.string().min(1).max(1_024).optional(),
  modeId: z.string().min(1).max(1_024).optional(),
  configValues: ComposerConfigValuesSchema.optional(),
})

export const ProviderCatalogEntrySchema = ProviderBootstrapSchema.extend({
  profile: ProviderComposerProfileSchema.optional(),
})

const preferenceTarget = z.strictObject({
  workspaceId: EntityIdSchema,
  providerId: EntityIdSchema,
})
const sessionTarget = z.strictObject({ sessionId: EntityIdSchema })

export const ComposerCommandSchemas = {
  [PROVIDER_CATALOG_CAPABILITY]: command(PROVIDER_CATALOG_CAPABILITY, z.null()),
  [COMPOSER_PREFERENCES_GET_CAPABILITY]: command(
    COMPOSER_PREFERENCES_GET_CAPABILITY,
    preferenceTarget,
  ),
  [COMPOSER_PREFERENCES_SET_CAPABILITY]: command(
    COMPOSER_PREFERENCES_SET_CAPABILITY,
    preferenceTarget.extend({ preference: WorkspaceComposerPreferenceSchema }),
  ),
  [COMPOSER_MODEL_SET_CAPABILITY]: command(
    COMPOSER_MODEL_SET_CAPABILITY,
    sessionTarget.extend({ modelId: z.string().min(1).max(1_024) }),
  ),
  [COMPOSER_MODE_SET_CAPABILITY]: command(
    COMPOSER_MODE_SET_CAPABILITY,
    sessionTarget.extend({ modeId: z.string().min(1).max(1_024) }),
  ),
  [COMPOSER_CONFIG_OPTION_SET_CAPABILITY]: command(
    COMPOSER_CONFIG_OPTION_SET_CAPABILITY,
    sessionTarget.extend({
      configId: z.string().min(1).max(1_024),
      value: z.union([z.string().max(8_192), z.boolean()]),
    }),
  ),
} as const

export const ComposerResponseSchemas = {
  [PROVIDER_CATALOG_CAPABILITY]: response(
    z.strictObject({ providers: z.array(ProviderCatalogEntrySchema).max(64) }),
  ),
  [COMPOSER_PREFERENCES_GET_CAPABILITY]: response(
    z.strictObject({ preference: WorkspaceComposerPreferenceSchema }),
  ),
  [COMPOSER_PREFERENCES_SET_CAPABILITY]: response(
    z.strictObject({ preference: WorkspaceComposerPreferenceSchema }),
  ),
  [COMPOSER_MODEL_SET_CAPABILITY]: response(
    z.strictObject({ preference: WorkspaceComposerPreferenceSchema }),
  ),
  [COMPOSER_MODE_SET_CAPABILITY]: response(
    z.strictObject({ preference: WorkspaceComposerPreferenceSchema }),
  ),
  [COMPOSER_CONFIG_OPTION_SET_CAPABILITY]: response(
    z.strictObject({ preference: WorkspaceComposerPreferenceSchema }),
  ),
} as const

export type ComposerModelOption = z.infer<typeof ComposerModelOptionSchema>
export type ComposerModeOption = z.infer<typeof ComposerModeOptionSchema>
export type ProviderComposerProfile = z.infer<typeof ProviderComposerProfileSchema>
export type WorkspaceComposerPreference = z.infer<typeof WorkspaceComposerPreferenceSchema>
export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>
