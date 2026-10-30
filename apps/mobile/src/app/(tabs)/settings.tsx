import Constants from 'expo-constants'
import * as Device from 'expo-device'
import { useFocusEffect, useRouter } from 'expo-router'
import {
  CaretRightIcon,
  DeviceMobileIcon,
  InfoIcon,
  PlusIcon,
  QrCodeIcon,
} from 'phosphor-react-native'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../../components/ui/AppText'
import { phoneConnectionView } from '../../environment/connection-ui'
import { usePhoneConnection } from '../../environment/PhoneEnvironmentProvider'
import { suggestPhoneLabel } from '../../pairing/device-label'
import { AppearanceSection } from '../../settings/AppearanceSection'
import { EnvironmentCard } from '../../settings/EnvironmentCard'
import { environmentCards } from '../../settings/environments'
import { SettingsRow } from '../../settings/SettingsRow'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { UpdateRow } from '../../updates/UpdateRow'
import { useCheckOnFocus } from '../../updates/useUpdater'
import { BigTitle, FadeOut, SectionLabel } from '../../ui/chrome'
import { GlassContent } from '../../ui/Glass'
import { Screen } from '../../ui/Screen'
import { Press } from '../../ui/Press'

/** What this phone calls itself, the way it names itself when it pairs. */
const PHONE_NAME = suggestPhoneLabel({ modelName: Device.modelName, osName: Device.osName })

/**
 * Settings, the third tab, as the mockup's Settings frame: environments
 * first, as cards (the one the phone connects to says "here" and carries the
 * live state in the shared words; each opens its page, where its devices,
 * pairing links, providers and session titles live). Then appearance, and
 * this phone. Notifications are left out: the phone has no notification
 * setting yet, and a row that does nothing is not shown.
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
  const paired = connection.environments.filter((item) => item.paired).length
  useFocusEffect(useCheckOnFocus())

  return (
    <Screen tab="settings">
      <GlassContent style={{ paddingTop: insets.top + 6 }}>
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
            <AppearanceSection />

            <SectionLabel>This phone</SectionLabel>
            <SettingsRow
              icon={<DeviceMobileIcon size={17} color={theme.muted} />}
              title="This device"
              sub={`${PHONE_NAME} · paired with ${paired === 1 ? '1 environment' : `${paired} environments`}`}
            />
            <SettingsRow
              icon={<InfoIcon size={17} color={theme.muted} />}
              title="About"
              sub={`OpenManager ${version} · protocol ${protocol}`}
            />
            <UpdateRow />
          </ScrollView>
          <FadeOut />
        </View>
      </GlassContent>
    </Screen>
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
