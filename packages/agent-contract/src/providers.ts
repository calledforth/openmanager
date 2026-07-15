import type { ProviderCapabilities } from './capabilities.js'

export const PROVIDER_IDS = ['opencode', 'cursor'] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export type ModelOption = {
  id: string
  displayName: string
  description?: string
  contextWindowTokens?: number
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

export type ProviderModelSelection = {
  providerId: ProviderId
  modelId: string
}
