import type { ProviderId } from '@agentpack/contract'

export const FAVORITE_MODELS_STORAGE_KEY = 'openmanager-favorite-models'

export type FavoriteModelKey = `${ProviderId}:${string}`

export function favoriteModelKey(providerId: ProviderId, modelId: string): FavoriteModelKey {
  return `${providerId}:${modelId}`
}

export function parseFavoriteModelKey(
  key: string,
): { providerId: ProviderId; modelId: string } | null {
  const sep = key.indexOf(':')
  if (sep <= 0 || sep === key.length - 1) return null
  const providerId = key.slice(0, sep)
  const modelId = key.slice(sep + 1)
  if (providerId !== 'claude' && providerId !== 'cursor' && providerId !== 'opencode') return null
  return { providerId, modelId }
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
