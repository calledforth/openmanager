import { isProviderId, type ProviderId } from '@agentpack/contract'

export interface ComposerModelOption {
  modelId: string
  name: string
  description?: string
  contextWindowTokens?: number
}

export interface ComposerModeOption {
  id: string
  name: string
  description?: string
}

export interface ProviderComposerProfile {
  agentInfo?: {
    name?: string
    version?: string
  }
  availableModels?: ComposerModelOption[]
  availableModes?: ComposerModeOption[]
  defaultModelId?: string
  defaultModeId?: string
  updatedAt: number
}

export interface WorkspaceComposerPreference {
  modelId?: string
  modeId?: string
}

export type ProviderComposerProfiles = Partial<Record<ProviderId, ProviderComposerProfile>>
export type WorkspaceComposerPreferences = Record<string, WorkspaceComposerPreference>

export function workspaceComposerPreferenceKey(
  workspacePath: string,
  providerId: ProviderId,
): string {
  return `${workspacePath}::${providerId}`
}

export function resolveComposerChoice<T extends { id: string }>(
  preferredIds: Array<string | undefined>,
  options: T[] | undefined,
): string | undefined {
  const availableIds = new Set(options?.map((option) => option.id) ?? [])
  for (const preferredId of preferredIds) {
    if (preferredId && availableIds.has(preferredId)) return preferredId
  }
  return options?.[0]?.id
}

export function mergeProviderComposerProfiles(
  stored: ProviderComposerProfiles,
  current: ProviderComposerProfiles,
): ProviderComposerProfiles {
  const merged = { ...stored }
  for (const providerId of Object.keys(current) as ProviderId[]) {
    const currentProfile = current[providerId]
    if (!currentProfile) continue
    merged[providerId] = {
      ...(stored[providerId] ?? {}),
      ...currentProfile,
    } as ProviderComposerProfile
  }
  return merged
}

export interface ProviderComposerProfileDoc {
  providerId: string
  agentInfo?: { name?: string; version?: string }
  availableModels?: ComposerModelOption[]
  availableModes?: ComposerModeOption[]
  defaultModelId?: string
  defaultModeId?: string
  updatedAt: number
}

export interface WorkspaceComposerPreferenceDoc {
  workspacePath: string
  providerId: string
  modelId?: string
  modeId?: string
}

export function composerProfilesFromDocs(
  docs: ProviderComposerProfileDoc[],
): ProviderComposerProfiles {
  const profiles: ProviderComposerProfiles = {}
  for (const doc of docs) {
    if (!isProviderId(doc.providerId)) continue
    profiles[doc.providerId] = {
      ...(doc.agentInfo ? { agentInfo: doc.agentInfo } : {}),
      ...(doc.availableModels?.length ? { availableModels: doc.availableModels } : {}),
      ...(doc.availableModes?.length ? { availableModes: doc.availableModes } : {}),
      ...(doc.defaultModelId ? { defaultModelId: doc.defaultModelId } : {}),
      ...(doc.defaultModeId ? { defaultModeId: doc.defaultModeId } : {}),
      updatedAt: doc.updatedAt,
    }
  }
  return profiles
}

export function composerPreferencesFromDocs(
  docs: WorkspaceComposerPreferenceDoc[],
): WorkspaceComposerPreferences {
  const preferences: WorkspaceComposerPreferences = {}
  for (const doc of docs) {
    if (!isProviderId(doc.providerId)) continue
    preferences[workspaceComposerPreferenceKey(doc.workspacePath, doc.providerId)] = {
      ...(doc.modelId ? { modelId: doc.modelId } : {}),
      ...(doc.modeId ? { modeId: doc.modeId } : {}),
    }
  }
  return preferences
}

export function mergeWorkspaceComposerPreferences(
  stored: WorkspaceComposerPreferences,
  current: WorkspaceComposerPreferences,
): WorkspaceComposerPreferences {
  const merged = { ...stored }
  for (const [key, preference] of Object.entries(current)) {
    merged[key] = {
      ...(stored[key] ?? {}),
      ...preference,
    }
  }
  return merged
}
