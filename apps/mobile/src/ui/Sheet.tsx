import type { ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { usePhoneTheme } from '../theme/ThemeProvider'
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
 */
export function Sheet({ onDismiss, children }: { onDismiss?: () => void; children: ReactNode }) {
  const theme = usePhoneTheme()
  const insets = useSafeAreaInsets()
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
