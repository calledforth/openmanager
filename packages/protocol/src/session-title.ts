import { z } from 'zod'

export const SESSION_TITLE_SOURCES = ['fallback', 'provider', 'user'] as const

export const SessionTitleSourceSchema = z.enum(SESSION_TITLE_SOURCES)
export type SessionTitleSource = z.infer<typeof SessionTitleSourceSchema>

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (!title) return true
  const trimmed = title.trim()
  if (!trimmed) return true
  if (/^ACP Session\s+[0-9a-f-]{8,}$/i.test(trimmed)) return true
  if (/^New session\s*-\s*\d+$/i.test(trimmed)) return true
  if (/^session[-_\s]?[0-9a-z]{6,}$/i.test(trimmed)) return true
  return false
}

export function shouldReplaceSessionTitle(
  existingTitle: string | null | undefined,
  existingSource: SessionTitleSource | undefined,
  incomingSource: SessionTitleSource,
): boolean {
  if (incomingSource === 'user') return true
  if (incomingSource === 'provider') return existingSource !== 'user'
  return isPlaceholderTitle(existingTitle)
}

export function titleFromPrompt(text: string): string | undefined {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (!singleLine) return undefined
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine
}
