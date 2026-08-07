export const COMPOSER_DRAFTS_STORAGE_KEY = 'openmanager-composer-drafts'

// Drafts are keyed by session id, and sessions get deleted — without a cap the
// key would grow forever against the ~5MB origin quota.
export const MAX_PERSISTED_DRAFTS = 50
export const MAX_DRAFT_TEXT_LENGTH = 100_000

export type PersistedDraft = {
  text: string
  updatedAt: number
}

function isPersistedDraft(value: unknown): value is PersistedDraft {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Record<string, unknown>
  return typeof draft.text === 'string' && typeof draft.updatedAt === 'number'
}

/**
 * Anything unreadable is treated as "no drafts". A corrupt or hand-edited blob
 * must never keep the composer from mounting — losing a draft is recoverable,
 * a composer that throws on render is not.
 */
export function readComposerDrafts(): Record<string, PersistedDraft> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const drafts: Record<string, PersistedDraft> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isPersistedDraft(value)) drafts[key] = { text: value.text, updatedAt: value.updatedAt }
    }
    return drafts
  } catch {
    return {}
  }
}

export function writeComposerDrafts(drafts: Record<string, PersistedDraft>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // A quota or private-mode failure must not break typing.
  }
}

/**
 * Pure, so the eviction rules are testable without touching storage: empty
 * drafts carry nothing worth restoring, oversized ones are truncated rather
 * than dropped, and only the most recently touched survive the cap.
 */
export function pruneComposerDrafts(
  drafts: Record<string, PersistedDraft>,
): Record<string, PersistedDraft> {
  const kept = Object.entries(drafts)
    .filter(([, draft]) => draft.text.trim().length > 0)
    .map(([key, draft]): [string, PersistedDraft] => [
      key,
      draft.text.length > MAX_DRAFT_TEXT_LENGTH
        ? { text: draft.text.slice(0, MAX_DRAFT_TEXT_LENGTH), updatedAt: draft.updatedAt }
        : draft,
    ])
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PERSISTED_DRAFTS)
  return Object.fromEntries(kept)
}
