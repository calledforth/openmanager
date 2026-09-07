export type UiFontId = 'geist' | 'inter' | 'public-sans' | 'system'

export const UI_FONTS: Array<{ id: UiFontId; label: string }> = [
  { id: 'geist', label: 'Geist' },
  { id: 'inter', label: 'Inter' },
  { id: 'public-sans', label: 'Public Sans' },
  { id: 'system', label: 'System UI' },
]

export const DEFAULT_UI_FONT: UiFontId = 'inter'

export function isUiFontId(value: string): value is UiFontId {
  return UI_FONTS.some((font) => font.id === value)
}
