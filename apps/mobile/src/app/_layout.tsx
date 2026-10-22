import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold } from '@expo-google-fonts/geist'
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { useFonts } from 'expo-font'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import '../../global.css'
import { PhoneEnvironmentProvider } from '../environment/PhoneEnvironmentProvider'
import { ThemeProvider, usePhoneTheme, useTheme } from '../theme/ThemeProvider'
import { GlassBackdrop } from '../ui/Glass'

// A cold deep link (a session, search) still has the tabs under it, so its
// back control returns to them.
export const unstable_settings = { anchor: '(tabs)' }

SplashScreen.preventAutoHideAsync().catch(() => {
  // The splash screen can already be hidden during fast refresh.
})

function RootNavigator() {
  const { resolved } = useTheme()
  const theme = usePhoneTheme()

  return (
    <GlassBackdrop>
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          // Each screen paints the canvas itself; the navigator's own
          // background (white, by default) must never show through.
          contentStyle: { backgroundColor: theme.bg },
          animation: 'fade',
        }}
      >
        {/* Sessions, Inbox and Settings, with the pill nav as their tab bar. */}
        <Stack.Screen name="(tabs)" />
        {/* Pages slide in from the side; search and the theme preview rise. */}
        <Stack.Screen name="session/[externalId]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="draft/new" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="draft/[draftId]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen
          name="search"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
        <Stack.Screen name="theme-preview" options={{ presentation: 'modal' }} />
      </Stack>
    </GlassBackdrop>
  )
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    'Geist-Regular': Geist_400Regular,
    'Geist-Medium': Geist_500Medium,
    'Geist-SemiBold': Geist_600SemiBold,
    'JetBrainsMono-Regular': JetBrainsMono_400Regular,
    'JetBrainsMono-Medium': JetBrainsMono_500Medium,
  })

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {
        // No-op when the splash screen has already been hidden.
      })
    }
  }, [fontError, fontsLoaded])

  if (!fontsLoaded && !fontError) {
    return null
  }

  // The phone reaches its environment through the shared environment client;
  // the provider owns the connection and hands the client to app-core.
  return (
    <SafeAreaProvider>
      <PhoneEnvironmentProvider>
        <ThemeProvider>
          <RootNavigator />
        </ThemeProvider>
      </PhoneEnvironmentProvider>
    </SafeAreaProvider>
  )
}
