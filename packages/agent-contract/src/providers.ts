import type { ProviderCapabilities } from './capabilities.js'

export type ProviderId = 'opencode' | 'cursor'

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
