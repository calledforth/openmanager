import { CaretRightIcon } from 'phosphor-react-native'
import { useEffect } from 'react'
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'

/** How long a fold or unfold takes: short, eased, on the UI thread. */
export const DISCLOSURE_MS = 180

/** A body revealed by the reader fades in; one shown from the start just appears. */
export const revealBody = FadeIn.duration(DISCLOSURE_MS).easing(Easing.out(Easing.quad))

/**
 * The chevron of a fold: pointing right when shut, down when open, turning
 * between the two on the UI thread. Only a tap changes `open`, never a token.
 */
export function DisclosureChevron({
  open,
  color,
  size = 12,
}: {
  open: boolean
  color: string
  size?: number
}) {
  const turn = useSharedValue(open ? 1 : 0)
  useEffect(() => {
    turn.value = withTiming(open ? 1 : 0, {
      duration: DISCLOSURE_MS,
      easing: Easing.out(Easing.quad),
    })
  }, [open, turn])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 90}deg` }] }))
  return (
    <Animated.View style={style}>
      <CaretRightIcon size={size} color={color} weight="bold" />
    </Animated.View>
  )
}
