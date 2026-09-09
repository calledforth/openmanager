import { z } from 'zod'
import { CommandEnvelopeSchema, EventEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'
import { EntityIdSchema, TimestampSchema } from './domains.js'

export const PROVIDER_DISCOVERY_CAPABILITY = 'provider.discovery' as const
export const PROVIDER_HEALTH_CAPABILITY = 'provider.health' as const
export const PROVIDER_PROBE_CAPABILITY = 'provider.probe' as const

export const ProviderCapabilitiesSchema = z.strictObject({
  canSetModel: z.boolean(),
  canSetMode: z.boolean(),
  canSetConfigOption: z.boolean(),
  canDeleteSession: z.boolean(),
  canLoadSession: z.boolean(),
  canListSessions: z.boolean(),
  canCancelPrompt: z.boolean(),
  supportsPlans: z.boolean(),
  supportsAvailableCommands: z.boolean(),
  supportsUsage: z.boolean(),
  supportsPermissionRequests: z.boolean(),
  supportsAuthentication: z.boolean(),
  supportsThoughtStreaming: z.boolean(),
  supportsSubtasks: z.boolean(),
  supportsExtensions: z.boolean(),
  supportsQuestions: z.boolean(),
})

export const ProviderHealthSchema = z.strictObject({
  summary: z.enum(['unknown', 'ready', 'warning', 'error', 'stopped']),
  refreshing: z.boolean(),
  install: z.enum(['unknown', 'installed', 'missing', 'unusable']),
  auth: z.enum(['unknown', 'authenticated', 'unauthenticated', 'error']),
  runtime: z.strictObject({
    state: z.enum(['never_started', 'starting', 'running', 'degraded', 'stopped', 'failed']),
    liveProcesses: z.number().int().nonnegative(),
    activeTurns: z.number().int().nonnegative(),
  }),
  lastProbe: z
    .strictObject({
      outcome: z.enum(['ok', 'degraded', 'failed', 'timeout']),
      at: TimestampSchema,
      durationMs: z.number().nonnegative(),
    })
    .nullable(),
  update: z.enum(['unknown', 'current', 'behind', 'unsupported']),
})

export const ProviderBootstrapSchema = z.strictObject({
  id: EntityIdSchema,
  displayName: z.string().min(1).max(128),
  capabilities: ProviderCapabilitiesSchema,
  health: ProviderHealthSchema,
})

export const ProviderBootstrapListSchema = z
  .array(ProviderBootstrapSchema)
  .max(64)
  .superRefine((providers, ctx) => {
    const seen = new Set<string>()
    for (const [index, provider] of providers.entries()) {
      if (seen.has(provider.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Provider IDs must be unique',
        })
      }
      seen.add(provider.id)
    }
  })

export const ProviderProbeCommandSchema = CommandEnvelopeSchema.extend({
  name: z.literal(PROVIDER_PROBE_CAPABILITY),
  payload: z.strictObject({
    providerId: EntityIdSchema,
    cwd: z.string().min(1).max(32_768),
  }),
})

export const ProviderProbeResponseSchema = ResponseEnvelopeSchema.extend({
  payload: z.strictObject({ provider: ProviderBootstrapSchema }),
})

export const ProviderHealthChangedEventSchema = EventEnvelopeSchema.extend({
  name: z.literal('provider_health_changed'),
  payload: z.strictObject({
    providerId: EntityIdSchema,
    health: ProviderHealthSchema,
  }),
})

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>
export type ProviderBootstrap = z.infer<typeof ProviderBootstrapSchema>
export type ProviderProbeCommand = z.infer<typeof ProviderProbeCommandSchema>
export type ProviderProbeResponse = z.infer<typeof ProviderProbeResponseSchema>
export type ProviderHealthChangedEvent = z.infer<typeof ProviderHealthChangedEventSchema>
