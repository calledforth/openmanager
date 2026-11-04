import { XIcon } from 'phosphor-react-native'
import { Modal, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { IconButton } from '../../ui/IconButton'

const MIN_SCALE = 1
const MAX_SCALE = 6

/**
 * An image at full size, over everything: pinch to zoom, drag to pan while
 * zoomed, double-tap to zoom in and back out, a tap or the ✕ to close. A
 * native modal, so it sits above the page, its dock and the keyboard, and
 * Android's Back closes it.
 */
export function ImageViewer({ uri, onClose }: { uri: string; onClose: () => void }) {
  const theme = usePhoneTheme()
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const savedTx = useSharedValue(0)
  const savedTy = useSharedValue(0)

  const reset = () => {
    'worklet'
    scale.value = withTiming(1)
    savedScale.value = 1
    tx.value = withTiming(0)
    ty.value = withTiming(0)
    savedTx.value = 0
    savedTy.value = 0
  }

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * event.scale))
    })
    .onEnd(() => {
      savedScale.value = scale.value
      if (scale.value <= MIN_SCALE) reset()
    })
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onUpdate((event) => {
      if (scale.value <= MIN_SCALE) return
      tx.value = savedTx.value + event.translationX
      ty.value = savedTy.value + event.translationY
    })
    .onEnd(() => {
      savedTx.value = tx.value
      savedTy.value = ty.value
    })
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      if (scale.value > MIN_SCALE) {
        reset()
        return
      }
      // Zoom in around the tapped point.
      const next = 2.5
      scale.value = withTiming(next)
      savedScale.value = next
      const dx = (window.width / 2 - event.x) * (next - 1)
      const dy = (window.height / 2 - event.y) * (next - 1)
      tx.value = withTiming(dx)
      ty.value = withTiming(dy)
      savedTx.value = dx
      savedTy.value = dy
    })
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      if (scale.value <= MIN_SCALE) runOnJS(onClose)()
    })
  const gesture = Gesture.Race(
    Gesture.Exclusive(doubleTap, singleTap),
    Gesture.Simultaneous(pinch, pan),
  )

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }))

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
        <GestureDetector gesture={gesture}>
          <Animated.View style={StyleSheet.absoluteFill}>
            <Animated.Image
              source={{ uri }}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
              style={[StyleSheet.absoluteFill, imageStyle]}
            />
          </Animated.View>
        </GestureDetector>
        <View
          pointerEvents="box-none"
          style={{ position: 'absolute', top: insets.top + 8, right: 16 }}
        >
          <IconButton label="Close" surface="fill" onPress={onClose}>
            <XIcon size={18} color={theme.fg} weight="bold" />
          </IconButton>
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}
