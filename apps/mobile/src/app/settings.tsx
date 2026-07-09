import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { type ThemeMode, useTheme } from '../theme/ThemeProvider'

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' },
]

export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { mode, setMode } = useTheme()

  const deploymentUrl = process.env.EXPO_PUBLIC_CONVEX_URL ?? 'Not configured'
  const version = Constants.expoConfig?.version ?? '—'

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
        <AppText variant="text-16-medium" className="text-textStrong">
          Settings
        </AppText>
        <TouchableOpacity
          activeOpacity={0.7}
          hitSlop={12}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close settings"
        >
          <AppText variant="text-13-medium" className="text-textMuted">
            Done
          </AppText>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: insets.bottom + 24,
          gap: 24,
        }}
      >
        <Section title="Appearance">
          <View className="flex-row gap-2">
            {THEME_OPTIONS.map((option) => {
              const active = mode === option.mode
              return (
                <TouchableOpacity
                  key={option.mode}
                  activeOpacity={0.8}
                  onPress={() => setMode(option.mode)}
                  className={
                    active
                      ? 'flex-1 items-center rounded border border-border bg-tabActiveBg px-3 py-2.5'
                      : 'flex-1 items-center rounded border border-borderMuted bg-surfaceElevated px-3 py-2.5'
                  }
                >
                  <AppText
                    variant="text-13-medium"
                    className={active ? 'text-textStrong' : 'text-textMuted'}
                  >
                    {option.label}
                  </AppText>
                </TouchableOpacity>
              )
            })}
          </View>
        </Section>

        <Section title="Deployment">
          <ReadOnlyRow label="Convex URL" value={deploymentUrl} mono />
          <ReadOnlyRow label="App version" value={version} />
        </Section>
      </ScrollView>
    </View>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-2.5">
      <AppText variant="text-11-medium" className="uppercase text-textFaint">
        {title}
      </AppText>
      {children}
    </View>
  )
}

function ReadOnlyRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <View className="gap-1 rounded border border-borderMuted bg-surface px-3.5 py-3">
      <AppText variant="text-11-regular" className="text-textMuted">
        {label}
      </AppText>
      <AppText
        variant={mono ? 'mono' : 'text-13-regular'}
        className="text-textStrong"
        selectable
      >
        {value}
      </AppText>
    </View>
  )
}
