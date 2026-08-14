import {
  isProviderId,
  type ModeOption,
  type ModelOption,
  type ProviderId,
} from '@agentpack/contract'
import type { ProviderCatalogSnapshot } from '@agentpack/runtime'

/** Last run's model catalogs, persisted between launches.
 *
 * The counterpart to `ProviderHealthCache`, and it exists for the same reason:
 * a cold Cursor takes ~10s to answer its first probe, and until it does the
 * composer has nothing to put in the model picker. Health had that problem for
 * the sidebar and solved it with this exact pattern; the picker had it too and
 * did not.
 *
 * What makes it safe to persist is `agentVersion`. A catalog describes one
 * build of one CLI — which models it accepts, and with what effort levels — so
 * an upgrade can invalidate it instantly while age alone never does. The
 * runtime re-asks whenever the version it probes differs from the one stored
 * here, which is why there is no TTL: a timestamp would expire correct entries
 * and keep wrong ones.
 *
 * Deliberately *not* a place for applied session config. What model a live
 * process is currently set to is process state that Cursor already persists
 * badly on its own — see `AppliedConfigCache`. This holds only the catalog:
 * the set of models a build offers, which no session can change. */
export type ProviderCatalogCache = Partial<Record<ProviderId, ProviderCatalogSnapshot>>

/** Parse whatever electron-store hands back. The settings file is
 * user-writable and survives app upgrades, so every field is checked and
 * anything unrecognised is dropped rather than trusted. */
export function sanitizeProviderCatalogCache(value: unknown): ProviderCatalogCache {
  const cache: ProviderCatalogCache = {}
  for (const [providerId, entry] of Object.entries(asRecord(value))) {
    if (!isProviderId(providerId)) continue
    const snapshot = sanitizeSnapshot(entry)
    if (snapshot) cache[providerId] = snapshot
  }
  return cache
}

function sanitizeSnapshot(value: unknown): ProviderCatalogSnapshot | undefined {
  const source = asRecord(value)
  const models = asRecord(source.models)
  const raw = Array.isArray(models.availableModels) ? models.availableModels : []
  const availableModels: ModelOption[] = []
  for (const entry of raw) {
    const model = sanitizeModel(entry)
    if (model) availableModels.push(model)
  }
  // An entry with no models is not a catalog. Dropping it rather than storing
  // an empty one is what keeps hydration fill-only: `{availableModels: []}`
  // would occupy the slot and stop a real catalog from seeding it.
  if (availableModels.length === 0) return undefined
  const currentModelId = asText(models.currentModelId)
  const agentVersion = asText(source.agentVersion)
  const modes = asRecord(source.modes)
  const availableModes: ModeOption[] = []
  for (const entry of Array.isArray(modes.availableModes) ? modes.availableModes : []) {
    const mode = asRecord(entry)
    const id = asText(mode.id)
    const displayName = asText(mode.displayName)
    if (!id || !displayName) continue
    const description = asText(mode.description)
    availableModes.push({ id, displayName, ...(description ? { description } : {}) })
  }
  const currentModeId = asText(modes.currentModeId)
  return {
    models: { availableModels, ...(currentModelId ? { currentModelId } : {}) },
    ...(availableModes.length > 0
      ? { modes: { availableModes, ...(currentModeId ? { currentModeId } : {}) } }
      : {}),
    ...(agentVersion ? { agentVersion } : {}),
  }
}

function sanitizeModel(value: unknown): ModelOption | undefined {
  const source = asRecord(value)
  const id = asText(source.id)
  const displayName = asText(source.displayName)
  if (!id || !displayName) return undefined
  const description = asText(source.description)
  const resolvedModel = asText(source.resolvedModel)
  const contextWindowTokens =
    typeof source.contextWindowTokens === 'number' && Number.isFinite(source.contextWindowTokens)
      ? source.contextWindowTokens
      : undefined
  // An effort control with no levels is not an effort control — the composer
  // hides the pill rather than offering an empty menu, so an empty array here
  // has to read as "absent" and not as "present but empty".
  const effortLevels = Array.isArray(source.effortLevels)
    ? source.effortLevels.filter((level): level is string => typeof level === 'string' && !!level)
    : []
  return {
    id,
    displayName,
    ...(description ? { description } : {}),
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(effortLevels.length > 0 ? { effortLevels } : {}),
    ...(source.supportsFastMode === true ? { supportsFastMode: true } : {}),
    ...(source.supportsAutoMode === true ? { supportsAutoMode: true } : {}),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
