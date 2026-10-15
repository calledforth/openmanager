import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { DEFAULT_UI_FONT, isUiFontId, type UiFontId } from '../lib/fonts'
import {
  DEFAULT_THEME_FAMILY,
  THEME_FAMILIES,
  familyOfTheme,
  familyVariant,
  isAppearanceMode,
  isThemeFamilyId,
  isThemeMode,
  schemeOfTheme,
  themeFamily,
  type AppearanceMode,
  type ColorScheme,
  type ThemeFamily,
  type ThemeFamilyId,
  type ThemeMode,
} from '../lib/theme-families'

export {
  THEME_FAMILIES,
  THEME_MODES,
  familyOfTheme,
  familyVariant,
  isThemeMode,
  schemeOfTheme,
  themeFamily,
  themeVariant,
  type AppearanceMode,
  type ColorScheme,
  type ThemeFamily,
  type ThemeFamilyId,
  type ThemeMode,
  type ThemeSwatch,
  type ThemeVariant,
} from '../lib/theme-families'

/** Every scheme with its own name, in family order (for pickers that list schemes, not families). */
export const THEME_OPTIONS: ReadonlyArray<{ id: ThemeMode; label: string; hint: string }> =
  THEME_FAMILIES.flatMap((family) =>
    [...family.light, ...family.dark].map((variant) => ({
      id: variant.id,
      label: variant.name,
      hint: variant.hint,
    })),
  )

/** Whether a theme paints on a light canvas (icons and code blocks switch on this). */
export function isLightTheme(mode: ThemeMode): boolean {
  return schemeOfTheme(mode) === 'light'
}

/** The variant picked last in each family, per scheme, so going back to a family brings it back. */
export type ThemePicks = Partial<Record<ThemeFamilyId, Partial<Record<ColorScheme, ThemeMode>>>>

export interface Appearance {
  mode: AppearanceMode
  family: ThemeFamilyId
  picks: ThemePicks
}

/**
 * The appearance as saved: mode, family and picks, plus the scheme each mode
 * resolves to, so public/theme-boot.js can paint before React runs without
 * knowing the families. `openmanager-theme` keeps the scheme on screen, which
 * the desktop shell's boot reads.
 */
const APPEARANCE_STORAGE_KEY = 'openmanager-appearance'
const THEME_STORAGE_KEY = 'openmanager-theme'
const FONT_STORAGE_KEY = 'openmanager-font'

const SYSTEM_LIGHT_QUERY = '(prefers-color-scheme: light)'

const DEFAULT_APPEARANCE: Appearance = { mode: 'system', family: DEFAULT_THEME_FAMILY, picks: {} }

/** The scheme an appearance shows under the given system scheme. */
export function resolveTheme(appearance: Appearance, system: ColorScheme): ThemeMode {
  const scheme = appearance.mode === 'system' ? system : appearance.mode
  const family = themeFamily(appearance.family)
  return familyVariant(family, scheme, appearance.picks[family.id]?.[scheme]).id
}

function readPicks(value: unknown): ThemePicks {
  if (!value || typeof value !== 'object') return {}
  const picks: ThemePicks = {}
  for (const [familyId, byScheme] of Object.entries(value as Record<string, unknown>)) {
    if (!isThemeFamilyId(familyId) || !byScheme || typeof byScheme !== 'object') continue
    const family = themeFamily(familyId)
    for (const scheme of ['light', 'dark'] as const) {
      const id = (byScheme as Record<string, unknown>)[scheme]
      if (typeof id === 'string' && family[scheme].some((variant) => variant.id === id)) {
        picks[familyId] = { ...picks[familyId], [scheme]: id as ThemeMode }
      }
    }
  }
  return picks
}

/** A single saved scheme from before families: its family, its scheme as the mode, and it as the pick. */
function appearanceFromTheme(theme: ThemeMode): Appearance {
  const family = familyOfTheme(theme).id
  const scheme = schemeOfTheme(theme)
  return { mode: scheme, family, picks: { [family]: { [scheme]: theme } } }
}

export function readStoredAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      const saved = parsed as Record<string, unknown>
      return {
        mode: isAppearanceMode(saved.mode) ? saved.mode : DEFAULT_APPEARANCE.mode,
        family: isThemeFamilyId(saved.family) ? saved.family : DEFAULT_APPEARANCE.family,
        picks: readPicks(saved.picks),
      }
    }
  } catch {
    /* unreadable: fall back to the single saved scheme */
  }
  try {
    const legacy = localStorage.getItem(THEME_STORAGE_KEY)
    if (legacy && isThemeMode(legacy)) return appearanceFromTheme(legacy)
  } catch {
    /* ignore */
  }
  return DEFAULT_APPEARANCE
}

function storeAppearance(appearance: Appearance, theme: ThemeMode) {
  try {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        ...appearance,
        light: resolveTheme({ ...appearance, mode: 'light' }, 'light'),
        dark: resolveTheme({ ...appearance, mode: 'dark' }, 'dark'),
      }),
    )
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    /* ignore */
  }
}

function systemQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(SYSTEM_LIGHT_QUERY)
}

function readSystemScheme(): ColorScheme {
  return systemQuery()?.matches ? 'light' : 'dark'
}

function readStoredFont(): UiFontId {
  try {
    const stored = localStorage.getItem(FONT_STORAGE_KEY)
    if (stored && isUiFontId(stored)) return stored
  } catch {
    /* ignore */
  }
  return DEFAULT_UI_FONT
}

function applyTheme(mode: ThemeMode, animate = false) {
  const root = document.documentElement
  // Colours tween for one beat while the scheme swaps (styles/fluid.css).
  if (animate && root.dataset.theme !== (mode === 'dark' ? undefined : mode)) {
    root.classList.add('transitioning')
    window.setTimeout(() => root.classList.remove('transitioning'), 200)
  }
  if (mode === 'dark') {
    delete root.dataset.theme
  } else {
    root.dataset.theme = mode
  }
}

function applyFont(font: UiFontId) {
  document.documentElement.dataset.uiFont = font
}

interface ThemeValue {
  /** The scheme on screen. */
  theme: ThemeMode
  /** Whether the scheme on screen is light or dark. */
  scheme: ColorScheme
  /** Light, dark, or whatever the operating system is set to. */
  mode: AppearanceMode
  setMode: (mode: AppearanceMode) => void
  family: ThemeFamily
  /** Switches family, keeping the mode. */
  setFamily: (family: ThemeFamilyId) => void
  /** The variant the family shows for each scheme. */
  variants: Record<ColorScheme, ThemeMode>
  /** The variant last picked in every family, so a family can be previewed as it would show. */
  picks: ThemePicks
  /** Picks a variant within its family (and moves to that family), keeping the mode. */
  setVariant: (variant: ThemeMode) => void
  /** Shows exactly this scheme: its family and variant, with the mode pinned to its scheme. */
  setTheme: (mode: ThemeMode) => void
  toggleTheme: () => void
  font: UiFontId
  setFont: (font: UiFontId) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

function withPick(appearance: Appearance, variant: ThemeMode): Appearance {
  const family = familyOfTheme(variant).id
  return {
    ...appearance,
    family,
    picks: {
      ...appearance.picks,
      [family]: { ...appearance.picks[family], [schemeOfTheme(variant)]: variant },
    },
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(readStoredAppearance)
  const [system, setSystem] = useState<ColorScheme>(() => {
    const scheme = readSystemScheme()
    applyTheme(resolveTheme(appearance, scheme))
    return scheme
  })
  const [font, setFontState] = useState<UiFontId>(() => {
    const stored = readStoredFont()
    applyFont(stored)
    return stored
  })

  useEffect(() => {
    const query = systemQuery()
    if (!query) return
    const onChange = () => setSystem(query.matches ? 'light' : 'dark')
    onChange()
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])

  const theme = resolveTheme(appearance, system)

  useEffect(() => {
    applyTheme(theme, true)
  }, [theme])

  useEffect(() => {
    storeAppearance(appearance, theme)
  }, [appearance, theme])

  useEffect(() => {
    applyFont(font)
    try {
      localStorage.setItem(FONT_STORAGE_KEY, font)
    } catch {
      /* ignore */
    }
  }, [font])

  const setMode = useCallback(
    (mode: AppearanceMode) => setAppearance((current) => ({ ...current, mode })),
    [],
  )
  const setFamily = useCallback(
    (family: ThemeFamilyId) =>
      setAppearance((current) => (isThemeFamilyId(family) ? { ...current, family } : current)),
    [],
  )
  const setVariant = useCallback(
    (variant: ThemeMode) =>
      setAppearance((current) => (isThemeMode(variant) ? withPick(current, variant) : current)),
    [],
  )
  const setTheme = useCallback(
    (variant: ThemeMode) =>
      setAppearance((current) => {
        if (!isThemeMode(variant)) return current
        return { ...withPick(current, variant), mode: schemeOfTheme(variant) }
      }),
    [],
  )
  const scheme = schemeOfTheme(theme)
  const toggleTheme = useCallback(
    () => setAppearance((current) => ({ ...current, mode: scheme === 'dark' ? 'light' : 'dark' })),
    [scheme],
  )
  const setFont = useCallback((next: UiFontId) => setFontState(next), [])

  const family = themeFamily(appearance.family)
  const lightVariant = familyVariant(family, 'light', appearance.picks[family.id]?.light).id
  const darkVariant = familyVariant(family, 'dark', appearance.picks[family.id]?.dark).id

  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      scheme,
      mode: appearance.mode,
      setMode,
      family,
      setFamily,
      variants: { light: lightVariant, dark: darkVariant },
      picks: appearance.picks,
      setVariant,
      setTheme,
      toggleTheme,
      font,
      setFont,
    }),
    [
      theme,
      scheme,
      appearance.mode,
      setMode,
      family,
      setFamily,
      lightVariant,
      darkVariant,
      appearance.picks,
      setVariant,
      setTheme,
      toggleTheme,
      font,
      setFont,
    ],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
