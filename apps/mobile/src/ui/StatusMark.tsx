import { CheckIcon } from 'phosphor-react-native'
import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

import type { StatusMark as Mark } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { AppText } from '../components/ui/AppText'

/**
 * One glyph per session state, the colours from `--status-*`: a violet ring
 * turning while it works, a slower blue one for background work, an amber
 * "!" when it needs you, a pink "?" for a question, a green tick when it
 * finished since you looked, a red "×" when it failed, a hollow ring at rest.
 * A glyph on a fill takes the scheme's canvas or ink, whichever reads better
 * on that fill (`theme.statusInk`).
 */
export function StatusMark({ mark, size = 14 }: { mark: Mark; size?: number }) {
  const theme = usePhoneTheme()
  switch (mark) {
    case 'working':
      return <Spinner color={theme.status.working} size={size - 2} periodMs={1100} />
    case 'background':
      return (
        <Spinner color={theme.status.background} size={size - 2} periodMs={2200} opacity={0.8} />
      )
    case 'needs':
      return <Disc color={theme.status.needs} ink={theme.statusInk.needs} size={size} glyph="!" />
    case 'question':
      return (
        <Disc color={theme.status.question} ink={theme.statusInk.question} size={size} glyph="?" />
      )
    case 'error':
      return <Disc color={theme.status.error} ink={theme.statusInk.error} size={size} glyph="×" />
    case 'done':
      return (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.status.done,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CheckIcon size={size - 5} color={theme.statusInk.done} weight="bold" />
        </View>
      )
    default:
      return (
        <View
          style={{
            width: size - 2,
            height: size - 2,
            borderRadius: size / 2,
            borderWidth: 1.5,
            borderColor: theme.faint,
          }}
        />
      )
  }
}

function Disc({
  color,
  ink,
  size,
  glyph,
}: {
  color: string
  ink: string
  size: number
  glyph: string
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AppText
        variant="text-10-medium"
        style={{ color: ink, fontWeight: '700', lineHeight: size, fontSize: size * 0.72 }}
      >
        {glyph}
      </AppText>
    </View>
  )
}

function Spinner({
  color,
  size,
  periodMs,
  opacity = 1,
}: {
  color: string
  size: number
  periodMs: number
  opacity?: number
}) {
  const turn = useSharedValue(0)
  useEffect(() => {
    turn.value = 0
    turn.value = withRepeat(withTiming(1, { duration: periodMs, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(turn)
  }, [periodMs, turn])
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }))
  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 2.5,
          borderColor: color,
          borderRightColor: 'transparent',
          opacity,
        },
        spin,
      ]}
    />
  )
}
