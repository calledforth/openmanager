import type { ProviderCapabilities } from './capabilities.js'

export const PROVIDER_IDS = ['opencode', 'cursor', 'claude'] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export type ModelOption = {
  id: string
  displayName: string
  description?: string
  contextWindowTokens?: number
  /** The concrete model an alias row resolves to (`default` → `claude-sonnet-5`).
   *
   * Only meaningful for rows that are aliases rather than models. The composer
   * uses it to say what "Default (recommended)" currently gets you, which is
   * otherwise unknowable from the row itself. */
  resolvedModel?: string
  /** Reasoning-effort levels this model accepts, cheapest first. Empty or
   * absent means the model has no effort control at all — which is a real
   * state, not a gap: Claude's Haiku rows report no levels, and offering one
   * anyway sends a setting the CLI will ignore. */
  effortLevels?: string[]
  /** Whether this model can serve under fast mode. The toggle is global but
   * its effect is per-model, so a composer that offers it on a model without
   * support shows a control that silently does nothing. */
  supportsFastMode?: boolean
  /** Whether the classifier-driven `auto` permission mode works on this model.
   * The CLI hard-rejects `setPermissionMode('auto')` otherwise, so the mode
   * picker has to filter on this rather than let the write fail. */
  supportsAutoMode?: boolean
}

export type ModelListing = {
  availableModels?: ModelOption[]
  currentModelId?: string
}

export type ModeOption = {
  id: string
  displayName: string
  description?: string
}

export type ModeListing = {
  availableModes?: ModeOption[]
  currentModeId?: string
}

export type ProviderMetadata = {
  id: ProviderId
  displayName: string
  description?: string
  capabilities: ProviderCapabilities
  models?: ModelListing
  modes?: ModeListing
}

export type ProviderSessionInfo = {
  sessionId: string
  cwd: string
  title?: string
  updatedAt?: string
}

export type ProviderModelSelection = {
  providerId: ProviderId
  modelId: string
}
