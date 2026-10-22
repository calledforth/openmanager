import { useRouter } from 'expo-router'
import { ArrowClockwiseIcon, ArrowsLeftRightIcon, QrCodeIcon } from 'phosphor-react-native'
import { View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import {
  NEXT_STEP_LABELS,
  type PhoneConnectionView,
  type PhoneNextStep,
} from '../environment/connection-ui'
import { usePhoneConnectionController } from '../environment/PhoneEnvironmentProvider'
import { useRetryCountdown } from '../environment/useRetryCountdown'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Dot, SettingsRow, toneColor } from './SettingsRow'

/** A changed state's words fade in; a short opacity change on the UI thread. */
const WORDS_IN = FadeIn.duration(180)

/**
 * Where the connection stands when it is not simply connected: the shared
 * derivation's title, words and cause, the controller's retry countdown, and
 * the next steps as rows (try now, pair again, switch environment). The same
 * panel sits on the environment's page and on the sessions home.
 */
export function ConnectionPanel({ view }: { view: PhoneConnectionView }) {
  const theme = usePhoneTheme()
  const router = useRouter()
  const controller = usePhoneConnectionController()
  const countdown = useRetryCountdown(view.retryAt)
  const { ui } = view
  const run = (step: PhoneNextStep) => {
    switch (step) {
      case 'retry':
        controller.retry()
        return
      case 'pair':
      case 'pair_again':
        router.push('/pair')
        return
      case 'switch_environment':
        router.navigate('/settings')
        return
    }
  }
  // A banner's description is what the client is doing ("Trying to
  // reconnect…"); while a retry is scheduled the countdown says it better.
  const doing = ui.surface === 'banner' && countdown ? countdown : ui.description
  return (
    <View style={{ borderRadius: 18, backgroundColor: theme.hover, padding: 6 }}>
      <Animated.View
        key={`${ui.kind}:${ui.title}:${ui.detail ?? ''}`}
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
        <AppText variant="text-13-regular" style={{ color: theme.muted, lineHeight: 19 }}>
          {doing}
        </AppText>
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
  }
}
