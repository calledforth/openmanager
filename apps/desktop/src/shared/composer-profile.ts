import type { ProviderId } from '@agentpack/contract'

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
