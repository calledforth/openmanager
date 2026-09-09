export type UiFontId = 'geist' | 'inter' | 'public-sans' | 'system'

/** Shared UI typography for variable sans faces (14 / 22.75 / wght 450). */
export const UI_FONT_PROFILE = {
  sizePx: 14,
  lineHeightPx: 22.75,
  lineHeightRatio: 22.75 / 14,
  weight: 450,
  letterSpacing: 'normal',
} as const

export const GEIST_FONT_PROFILE = {
  id: 'geist' as const,
  label: 'Geist',
  family: 'Geist Variable',
  ...UI_FONT_PROFILE,
} as const

export const INTER_FONT_PROFILE = {
  id: 'inter' as const,
  label: 'Inter',
  family: 'Inter Variable',
  ...UI_FONT_PROFILE,
} as const

export const UI_FONTS: Array<{ id: UiFontId; label: string }> = [
  { id: GEIST_FONT_PROFILE.id, label: GEIST_FONT_PROFILE.label },
  { id: INTER_FONT_PROFILE.id, label: INTER_FONT_PROFILE.label },
  { id: 'public-sans', label: 'Public Sans' },
  { id: 'system', label: 'System UI' },
]

export const DEFAULT_UI_FONT: UiFontId = INTER_FONT_PROFILE.id

export function isUiFontId(value: string): value is UiFontId {
  return UI_FONTS.some((font) => font.id === value)
}

export function usesVariableSansProfile(font: UiFontId): boolean {
  return font === 'geist' || font === 'inter'
}
