import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { focusAccessibility } from './a11y-focus'
import { Glass } from './Glass'

/**
 * The one motion every sheet uses: the scrim fades, the sheet rises from the
 * bottom edge, both short and eased with no bounce. Reanimated's layout
 * animations, so they run on the UI thread and nothing is driven per frame
 * from JavaScript.
 */
export const SHEET_IN = SlideInDown.duration(220).easing(Easing.out(Easing.cubic))
export const SHEET_OUT = SlideOutDown.duration(180).easing(Easing.in(Easing.cubic))
export const SCRIM_IN = FadeIn.duration(180)
export const SCRIM_OUT = FadeOut.duration(160)

/**
 * A bottom sheet over the screen: a faint scrim, then the glass sheet with
 * its grabber. Mount it to show it and unmount it to hide it; the motion is
 * the same either way. `onDismiss`, when given, is what a tap on the scrim
 * does; without it the scrim only blocks the screen.
 *
 * It is modal to a screen reader: the sheet is marked modal
 * (`accessibilityViewIsModal`, VoiceOver), the screen under it hides itself
 * while it is open (`coveredBySheet`, TalkBack and VoiceOver), focus moves to
 * `initialFocus` when it opens and back to `returnFocus` when it closes.
 * With `onBack`, Android's Back button is that (Cancel, say) and goes no
 * further while the sheet is open.
 */
export function Sheet({
  onDismiss,
  onBack,
  initialFocus,
  returnFocus,
  children,
}: {
  onDismiss?: () => void
  /** What Android's Back does while the sheet is open; Back is kept from the screen. */
  onBack?: () => void
  initialFocus?: RefObject<unknown>
  returnFocus?: RefObject<unknown>
  children: ReactNode
}) {
  const theme = usePhoneTheme()
  const insets = useSafeAreaInsets()
  const back = useRef(onBack)
  back.current = onBack
  const handlesBack = onBack !== undefined
  useEffect(() => {
    if (!handlesBack) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      back.current?.()
      return true
    })
    return () => subscription.remove()
  }, [handlesBack])
  useEffect(() => {
    const cancel = initialFocus ? focusAccessibility(initialFocus) : () => undefined
    return () => {
      cancel()
      if (returnFocus) focusAccessibility(returnFocus)
    }
    // Once per opening: the refs are read when it opens and when it closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View entering={SCRIM_IN} exiting={SCRIM_OUT} style={StyleSheet.absoluteFill}>
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          disabled={!onDismiss}
          onPress={onDismiss}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        entering={SHEET_IN}
        exiting={SHEET_OUT}
        style={{ position: 'absolute', left: 8, right: 8, bottom: Math.max(insets.bottom, 8) }}
      >
        <Glass
          strength="sheet"
          shadow="float"
          radius={28}
          contentStyle={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.faint,
              opacity: 0.5,
              marginBottom: 14,
            }}
          />
          {children}
        </Glass>
      </Animated.View>
    </View>
  )
}
