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

/** `neutral`, `paper` and `neutral-light` are the Tend colour schemes (styles/fluid.css). */
export type ThemeMode = 'dark' | 'light' | 'black' | 'neutral' | 'paper' | 'neutral-light'

export const THEME_MODES: readonly ThemeMode[] = [
  'dark',
  'light',
  'black',
  'neutral',
  'paper',
  'neutral-light',
]

/** Every theme with its display name, in the order pickers list them. */
export const THEME_OPTIONS: ReadonlyArray<{ id: ThemeMode; label: string; hint: string }> = [
  { id: 'light', label: 'Light', hint: 'the original light' },
  { id: 'dark', label: 'Dark', hint: 'the original dark' },
  { id: 'black', label: 'Black', hint: 'true black' },
  { id: 'neutral-light', label: 'Neutral Light', hint: 'plain greys, light' },
  { id: 'neutral', label: 'Neutral', hint: 'plain greys, dark' },
  { id: 'paper', label: 'Paper', hint: 'warm greys, dark' },
]

export function isThemeMode(value: string): value is ThemeMode {
  return (THEME_MODES as readonly string[]).includes(value)
}

/** Whether a theme paints on a light canvas (icons and code blocks switch on this). */
export function isLightTheme(mode: ThemeMode): boolean {
  return mode === 'light' || mode === 'neutral-light'
}

const THEME_STORAGE_KEY = 'openmanager-theme'
const FONT_STORAGE_KEY = 'openmanager-font'

interface ThemeValue {
  theme: ThemeMode
  setTheme: (mode: ThemeMode) => void
  toggleTheme: () => void
  font: UiFontId
  setFont: (font: UiFontId) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

function readStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored && isThemeMode(stored)) return stored
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'dark'
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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const stored = readStoredTheme()
    applyTheme(stored)
    return stored
  })
  const [font, setFontState] = useState<UiFontId>(() => {
    const stored = readStoredFont()
    applyFont(stored)
    return stored
  })

  useEffect(() => {
    applyTheme(theme, true)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  useEffect(() => {
    applyFont(font)
    try {
      localStorage.setItem(FONT_STORAGE_KEY, font)
    } catch {
      /* ignore */
    }
  }, [font])

  const setTheme = useCallback((mode: ThemeMode) => setThemeState(mode), [])
  const toggleTheme = useCallback(
    () => setThemeState((t) => (t === 'dark' ? 'light' : t === 'light' ? 'black' : 'dark')),
    [],
  )
  const setFont = useCallback((next: UiFontId) => setFontState(next), [])

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme, font, setFont }),
    [theme, setTheme, toggleTheme, font, setFont],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
