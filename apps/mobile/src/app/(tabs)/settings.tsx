import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { THEME_FAMILIES } from '@openmanager/app-core/lib/theme-families'

import { AppText } from '../../components/ui/AppText'
import { usePhoneConnection } from '../../environment/PhoneEnvironmentProvider'
import { type ThemeMode, useTheme } from '../../theme/ThemeProvider'

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' },
]

export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { mode, setMode, family, setFamily, resolved } = useTheme()

  const connection = usePhoneConnection()
  const environment = connection.environments.find(
    (item) => item.environmentId === connection.selectedId,
  )
  const protocol =
    connection.protocol.environment === null
      ? `v${connection.protocol.client}`
      : `v${connection.protocol.client} · environment v${connection.protocol.environment}`
  const version = Constants.expoConfig?.version ?? '—'

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* A tab now, so nothing to close. The screen itself is redesigned later. */}
      <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
        <AppText variant="text-16-medium" className="text-textStrong">
          Settings
        </AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          // The pill nav floats over the end of the list.
          paddingBottom: insets.bottom + 140,
          gap: 24,
        }}
      >
        <Section title="Appearance">
          <View className="flex-row flex-wrap gap-3">
            {THEME_FAMILIES.map((option) => {
              const active = family === option.id
              const side = option[resolved]
              return (
                <TouchableOpacity
                  key={option.id}
                  activeOpacity={0.8}
                  onPress={() => setFamily(option.id)}
                  className="items-center gap-1.5"
                  accessibilityRole="button"
                  accessibilityLabel={`${option.label} theme`}
                >
                  <View
                    className={
                      active
                        ? 'h-12 w-12 rounded-xl border-2 border-textStrong'
                        : 'h-12 w-12 rounded-xl border border-borderMuted'
                    }
                    style={{ backgroundColor: side.swatch.canvas }}
                  >
                    <View
                      className="absolute bottom-1.5 left-1.5 h-2 w-5 rounded-full"
                      style={{ backgroundColor: side.swatch.ink }}
                    />
                    <View
                      className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: side.swatch.accent }}
                    />
                  </View>
                  <AppText
                    variant="text-11-regular"
                    className={active ? 'text-textStrong' : 'text-textMuted'}
                  >
                    {option.label}
                  </AppText>
                </TouchableOpacity>
              )
            })}
          </View>
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

        <Section title="Theme">
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => router.push('/theme-preview')}
            className="rounded border border-borderMuted bg-surface px-3.5 py-3"
            accessibilityRole="button"
          >
            <AppText variant="text-13-medium" className="text-textStrong">
              Preview every scheme
            </AppText>
            <AppText variant="text-11-regular" className="text-textMuted">
              Web's tokens, painted on the phone
            </AppText>
          </TouchableOpacity>
        </Section>

        <Section title="Environment">
          <ReadOnlyRow label="Environment" value={environment?.label ?? 'None'} />
          <ReadOnlyRow label="Connection" value={connection.status} mono />
          <ReadOnlyRow label="Route" value={connection.endpoint ?? '—'} mono />
          <ReadOnlyRow label="Protocol" value={protocol} mono />
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

function ReadOnlyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View className="gap-1 rounded border border-borderMuted bg-surface px-3.5 py-3">
      <AppText variant="text-11-regular" className="text-textMuted">
        {label}
      </AppText>
      <AppText variant={mono ? 'mono' : 'text-13-regular'} className="text-textStrong" selectable>
        {value}
      </AppText>
    </View>
  )
}
