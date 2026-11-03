import { useRouter } from 'expo-router'
import {
  ArrowClockwiseIcon,
  ArrowsLeftRightIcon,
  QrCodeIcon,
  WifiSlashIcon,
} from 'phosphor-react-native'
import { useState } from 'react'
import { Linking, Platform, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import {
  NEXT_STEP_LABELS,
  type PhoneConnectionView,
  type PhoneNextStep,
} from '../environment/connection-ui'
import { NETWORK_SETTINGS_FAILED, openNetworkSettings } from '../environment/network-settings'
import { usePhoneConnectionController } from '../environment/PhoneEnvironmentProvider'
import { RetryCountdown } from '../environment/RetryCountdown'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { warning } from '../ui/haptics'
import { Dot, SettingsRow, toneColor } from './SettingsRow'

/** A changed state's words fade in; a short opacity change on the UI thread. */
const WORDS_IN = FadeIn.duration(180)

/**
 * Where the connection stands when it is not simply connected: the shared
 * derivation's title, words and cause, the controller's retry countdown, and
 * the next steps as rows (try now, pair again, switch environment, network
 * settings). The same panel sits on the environment's page and on the
 * sessions home. The countdown ticks in its own small component, so a tick
 * renders only its line.
 */
export function ConnectionPanel({ view }: { view: PhoneConnectionView }) {
  const theme = usePhoneTheme()
  const router = useRouter()
  const controller = usePhoneConnectionController()
  const { ui } = view
  const stateKey = `${ui.kind}:${ui.title}:${ui.detail ?? ''}`
  // A next step that could not be carried out says so, for this state only.
  const [failed, setFailed] = useState<{ key: string; words: string } | null>(null)
  const run = (step: PhoneNextStep) => {
    switch (step) {
      case 'retry':
        controller.retry()
        return
      case 'pair':
        router.push('/pair')
        return
      case 'pair_again':
        // Pairing again on purpose: the refused token is not sent again, and
        // the new link is exchanged for a token of its own (`planPairing`).
        router.push(
          view.environmentId
            ? { pathname: '/pair', params: { again: view.environmentId } }
            : '/pair',
        )
        return
      case 'switch_environment':
        router.navigate('/settings')
        return
      case 'network_settings':
        void openNetworkSettings(Platform.OS, Linking).then((opened) => {
          if (opened) return
          warning()
          setFailed({ key: stateKey, words: NETWORK_SETTINGS_FAILED })
        })
        return
    }
  }
  const failure = failed?.key === stateKey ? failed.words : null
  return (
    <View style={{ borderRadius: 18, backgroundColor: theme.hover, padding: 6 }}>
      <Animated.View
        key={stateKey}
        entering={WORDS_IN}
        accessibilityLiveRegion="polite"
        style={{ paddingHorizontal: 10, paddingTop: 10, paddingBottom: 8, gap: 4 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Dot color={toneColor(theme, view.tone)} />
          <AppText accessibilityRole="header" variant="text-16-medium" style={{ color: theme.fg }}>
            {ui.title}
          </AppText>
        </View>
        {/* A banner's description is what the client is doing ("Trying to
            reconnect…"); while a retry is scheduled the countdown says it better. */}
        <RetryCountdown retryAt={ui.surface === 'banner' ? view.retryAt : null}>
          {(countdown) => (
            <AppText variant="text-13-regular" style={{ color: theme.muted, lineHeight: 19 }}>
              {countdown ?? ui.description}
            </AppText>
          )}
        </RetryCountdown>
        {ui.detail ? (
          <AppText variant="text-12-regular" style={{ color: theme.faint }}>
            {ui.detail}
          </AppText>
        ) : null}
      </Animated.View>
      {view.next.map((step) => (
        <SettingsRow
          key={step}
          icon={<NextStepIcon step={step} />}
          title={NEXT_STEP_LABELS[step]}
          raised
          onPress={() => run(step)}
        />
      ))}
      {failure ? (
        <AppText
          accessibilityLiveRegion="assertive"
          variant="text-12-regular"
          style={{ color: theme.status.error, paddingHorizontal: 10, paddingBottom: 8 }}
        >
          {failure}
        </AppText>
      ) : null}
    </View>
  )
}

function NextStepIcon({ step }: { step: PhoneNextStep }) {
  const theme = usePhoneTheme()
  switch (step) {
    case 'retry':
      return <ArrowClockwiseIcon size={17} color={theme.fg} />
    case 'pair':
    case 'pair_again':
      return <QrCodeIcon size={17} color={theme.fg} />
    case 'switch_environment':
      return <ArrowsLeftRightIcon size={17} color={theme.fg} />
    case 'network_settings':
      return <WifiSlashIcon size={17} color={theme.fg} />
  }
}
