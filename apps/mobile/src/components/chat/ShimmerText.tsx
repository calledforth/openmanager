import { useEffect } from 'react'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

import { AppText, type AppTextVariant } from '../ui/AppText'

// Ports the desktop `.shimmer-text` running indicator. RN can't do a
// background-clip text gradient cheaply, so — per plan §4.3 — we express the
// "working" pulse as a reanimated opacity loop between textStrong and textMuted.

export function ShimmerText({
  children,
  variant = 'text-14-regular',
  className,
}: {
  children: string
  variant?: AppTextVariant
  className?: string
}) {
  const opacity = useSharedValue(1)

  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.4, { duration: 800 }), -1, true)
    return () => cancelAnimation(opacity)
  }, [opacity])

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))

  return (
    <Animated.View style={animatedStyle}>
      <AppText
        variant={variant}
        className={['text-textMuted', className].filter(Boolean).join(' ')}
      >
        {children}
      </AppText>
    </Animated.View>
  )
}
