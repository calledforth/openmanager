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

export const SESSION_TITLE_MAX_LENGTH = 80
/** Room for the ellipsis that replaces what was cut. */
const SESSION_TITLE_CUT_LENGTH = SESSION_TITLE_MAX_LENGTH - 3

/**
 * Name a session after the prompt that started it: one line, short enough for
 * a sidebar row. Measured in code points rather than UTF-16 units, so a cut
 * cannot land inside an astral character and leave an unpaired surrogate.
 */
export function titleFromPrompt(text: string): string | undefined {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (!singleLine) return undefined
  const characters = Array.from(singleLine)
  return characters.length > SESSION_TITLE_MAX_LENGTH
    ? `${characters.slice(0, SESSION_TITLE_CUT_LENGTH).join('')}...`
    : singleLine
}
