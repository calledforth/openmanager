import {
  isProviderId,
  type ModeListing,
  type ModelListing,
  type ProviderId,
} from '@agentpack/contract'

export interface ComposerModelOption {
  modelId: string
  name: string
  description?: string
  contextWindowTokens?: number
  /** Reasoning-effort levels this model accepts. Absent or empty means the
   * model has no effort control — the composer hides the pill rather than
   * offering a setting the CLI ignores. */
  effortLevels?: string[]
  supportsFastMode?: boolean
  /** Whether the `auto` permission mode works here. The CLI hard-rejects it
   * otherwise, so the mode picker filters rather than letting the write fail. */
  supportsAutoMode?: boolean
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
  configValues?: Record<string, string | boolean>
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
  configValues?: Record<string, string | boolean>
}

export function composerProfilesFromDocs(
  docs: ProviderComposerProfileDoc[],
): ProviderComposerProfiles {
  const profiles: ProviderComposerProfiles = {}
  for (const doc of docs) {
    if (!isProviderId(doc.providerId)) continue
    profiles[doc.providerId] = {
      ...(doc.agentInfo ? { agentInfo: doc.agentInfo } : {}),
      // Carried through as-is, empty included. A stored `[]` is the provider
      // having listed and reported none; dropping the key here would hand
      // `mergeProviderComposerProfiles` an absent field, which reads as "no
      // opinion" and lets a previously-merged catalog survive a deliberate
      // clear. The projector's write side makes the same distinction.
      ...(doc.availableModels !== undefined ? { availableModels: doc.availableModels } : {}),
      ...(doc.availableModes !== undefined ? { availableModes: doc.availableModes } : {}),
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
      ...(doc.configValues ? { configValues: doc.configValues } : {}),
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

/** A composer profile backed by whatever the provider's handshake reported.
 *
 * The profile is the *remembered* catalog, and it is only ever written from
 * session events — so a provider that answers its catalog at handshake time
 * instead of on a live session has an empty profile until somebody runs a
 * session with it. That is not a cosmetic gap: `resolveComposerChoice`
 * validates the user's remembered pick against this catalog and discards
 * anything it cannot find, so an empty one throws away every selection and the
 * composer falls back to the head of whatever list it can see. For Claude Code
 * that head is the CLI's own "Default (recommended)" row, which is why picking
 * Opus appeared to snap back to Default — and why the launch then went out
 * with no model at all.
 *
 * Read-side only, and fill-only: a profile that already has a catalog wins,
 * because it came from a live session and therefore describes the exact
 * process a prompt will run on. Nothing here is persisted — the probe's answer
 * is re-derived on every launch and has no business in electron-store or
 * Convex, where it would outlive the CLI version that produced it.
 *
 * Returns `profile` by identity when it adds nothing. Callers feed the result
 * straight into `resolve*ComposerRuntime`, whose own change detection is `===`
 * against the listings it was handed — a fresh object per render would defeat
 * it and re-publish composer state on every pass. */
export function withProviderCatalog(
  profile: ProviderComposerProfile | undefined,
  metadata: { models?: ModelListing; modes?: ModeListing } | undefined,
): ProviderComposerProfile | undefined {
  const models = profile?.availableModels?.length
    ? undefined
    : metadata?.models?.availableModels?.map((model): ComposerModelOption => ({
        modelId: model.id,
        name: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(model.effortLevels?.length ? { effortLevels: [...model.effortLevels] } : {}),
        ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
        ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
      }))
  const modes = profile?.availableModes?.length
    ? undefined
    : metadata?.modes?.availableModes?.map((mode): ComposerModeOption => ({
        id: mode.id,
        name: mode.displayName,
        ...(mode.description ? { description: mode.description } : {}),
      }))
  if (!models?.length && !modes?.length) return profile
  return {
    ...(profile ?? { updatedAt: 0 }),
    ...(models?.length ? { availableModels: models } : {}),
    ...(modes?.length ? { availableModes: modes } : {}),
  }
}
