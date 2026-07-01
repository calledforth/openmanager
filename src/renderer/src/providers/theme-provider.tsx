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

export type ThemeMode = 'dark' | 'light'

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
    if (stored === 'light' || stored === 'dark') return stored
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

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement
  if (mode === 'light') {
    root.dataset.theme = 'light'
  } else {
    delete root.dataset.theme
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
    applyTheme(theme)
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
    () => setThemeState((t) => (t === 'dark' ? 'light' : 'dark')),
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
