import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SystemUI from 'expo-system-ui'
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useColorScheme, View } from 'react-native'
import type {
  AppearanceMode,
  ColorScheme,
  ThemeFamilyId,
  ThemeMode as SchemeId,
} from '@openmanager/app-core/lib/theme-families'

import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_MODE_STORAGE_KEY,
  appearanceFromLegacyMode,
  parseAppearance,
  resolveColorScheme,
  resolveScheme,
  serializeAppearance,
  type Appearance,
} from './appearance'
import { phoneTheme, themeVars, type PhoneTheme } from './tokens'

/** The first build called the appearance mode the theme mode; settings still does. */
export type ThemeMode = AppearanceMode
export type ResolvedTheme = ColorScheme

export interface ThemeContextValue {
  appearance: Appearance
  setAppearance: (appearance: Appearance) => void
  /** The appearance mode: light, dark or system. */
  mode: AppearanceMode
  setMode: (mode: AppearanceMode) => void
  family: ThemeFamilyId
  setFamily: (family: ThemeFamilyId) => void
  /** The canvas the resolved scheme paints on. */
  resolved: ColorScheme
  /** The scheme itself, one of web's `data-theme` ids. */
  scheme: SchemeId
  theme: PhoneTheme
  /** False until the saved appearance has been read. */
  hydrated: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: PropsWithChildren) {
  const systemColorScheme = useColorScheme()
  const system: ColorScheme = systemColorScheme === 'light' ? 'light' : 'dark'
  const [appearance, setAppearanceState] = useState<Appearance>(DEFAULT_APPEARANCE)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let isMounted = true
    ;(async () => {
      try {
        const raw = await AsyncStorage.getItem(APPEARANCE_STORAGE_KEY)
        if (raw) return parseAppearance(raw)
        // The first build saved only a mode; carry it over once.
        const legacy = appearanceFromLegacyMode(await AsyncStorage.getItem(LEGACY_MODE_STORAGE_KEY))
        if (legacy) {
          await AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearance(legacy))
          await AsyncStorage.removeItem(LEGACY_MODE_STORAGE_KEY)
        }
        return legacy ?? DEFAULT_APPEARANCE
      } catch {
        // Unreadable storage: the default appearance stands.
        return DEFAULT_APPEARANCE
      }
    })().then((saved) => {
      if (!isMounted) return
      setAppearanceState(saved)
      setHydrated(true)
    })
    return () => {
      isMounted = false
    }
  }, [])

  const setAppearance = useCallback((next: Appearance) => {
    setAppearanceState(next)
    AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearance(next)).catch(() => {
      // The appearance still applies this session when it cannot be saved.
    })
  }, [])

  const setMode = useCallback(
    (mode: AppearanceMode) => setAppearance({ ...appearance, mode }),
    [appearance, setAppearance],
  )
  const setFamily = useCallback(
    (family: ThemeFamilyId) => setAppearance({ ...appearance, family }),
    [appearance, setAppearance],
  )

  const scheme = resolveScheme(appearance, system)
  const resolved = resolveColorScheme(appearance, system)
  const theme = phoneTheme(scheme)

  // The window behind the app (seen while a modal slides, or on a keyboard
  // bounce) matches the canvas.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.bg).catch(() => {
      // Not every platform exposes the root background; the View below paints it.
    })
  }, [theme.bg])

  const value = useMemo<ThemeContextValue>(
    () => ({
      appearance,
      setAppearance,
      mode: appearance.mode,
      setMode,
      family: appearance.family,
      setFamily,
      resolved,
      scheme,
      theme,
      hydrated,
    }),
    [appearance, setAppearance, setMode, setFamily, resolved, scheme, theme, hydrated],
  )

  const rootVars = useMemo(() => themeVars(theme), [theme])

  return (
    <ThemeContext.Provider value={value}>
      <View className="flex-1" style={[rootVars, { backgroundColor: theme.bg }]}>
        {children}
      </View>
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return value
}

/** The current PhoneTheme, for styles a class name cannot express. */
export function usePhoneTheme(): PhoneTheme {
  return useTheme().theme
}
