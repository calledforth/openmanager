export const SESSION_TITLE_SOURCES = ['fallback', 'provider', 'user'] as const

export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number]

export function isPlaceholderTitle(title: string | undefined): boolean {
  if (!title) return true
  const trimmed = title.trim()
  if (!trimmed) return true
  if (/^ACP Session\s+[0-9a-f-]{8,}$/i.test(trimmed)) return true
  if (/^New session\s*-\s*\d+$/i.test(trimmed)) return true
  if (/^session[-_\s]?[0-9a-z]{6,}$/i.test(trimmed)) return true
  return false
}

export function shouldReplaceSessionTitle(
  existingTitle: string | undefined,
  existingSource: SessionTitleSource | undefined,
  incomingSource: SessionTitleSource,
): boolean {
  if (incomingSource === 'user') return true
  if (incomingSource === 'provider') return existingSource !== 'user'
  return isPlaceholderTitle(existingTitle)
}

export function providerTitlePatch(
  existing:
    | {
        title?: string
        titleSource?: SessionTitleSource
        providerId?: string
      }
    | undefined,
  providerId: string,
  title: string,
): { providerId?: string; title?: string; titleSource?: 'provider' } | undefined {
  const nextTitle = title.trim()
  if (
    !existing ||
    !nextTitle ||
    (existing.providerId !== undefined && existing.providerId !== providerId)
  ) {
    return undefined
  }

  const patch: { providerId?: string; title?: string; titleSource?: 'provider' } = {}
  if (existing.providerId !== providerId) patch.providerId = providerId
  if (
    shouldReplaceSessionTitle(existing.title, existing.titleSource, 'provider') &&
    (existing.title !== nextTitle || existing.titleSource !== 'provider')
  ) {
    patch.title = nextTitle
    patch.titleSource = 'provider'
  }
  return Object.keys(patch).length > 0 ? patch : undefined
}
