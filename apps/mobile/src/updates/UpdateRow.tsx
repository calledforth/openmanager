import Constants from 'expo-constants'
import { ArrowCircleUpIcon, XIcon } from 'phosphor-react-native'
import { useEffect, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { SettingsRow } from '../settings/SettingsRow'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Press } from '../ui/Press'
import { useUpdater } from './useUpdater'
import { showsHomeNotice, updateRowView } from './view'

const NOTICE_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const NOTICE_OUT = FadeOut.duration(150).easing(Easing.in(Easing.quad))

/** The percent, and a thin fill that eases to it on the UI thread. */
function Progress({ words, percent }: { words: string; percent: number }) {
  const theme = usePhoneTheme()
  const width = useSharedValue(percent)
  useEffect(() => {
    width.value = withTiming(percent, { duration: 180, easing: Easing.out(Easing.quad) })
  }, [percent, width])
  const fill = useAnimatedStyle(() => ({ width: `${width.value}%` }))
  return (
    <>
      <AppText variant="text-12-regular" style={{ color: theme.muted }}>
        {words}
      </AppText>
      <View
        style={{
          height: 3,
          marginTop: 6,
          borderRadius: 2,
          overflow: 'hidden',
          backgroundColor: theme.active,
        }}
      >
        <Animated.View style={[{ height: 3, backgroundColor: theme.fg }, fill]} />
      </View>
    </>
  )
}

/** The Settings row: where this copy of the app stands, in every state. */
export function UpdateRow({ trailing }: { trailing?: ReactNode }) {
  const theme = usePhoneTheme()
  const update = useUpdater()
  if (!update) return null
  const { updater, state } = update
  const view = updateRowView(state, Constants.expoConfig?.version ?? '—')
  const { action, percent } = view
  return (
    <SettingsRow
      icon={<ArrowCircleUpIcon size={17} color={theme.muted} />}
      title={view.title}
      sub={percent === undefined ? view.sub : <Progress words={view.sub} percent={percent} />}
      trailing={trailing}
      accessibilityLabel={`${view.title}. ${view.sub}`}
      onPress={
        action === null
          ? undefined
          : () => void (action === 'check' ? updater.check() : updater.update())
      }
    />
  )
}

/** The home's offer of an update; put away, it stays away until a newer one. */
export function UpdateNotice() {
  const theme = usePhoneTheme()
  const update = useUpdater()
  if (!update || !showsHomeNotice(update.state, update.updater.dismissedBuild())) return null
  const { updater, state } = update
  const canDismiss = state.kind === 'available' || state.kind === 'download_failed'
  return (
    <Animated.View
      entering={NOTICE_IN}
      exiting={NOTICE_OUT}
      style={{ marginHorizontal: 4, marginTop: 4, borderRadius: 16, backgroundColor: theme.hover }}
    >
      <UpdateRow
        trailing={
          canDismiss ? (
            <Press
              accessibilityRole="button"
              accessibilityLabel="Not now"
              hitSlop={6}
              onPress={() => updater.dismiss()}
              style={({ pressed }) => ({
                width: 30,
                height: 30,
                borderRadius: 15,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: pressed ? theme.active : 'transparent',
              })}
            >
              <XIcon size={14} color={theme.muted} />
            </Press>
          ) : undefined
        }
      />
    </Animated.View>
  )
}
