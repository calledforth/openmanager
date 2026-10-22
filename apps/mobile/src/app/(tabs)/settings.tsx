import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { CaretRightIcon, InfoIcon, PlusIcon, QrCodeIcon } from 'phosphor-react-native'
import { ScrollView, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { THEME_FAMILIES } from '@openmanager/app-core/lib/theme-families'

import { AppText } from '../../components/ui/AppText'
import { phoneConnectionView } from '../../environment/connection-ui'
import { usePhoneConnection } from '../../environment/PhoneEnvironmentProvider'
import { EnvironmentCard } from '../../settings/EnvironmentCard'
import { environmentCards } from '../../settings/environments'
import { SettingsRow } from '../../settings/SettingsRow'
import { type ThemeMode, usePhoneTheme, useTheme } from '../../theme/ThemeProvider'
import { BigTitle, FadeOut, SectionLabel } from '../../ui/chrome'
import { Press } from '../../ui/Press'

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' },
]

/**
 * Settings, the third tab. Environments first, as cards: the one the phone
 * connects to says "here" and carries the live state in the shared words;
 * each opens its page. Then appearance and this phone.
 */
export default function SettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const connection = usePhoneConnection()
  const cards = environmentCards(connection, phoneConnectionView(connection))
  const { client, environment } = connection.protocol
  const protocol =
    environment === null || environment === client
      ? `${client}`
      : `${client} (environment ${environment})`
  const version = Constants.expoConfig?.version ?? '—'

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6 }}>
      <BigTitle title="Settings" />
      <View className="flex-1">
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 8,
            // The pill nav floats over the end of the list.
            paddingBottom: insets.bottom + 140,
          }}
          showsVerticalScrollIndicator={false}
        >
          <SectionLabel>Environments</SectionLabel>
          {cards.length === 0 ? (
            <PairRow onPress={() => router.push('/pair')} />
          ) : (
            <>
              {cards.map((card) => (
                <EnvironmentCard
                  key={card.environmentId}
                  card={card}
                  onPress={() =>
                    router.push(`/environment/${encodeURIComponent(card.environmentId)}`)
                  }
                />
              ))}
              <AddEnvironment onPress={() => router.push('/pair')} />
            </>
          )}

          <SectionLabel>Appearance</SectionLabel>
          <AppearanceSection onPreview={() => router.push('/theme-preview')} />

          <SectionLabel>This phone</SectionLabel>
          <SettingsRow
            icon={<InfoIcon size={17} color={theme.muted} />}
            title="About"
            sub={`OpenManager ${version} · protocol ${protocol}`}
          />
        </ScrollView>
        <FadeOut />
      </View>
    </View>
  )
}

/** Below the cards: pairing with another computer. */
function AddEnvironment({ onPress }: { onPress: () => void }) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Add environment"
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 4,
        marginTop: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 12,
        borderRadius: 16,
        backgroundColor: pressed ? theme.active : theme.hover,
      })}
    >
      <PlusIcon size={16} color={theme.muted} />
      <AppText variant="text-14-medium" style={{ color: theme.muted }}>
        Add environment
      </AppText>
    </Press>
  )
}

/** With nothing paired: the way in to pairing, where the cards would be. */
function PairRow({ onPress }: { onPress: () => void }) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Pair with a computer"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginHorizontal: 4,
        marginTop: 4,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 18,
        backgroundColor: pressed ? theme.active : theme.hover,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.actionBg,
        }}
      >
        <QrCodeIcon size={18} color={theme.actionFg} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="text-14-medium" style={{ color: theme.fg }}>
          Pair with a computer
        </AppText>
        <AppText variant="text-12-regular" style={{ color: theme.muted }}>
          Scan its QR code or paste its link
        </AppText>
      </View>
      <CaretRightIcon size={16} color={theme.faint} />
    </Press>
  )
}

/** Theme family and mode, from the shared families. Redesigned to the mockup separately. */
function AppearanceSection({ onPreview }: { onPreview: () => void }) {
  const { mode, setMode, family, setFamily, resolved } = useTheme()
  return (
    <View className="gap-3 px-3">
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
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={onPreview}
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
    </View>
  )
}
