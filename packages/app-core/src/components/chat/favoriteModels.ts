import { browserStorage } from '../../lib/browser-device'
import type { DeviceStorage } from '../../providers/device-host'
import type { ProviderIconId } from '../providers/providerIconId'

export const FAVORITE_MODELS_STORAGE_KEY = 'openmanager-favorite-models'

export type FavoriteModelKey = `${ProviderIconId}:${string}`

const FAVORITE_PROVIDERS: ReadonlySet<string> = new Set<ProviderIconId>([
  'claude',
  'cursor',
  'opencode',
  'codex',
])

export function favoriteModelKey(providerId: ProviderIconId, modelId: string): FavoriteModelKey {
  return `${providerId}:${modelId}`
}

export function parseFavoriteModelKey(
  key: string,
): { providerId: ProviderIconId; modelId: string } | null {
  const sep = key.indexOf(':')
  // An empty model id is a real choice: a tool's own default (Settings' title model).
  if (sep <= 0) return null
  const providerId = key.slice(0, sep)
  const modelId = key.slice(sep + 1)
  if (!FAVORITE_PROVIDERS.has(providerId)) return null
  return { providerId: providerId as ProviderIconId, modelId }
}

/** `storageKey` keeps a picker whose model ids mean something else (Settings' title model) apart. */
export function readFavoriteModels(
  storageKey = FAVORITE_MODELS_STORAGE_KEY,
  storage: DeviceStorage | null = browserStorage(),
): FavoriteModelKey[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is FavoriteModelKey =>
        typeof entry === 'string' && parseFavoriteModelKey(entry) !== null,
    )
  } catch {
    return []
  }
}

export function writeFavoriteModels(
  keys: readonly FavoriteModelKey[],
  storageKey = FAVORITE_MODELS_STORAGE_KEY,
  storage: DeviceStorage | null = browserStorage(),
): void {
  if (!storage) return
  storage.setItem(storageKey, JSON.stringify([...keys]))
}

export function toggleFavoriteModel(
  keys: readonly FavoriteModelKey[],
  key: FavoriteModelKey,
): FavoriteModelKey[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key]
}
