import { z } from 'zod'
import { CommandEnvelopeSchema, EventEnvelopeSchema, ResponseEnvelopeSchema } from './envelopes.js'
import { EntityIdSchema, TimestampSchema } from './domains.js'

export const PROVIDER_DISCOVERY_CAPABILITY = 'provider.discovery' as const
export const PROVIDER_HEALTH_CAPABILITY = 'provider.health' as const
export const PROVIDER_PROBE_CAPABILITY = 'provider.probe' as const
/** Provider entries carry `limits`, `provider_limits_changed` is broadcast,
 * and `provider.limits.refresh` reads them again. */
export const PROVIDER_LIMITS_REFRESH_CAPABILITY = 'provider.limits.refresh' as const

export const ProviderCapabilitiesSchema = z.strictObject({
  canSetModel: z.boolean(),
  canSetMode: z.boolean(),
  canSetConfigOption: z.boolean(),
  canDeleteSession: z.boolean(),
  canLoadSession: z.boolean(),
  canListSessions: z.boolean(),
  canCancelPrompt: z.boolean(),
  /** A message sent mid-turn can join the running turn (`turn.steer`). */
  canSteer: z.boolean(),
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
  /**
   * A session could start on this provider now: the server's rule
   * (`ready` or `warning`), so every client offers the same providers.
   */
  available: z.boolean(),
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

/** One usage-limit window of a provider's plan: Claude's 5-hour session, its
 * weekly allowance, a per-model weekly allowance. */
export const ProviderLimitWindowSchema = z.strictObject({
  /** Stable for the provider: `five_hour`, `seven_day`, `model:<name>`. */
  id: z.string().min(1).max(128),
  /** Display text, decided by the server so every client says the same. */
  label: z.string().min(1).max(128),
  group: z.enum(['session', 'weekly', 'other']),
  /** Percent of the window used, 0–100. Null when the provider gave no number. */
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: TimestampSchema.nullable(),
  /** The provider's own verdict when it gave one: `limited` means turns are
   * refused until `resetsAt`. Null when only a number is known. */
  status: z.enum(['ok', 'warning', 'limited']).nullable(),
})

/** Pay-as-you-go usage past the plan's allowance. */
export const ProviderExtraUsageSchema = z.strictObject({
  enabled: z.boolean(),
  /** Percent of the monthly spend limit used, when one is set. */
  usedPercent: z.number().min(0).max(100).nullable(),
})

export const ProviderLimitsReadingSchema = z.strictObject({
  windows: z.array(ProviderLimitWindowSchema).max(32),
  extraUsage: ProviderExtraUsageSchema.nullable(),
  /** When these numbers were read, or last moved by a live session. */
  at: TimestampSchema,
})

/**
 * A provider's usage limits as the environment last knew them. The reading is
 * kept across restarts and carries its age: limits are only read on request
 * (a throwaway CLI, about a minute) and nudged by live sessions in between.
 */
export const ProviderLimitsSchema = z.strictObject({
  /** False for a provider with no way to report limits: nothing to show or refresh. */
  supported: z.boolean(),
  reading: ProviderLimitsReadingSchema.nullable(),
  refreshing: z.boolean(),
  /** The last refresh attempt. `unavailable`: the account has no plan limits
   * (an API key, say), so there is nothing to read. */
  lastRefresh: z
    .strictObject({
      outcome: z.enum(['ok', 'unavailable', 'failed']),
      at: TimestampSchema,
    })
    .nullable(),
})

export const ProviderBootstrapSchema = z.strictObject({
  id: EntityIdSchema,
  displayName: z.string().min(1).max(128),
  capabilities: ProviderCapabilitiesSchema,
  health: ProviderHealthSchema,
  limits: ProviderLimitsSchema,
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
    /** A server-assigned workspace ID; the server resolves the directory (D9). */
    workspaceId: EntityIdSchema,
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

/**
 * Read a provider's limits again. Answers at once with the current state
 * (`refreshing` while the read runs); the result arrives as
 * `provider_limits_changed`. A reading younger than `maxAgeMs` is kept as is,
 * and the server holds its own floor so a client cannot make it spawn a CLI
 * on every call.
 */
export const ProviderLimitsRefreshCommandSchema = CommandEnvelopeSchema.extend({
  name: z.literal(PROVIDER_LIMITS_REFRESH_CAPABILITY),
  payload: z.strictObject({
    providerId: EntityIdSchema,
    maxAgeMs: z.number().int().min(0).max(86_400_000).optional(),
  }),
})

export const ProviderLimitsRefreshResponseSchema = ResponseEnvelopeSchema.extend({
  payload: z.strictObject({ providerId: EntityIdSchema, limits: ProviderLimitsSchema }),
})

/** Broadcast like health: a current reading, with no cursor. */
export const ProviderLimitsChangedEventSchema = EventEnvelopeSchema.extend({
  name: z.literal('provider_limits_changed'),
  payload: z.strictObject({
    providerId: EntityIdSchema,
    limits: ProviderLimitsSchema,
  }),
})

export type ProviderLimitWindow = z.infer<typeof ProviderLimitWindowSchema>
export type ProviderExtraUsage = z.infer<typeof ProviderExtraUsageSchema>
export type ProviderLimitsReading = z.infer<typeof ProviderLimitsReadingSchema>
export type ProviderLimits = z.infer<typeof ProviderLimitsSchema>
export type ProviderLimitsRefreshCommand = z.infer<typeof ProviderLimitsRefreshCommandSchema>
export type ProviderLimitsRefreshResponse = z.infer<typeof ProviderLimitsRefreshResponseSchema>
export type ProviderLimitsChangedEvent = z.infer<typeof ProviderLimitsChangedEventSchema>
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>
export type ProviderBootstrap = z.infer<typeof ProviderBootstrapSchema>
export type ProviderProbeCommand = z.infer<typeof ProviderProbeCommandSchema>
export type ProviderProbeResponse = z.infer<typeof ProviderProbeResponseSchema>
export type ProviderHealthChangedEvent = z.infer<typeof ProviderHealthChangedEventSchema>
