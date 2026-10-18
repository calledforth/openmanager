import type { ProviderIconId } from '../providers/ProviderIcon'

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

export function readFavoriteModels(): FavoriteModelKey[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY)
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

export function writeFavoriteModels(keys: readonly FavoriteModelKey[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(FAVORITE_MODELS_STORAGE_KEY, JSON.stringify([...keys]))
}

export function toggleFavoriteModel(
  keys: readonly FavoriteModelKey[],
  key: FavoriteModelKey,
): FavoriteModelKey[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key]
}
