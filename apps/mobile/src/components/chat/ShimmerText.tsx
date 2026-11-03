import { useEffect } from 'react'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { AppText, type AppTextVariant } from '../ui/AppText'

// Ports the desktop `.shimmer-text` running indicator. React Native can't do a
// background-clip text gradient cheaply, so the "working" pulse is an opacity
// loop on the UI thread: it runs on its own, never restarted by a re-render.
// The colour is inline: class colours do not reach native views.

export function ShimmerText({
  children,
  variant = 'text-14-regular',
  numberOfLines,
}: {
  children: string
  variant?: AppTextVariant
  numberOfLines?: number
}) {
  const theme = usePhoneTheme()
  const opacity = useSharedValue(1)

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.4, { duration: 800, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    )
    return () => cancelAnimation(opacity)
  }, [opacity])

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))

  return (
    <Animated.View style={animatedStyle}>
      <AppText variant={variant} numberOfLines={numberOfLines} style={{ color: theme.muted }}>
        {children}
      </AppText>
    </Animated.View>
  )
}
