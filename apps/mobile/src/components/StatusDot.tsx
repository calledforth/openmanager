import { useEffect } from 'react'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

import { basisDark, basisLight } from '../theme/tokens'
import { useTheme } from '../theme/ThemeProvider'

// Session status indicator (mirrors WorkspaceSidebarView mapping):
// active (running | busy | waiting) => pulsing `textStrong` dot;
// idle => static `textFaint` dot. The pulse ports the desktop shimmer as a
// reanimated opacity loop between textStrong and textMuted.

const SIZE = 7

export function StatusDot({ active }: { active: boolean }) {
  const { resolved } = useTheme()
  const tokens = resolved === 'dark' ? basisDark : basisLight
  const opacity = useSharedValue(1)

  useEffect(() => {
    if (active) {
      opacity.value = withRepeat(withTiming(0.35, { duration: 750 }), -1, true)
    } else {
      cancelAnimation(opacity)
      opacity.value = 1
    }

    return () => cancelAnimation(opacity)
  }, [active, opacity])

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))

  return (
    <Animated.View
      style={[
        {
          width: SIZE,
          height: SIZE,
          borderRadius: SIZE / 2,
          backgroundColor: active ? tokens.textStrong : tokens.textFaint,
        },
        active ? animatedStyle : null,
      ]}
    />
  )
}
