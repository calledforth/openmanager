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
  familyOfTheme,
  isAppearanceMode,
  isThemeFamilyId,
  isThemeMode,
  schemeOfTheme,
  themeFamily,
  themeModeFrom,
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
  isThemeMode,
  schemeOfTheme,
  themeFamily,
  themeModeFrom,
  type AppearanceMode,
  type ColorScheme,
  type ThemeFamily,
  type ThemeFamilyId,
  type ThemeMode,
  type ThemeScheme,
  type ThemeSwatch,
} from '../lib/theme-families'

/** Whether a theme paints on a light canvas (icons and code blocks switch on this). */
export function isLightTheme(mode: ThemeMode): boolean {
  return schemeOfTheme(mode) === 'light'
}

export interface Appearance {
  mode: AppearanceMode
  family: ThemeFamilyId
}

/**
 * The appearance as saved: mode and family, plus the scheme each mode
 * resolves to, so public/theme-boot.js can paint before React runs without
 * knowing the families. `openmanager-theme` keeps the scheme on screen too:
 * it was the single value saved before families, read when no appearance is.
 */
const APPEARANCE_STORAGE_KEY = 'openmanager-appearance'
const THEME_STORAGE_KEY = 'openmanager-theme'
const FONT_STORAGE_KEY = 'openmanager-font'

const SYSTEM_LIGHT_QUERY = '(prefers-color-scheme: light)'

const DEFAULT_APPEARANCE: Appearance = { mode: 'system', family: DEFAULT_THEME_FAMILY }

/** The scheme an appearance shows under the given system scheme. */
export function resolveTheme(appearance: Appearance, system: ColorScheme): ThemeMode {
  const scheme = appearance.mode === 'system' ? system : appearance.mode
  return themeFamily(appearance.family)[scheme].id
}

/** A single saved scheme from before families: its family, with its side as the mode. */
function appearanceFromTheme(theme: ThemeMode): Appearance {
  return { mode: schemeOfTheme(theme), family: familyOfTheme(theme).id }
}

/**
 * The saved appearance. Only the mode and family are read back: the variant
 * picks an older appearance carried (and its resolved schemes) are dropped, so
 * a family shows its one scheme for the mode. With no appearance saved, the
 * single scheme from before families decides, through any scheme that has
 * since replaced it.
 */
export function readStoredAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      const saved = parsed as Record<string, unknown>
      const family = isThemeFamilyId(saved.family) ? saved.family : DEFAULT_APPEARANCE.family
      // Black was Default's other dark and is Lovable's dark now: whoever
      // picked it keeps the black they chose, in Lovable.
      const picks = saved.picks as { default?: { dark?: unknown } } | undefined
      const pickedBlack =
        family === 'default' && (saved.dark === 'black' || picks?.default?.dark === 'black')
      return {
        mode: isAppearanceMode(saved.mode) ? saved.mode : DEFAULT_APPEARANCE.mode,
        family: pickedBlack ? 'lovable' : family,
      }
    }
  } catch {
    /* unreadable: fall back to the single saved scheme */
  }
  try {
    const legacy = themeModeFrom(localStorage.getItem(THEME_STORAGE_KEY))
    if (legacy) return appearanceFromTheme(legacy)
  } catch {
    /* ignore */
  }
  return DEFAULT_APPEARANCE
}

/** The scheme the saved appearance shows on this device right now, for a shell's boot. */
export function readStoredTheme(): ThemeMode {
  return resolveTheme(readStoredAppearance(), readSystemScheme())
}

function storeAppearance(appearance: Appearance, theme: ThemeMode) {
  const family = themeFamily(appearance.family)
  try {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        mode: appearance.mode,
        family: family.id,
        light: family.light.id,
        dark: family.dark.id,
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
  /** Shows exactly this scheme: moves to its family, with the mode pinned to its side. */
  setTheme: (mode: ThemeMode) => void
  toggleTheme: () => void
  font: UiFontId
  setFont: (font: UiFontId) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

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
  const setTheme = useCallback(
    (next: ThemeMode) =>
      setAppearance((current) => (isThemeMode(next) ? appearanceFromTheme(next) : current)),
    [],
  )
  const scheme = schemeOfTheme(theme)
  const toggleTheme = useCallback(
    () => setAppearance((current) => ({ ...current, mode: scheme === 'dark' ? 'light' : 'dark' })),
    [scheme],
  )
  const setFont = useCallback((next: UiFontId) => setFontState(next), [])

  const family = themeFamily(appearance.family)

  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      scheme,
      mode: appearance.mode,
      setMode,
      family,
      setFamily,
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
