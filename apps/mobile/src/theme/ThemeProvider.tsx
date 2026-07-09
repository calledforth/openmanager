import AsyncStorage from '@react-native-async-storage/async-storage'
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

import { basisDark, basisLight, darkVars, lightVars } from './tokens'

export type ThemeMode = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

type ThemeContextValue = {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

const THEME_MODE_KEY = 'openmanager.themeMode'

const ThemeContext = createContext<ThemeContextValue | null>(null)

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === 'system' || value === 'dark' || value === 'light'

export function ThemeProvider({ children }: PropsWithChildren) {
  const systemColorScheme = useColorScheme()
  const [mode, setModeState] = useState<ThemeMode>('system')

  useEffect(() => {
    let isMounted = true

    AsyncStorage.getItem(THEME_MODE_KEY)
      .then((storedMode) => {
        if (isMounted && isThemeMode(storedMode)) {
          setModeState(storedMode)
        }
      })
      .catch(() => {
        // Ignore persistence failures; system mode remains the fallback.
      })

    return () => {
      isMounted = false
    }
  }, [])

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode)
    AsyncStorage.setItem(THEME_MODE_KEY, nextMode).catch(() => {
      // Theme changes should still apply even when persistence fails.
    })
  }, [])

  const resolved: ResolvedTheme =
    mode === 'system' ? (systemColorScheme === 'light' ? 'light' : 'dark') : mode

  const value = useMemo(
    () => ({
      mode,
      resolved,
      setMode,
    }),
    [mode, resolved, setMode],
  )

  const activeVars = resolved === 'dark' ? darkVars : lightVars
  const activeTokens = resolved === 'dark' ? basisDark : basisLight

  return (
    <ThemeContext.Provider value={value}>
      <View
        className="flex-1"
        style={[activeVars, { backgroundColor: activeTokens.canvasBg }]}
      >
        {children}
      </View>
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const value = useContext(ThemeContext)

  if (!value) {
    throw new Error('useTheme must be used within ThemeProvider')
  }

  return value
}
