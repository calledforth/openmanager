/**
 * The appearance a person picks: a theme family and a mode (light, dark or
 * follow the system). Same shape and storage key as web's theme provider, so
 * the two settings read the same; the phone keeps its own copy in
 * AsyncStorage because appearance is per device, not per environment.
 */
import {
  DEFAULT_THEME_FAMILY,
  isAppearanceMode,
  isThemeFamilyId,
  themeFamily,
  type AppearanceMode,
  type ColorScheme,
  type ThemeFamilyId,
  type ThemeMode as SchemeId,
} from '@openmanager/app-core/lib/theme-families'

export interface Appearance {
  mode: AppearanceMode
  family: ThemeFamilyId
}

export const APPEARANCE_STORAGE_KEY = 'openmanager-appearance'

/** The key the first mobile build used; it held only the mode. */
export const LEGACY_MODE_STORAGE_KEY = 'openmanager.themeMode'

export const DEFAULT_APPEARANCE: Appearance = { mode: 'system', family: DEFAULT_THEME_FAMILY }

/** A saved appearance, or the default for anything unreadable. */
export function parseAppearance(raw: string | null | undefined): Appearance {
  if (!raw) return DEFAULT_APPEARANCE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return DEFAULT_APPEARANCE
    const saved = parsed as Record<string, unknown>
    return {
      mode: isAppearanceMode(saved.mode) ? saved.mode : DEFAULT_APPEARANCE.mode,
      family: isThemeFamilyId(saved.family) ? saved.family : DEFAULT_APPEARANCE.family,
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

/** The legacy mode-only value as an appearance, or null when it is not one. */
export function appearanceFromLegacyMode(raw: string | null | undefined): Appearance | null {
  return isAppearanceMode(raw) ? { ...DEFAULT_APPEARANCE, mode: raw } : null
}

export function serializeAppearance(appearance: Appearance): string {
  return JSON.stringify({ mode: appearance.mode, family: appearance.family })
}

/** The scheme an appearance shows under the system's current scheme. */
export function resolveScheme(appearance: Appearance, system: ColorScheme): SchemeId {
  const side = appearance.mode === 'system' ? system : appearance.mode
  return themeFamily(appearance.family)[side].id
}

/** Which canvas an appearance paints on under the system's current scheme. */
export function resolveColorScheme(appearance: Appearance, system: ColorScheme): ColorScheme {
  return appearance.mode === 'system' ? system : appearance.mode
}
