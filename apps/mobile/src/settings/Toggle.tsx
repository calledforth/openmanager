import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from 'react-native-reanimated'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'

const KNOB_SLIDE = { duration: 180, easing: Easing.out(Easing.cubic) }
const TRACK_W = 44
const TRACK_H = 26
const KNOB = 20

/**
 * On or off, as a fill: the track takes the action fill when on, the active
 * fill when off, and the knob slides across. Both run on the UI thread
 * (180 ms eased); a toggle that is waiting for the environment's answer is
 * dimmed and does nothing.
 */
export function Toggle({
  value,
  onChange,
  label,
  disabled,
}: {
  value: boolean
  onChange: () => void
  label: string
  disabled?: boolean
}) {
  const theme = usePhoneTheme()
  const progress = useDerivedValue(() => withTiming(value ? 1 : 0, KNOB_SLIDE), [value])
  const off = theme.active
  const on = theme.actionBg
  const knobOff = theme.muted
  const knobOn = theme.actionFg
  const track = useAnimatedStyle(
    () => ({ backgroundColor: interpolateColor(progress.value, [0, 1], [off, on]) }),
    [off, on],
  )
  const knob = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(progress.value, [0, 1], [knobOff, knobOn]),
      transform: [{ translateX: progress.value * (TRACK_W - KNOB - 6) }],
    }),
    [knobOff, knobOn],
  )
  return (
    <Press
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={9}
      onPress={() => {
        tap()
        onChange()
      }}
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <Animated.View
        style={[{ width: TRACK_W, height: TRACK_H, borderRadius: TRACK_H / 2, padding: 3 }, track]}
      >
        <Animated.View style={[{ width: KNOB, height: KNOB, borderRadius: KNOB / 2 }, knob]} />
      </Animated.View>
    </Press>
  )
}
