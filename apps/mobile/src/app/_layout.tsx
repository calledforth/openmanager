import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold } from '@expo-google-fonts/geist'
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useMemo } from 'react'
import { useFonts } from 'expo-font'
import { View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import '../../global.css'
import { AppText } from '../components/ui/AppText'
import { ThemeProvider, useTheme } from '../theme/ThemeProvider'

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL

SplashScreen.preventAutoHideAsync().catch(() => {
  // The splash screen can already be hidden during fast refresh.
})

function RootNavigator() {
  const { resolved } = useTheme()

  return (
    <>
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: 'transparent' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="session/[externalId]" />
        <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
      </Stack>
    </>
  )
}

function ConvexNotConfigured() {
  return (
    <View className="flex-1 items-center justify-center bg-background px-8">
      <AppText variant="text-16-medium" className="mb-2 text-center text-textStrong">
        Convex is not configured
      </AppText>
      <AppText variant="text-13-regular" className="text-center text-textMuted">
        Create apps/mobile/.env from .env.example and set EXPO_PUBLIC_CONVEX_URL to your Convex
        deployment URL, then restart the dev server.
      </AppText>
    </View>
  )
}

export default function RootLayout() {
  const convex = useMemo(
    () => (convexUrl ? new ConvexReactClient(convexUrl, { unsavedChangesWarning: false }) : null),
    [],
  )
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

  // Missing EXPO_PUBLIC_CONVEX_URL would otherwise throw while constructing the
  // Convex client, leaving the splash stuck with no error. Render a readable
  // configuration screen instead of the ConvexProvider tree.
  if (!convex) {
    return (
      <SafeAreaProvider>
        <ThemeProvider>
          <ConvexNotConfigured />
        </ThemeProvider>
      </SafeAreaProvider>
    )
  }

  return (
    <SafeAreaProvider>
      <ConvexProvider client={convex}>
        <ThemeProvider>
          <RootNavigator />
        </ThemeProvider>
      </ConvexProvider>
    </SafeAreaProvider>
  )
}
