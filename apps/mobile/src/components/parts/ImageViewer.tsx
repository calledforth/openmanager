import { StatusBar } from 'expo-status-bar'
import { CaretLeftIcon, CaretRightIcon, ImageBrokenIcon, XIcon } from 'phosphor-react-native'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Image, Modal, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  Easing,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { tap } from '../../ui/haptics'
import { Press } from '../../ui/Press'
import { AppText } from '../ui/AppText'
import { imageName, useImageSource, type GalleryImage } from './ImagePart'

const MIN_SCALE = 1
const MAX_SCALE = 6
const DOUBLE_TAP_SCALE = 2.5

/** Every motion here: short, eased, on the UI thread. */
const OPEN_MS = 200
const CLOSE_MS = 160
const PAGE_MS = 220
const SETTLE_MS = 180
const CHROME_MS = 150
const EASE_OUT = Easing.out(Easing.cubic)
const EASE_IN = Easing.in(Easing.quad)

/** A swipe pages once it has gone this far across, or this fast. */
const PAGE_PULL = 0.25
const PAGE_FLING = 600
/** A drag down (or up) closes once it has gone this far, or this fast. */
const DISMISS_PULL = 110
const DISMISS_FLING = 900
/** How far a finger moves before the swipe's direction is read. */
const AXIS_SLOP = 8

/** The chrome's colours: the backdrop is black whatever the scheme. */
const INK = 'rgba(255,255,255,0.88)'
const INK_DIM = 'rgba(255,255,255,0.35)'
const PILL = 'rgba(255,255,255,0.14)'
const PILL_PRESSED = 'rgba(255,255,255,0.28)'

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

type Zoom = {
  scale: SharedValue<number>
  tx: SharedValue<number>
  ty: SharedValue<number>
}

/**
 * One page of the strip, the width of the window: placed by how far it is
 * from the page in front (`page`) plus the drag under way, and zoomed only
 * while it is the one in front.
 */
function ViewerPage({
  image,
  index,
  width,
  height,
  page,
  drag,
  zoom,
}: {
  image: GalleryImage
  index: number
  width: number
  height: number
  page: SharedValue<number>
  drag: SharedValue<number>
  zoom: Zoom
}) {
  const { uri, failed } = useImageSource(image)
  const name = imageName(image)
  const style = useAnimatedStyle(() => {
    const current = page.value === index
    return {
      transform: [
        { translateX: (index - page.value) * width + drag.value + (current ? zoom.tx.value : 0) },
        { translateY: current ? zoom.ty.value : 0 },
        { scale: current ? zoom.scale.value : 1 },
      ],
    }
  })
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }, style]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          resizeMode="contain"
          accessibilityLabel={name}
          accessibilityIgnoresInvertColors
          style={{ width, height }}
        />
      ) : failed ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ImageBrokenIcon size={16} color={INK_DIM} />
          <AppText variant="text-13-regular" style={{ color: INK_DIM }}>
            {name} is unavailable
          </AppText>
        </View>
      ) : null}
    </Animated.View>
  )
}

/** A round control on the backdrop: a fill, pressed a stronger one. */
function ViewerButton({
  label,
  disabled = false,
  onPress,
  children,
}: {
  label: string
  disabled?: boolean
  onPress: () => void
  children: ReactNode
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? PILL_PRESSED : PILL,
        opacity: disabled ? 0.35 : 1,
      })}
    >
      {children}
    </Press>
  )
}

/**
 * A group's images at full size, over everything, opened on the one that was
 * tapped: swipe across to page through the group, pinch to zoom, drag to pan
 * while zoomed (paging waits until the image is back to size), double-tap to
 * zoom in and back out, a tap to hide and show the chrome, a drag down (or
 * up), the ✕ or Android's Back to close. A native modal, so it sits above
 * the page, its dock and the keyboard. Every motion runs on the UI thread.
 */
export function ImageViewer({
  images,
  index: initial,
  onClose,
}: {
  images: readonly GalleryImage[]
  /** The image it opens on. */
  index: number
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const count = images.length
  const [index, setIndex] = useState(() => clamp(initial, 0, Math.max(0, count - 1)))
  const [chromeShown, setChromeShown] = useState(true)

  // The strip: which page is in front, and the drag across it under way.
  const page = useSharedValue(index)
  const drag = useSharedValue(0)
  // The swipe's direction once read: 0 not yet, 1 across (paging), 2 down (closing).
  const axis = useSharedValue(0)
  // The drag down under way, and the backdrop it thins.
  const lift = useSharedValue(0)
  const backdrop = useSharedValue(0)
  // The whole viewer's arrival (0 → 1) and leaving (1 → 0).
  const enter = useSharedValue(0)
  const closing = useSharedValue(false)
  const chrome = useSharedValue(1)
  // The page in front's zoom.
  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const savedTx = useSharedValue(0)
  const savedTy = useSharedValue(0)

  useEffect(() => {
    backdrop.value = withTiming(1, { duration: OPEN_MS, easing: EASE_OUT })
    enter.value = withTiming(1, { duration: OPEN_MS, easing: EASE_OUT })
  }, [backdrop, enter])
  useEffect(() => {
    chrome.value = withTiming(chromeShown ? 1 : 0, { duration: CHROME_MS })
  }, [chrome, chromeShown])

  const finish = useCallback(() => onClose(), [onClose])
  const toggleChrome = useCallback(() => setChromeShown((shown) => !shown), [])

  /** Fades out, then is gone; once. */
  const close = useCallback(() => {
    'worklet'
    if (closing.value) return
    closing.value = true
    backdrop.value = withTiming(0, { duration: CLOSE_MS, easing: EASE_IN })
    if (lift.value !== 0) {
      lift.value = withTiming(lift.value + Math.sign(lift.value) * height * 0.25, {
        duration: CLOSE_MS,
        easing: EASE_IN,
      })
    }
    enter.value = withTiming(0, { duration: CLOSE_MS, easing: EASE_IN }, (done) => {
      if (done) runOnJS(finish)()
    })
  }, [backdrop, closing, enter, finish, height, lift])

  /** Slides the strip to `next`, which becomes the page in front at once. */
  const goTo = useCallback(
    (next: number) => {
      'worklet'
      const from = page.value
      if (next !== from) {
        page.value = next
        // The same spot on screen, measured from the new page.
        drag.value = drag.value + (next - from) * width
        runOnJS(setIndex)(next)
      }
      drag.value = withTiming(0, { duration: PAGE_MS, easing: EASE_OUT })
    },
    [drag, page, width],
  )
  const step = useCallback(
    (delta: number) => {
      const next = clamp(index + delta, 0, count - 1)
      if (next !== index) runOnUI(goTo)(next)
    },
    [count, goTo, index],
  )
  const resetZoom = useCallback(() => {
    'worklet'
    scale.value = withTiming(1, { duration: SETTLE_MS, easing: EASE_OUT })
    savedScale.value = 1
    tx.value = withTiming(0, { duration: SETTLE_MS, easing: EASE_OUT })
    ty.value = withTiming(0, { duration: SETTLE_MS, easing: EASE_OUT })
    savedTx.value = 0
    savedTy.value = 0
  }, [savedScale, savedTx, savedTy, scale, tx, ty])

  const pan = Gesture.Pan()
    .onStart(() => {
      axis.value = 0
    })
    .onUpdate((event) => {
      if (scale.value > MIN_SCALE) {
        // Zoomed: the finger moves the picture, within its edges.
        const limitX = (width * (scale.value - 1)) / 2
        const limitY = (height * (scale.value - 1)) / 2
        tx.value = clamp(savedTx.value + event.translationX, -limitX, limitX)
        ty.value = clamp(savedTy.value + event.translationY, -limitY, limitY)
        return
      }
      if (axis.value === 0) {
        if (Math.abs(event.translationX) < AXIS_SLOP && Math.abs(event.translationY) < AXIS_SLOP) {
          return
        }
        axis.value = Math.abs(event.translationX) > Math.abs(event.translationY) ? 1 : 2
      }
      if (axis.value === 1) {
        let dx = event.translationX
        // The ends give a little and no more.
        if ((page.value === 0 && dx > 0) || (page.value === count - 1 && dx < 0)) dx /= 3
        drag.value = dx
      } else {
        lift.value = event.translationY
        backdrop.value = Math.max(0.2, 1 - Math.abs(event.translationY) / (height * 0.5))
      }
    })
    .onEnd((event) => {
      if (scale.value > MIN_SCALE) {
        savedTx.value = tx.value
        savedTy.value = ty.value
        return
      }
      if (axis.value === 1) {
        let next = page.value
        if (event.translationX < -width * PAGE_PULL || event.velocityX < -PAGE_FLING) {
          next = Math.min(count - 1, page.value + 1)
        } else if (event.translationX > width * PAGE_PULL || event.velocityX > PAGE_FLING) {
          next = Math.max(0, page.value - 1)
        }
        goTo(next)
      } else if (axis.value === 2) {
        if (
          Math.abs(event.translationY) > DISMISS_PULL ||
          Math.abs(event.velocityY) > DISMISS_FLING
        ) {
          close()
        } else {
          lift.value = withTiming(0, { duration: SETTLE_MS, easing: EASE_OUT })
          backdrop.value = withTiming(1, { duration: SETTLE_MS, easing: EASE_OUT })
        }
      }
      axis.value = 0
    })
  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = clamp(savedScale.value * event.scale, MIN_SCALE, MAX_SCALE)
    })
    .onEnd(() => {
      savedScale.value = scale.value
      if (scale.value <= MIN_SCALE) {
        resetZoom()
        return
      }
      // Back within the picture's edges at the new size.
      const limitX = (width * (scale.value - 1)) / 2
      const limitY = (height * (scale.value - 1)) / 2
      savedTx.value = clamp(tx.value, -limitX, limitX)
      savedTy.value = clamp(ty.value, -limitY, limitY)
      tx.value = withTiming(savedTx.value, { duration: SETTLE_MS, easing: EASE_OUT })
      ty.value = withTiming(savedTy.value, { duration: SETTLE_MS, easing: EASE_OUT })
    })
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event) => {
      if (scale.value > MIN_SCALE) {
        resetZoom()
        return
      }
      // In, around the tapped point.
      const next = DOUBLE_TAP_SCALE
      const limitX = (width * (next - 1)) / 2
      const limitY = (height * (next - 1)) / 2
      const dx = clamp((width / 2 - event.x) * (next - 1), -limitX, limitX)
      const dy = clamp((height / 2 - event.y) * (next - 1), -limitY, limitY)
      scale.value = withTiming(next, { duration: PAGE_MS, easing: EASE_OUT })
      savedScale.value = next
      tx.value = withTiming(dx, { duration: PAGE_MS, easing: EASE_OUT })
      ty.value = withTiming(dy, { duration: PAGE_MS, easing: EASE_OUT })
      savedTx.value = dx
      savedTy.value = dy
    })
  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      runOnJS(toggleChrome)()
    })
  const gesture = Gesture.Race(
    Gesture.Exclusive(doubleTap, singleTap),
    Gesture.Simultaneous(pinch, pan),
  )

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }))
  const stripStyle = useAnimatedStyle(() => {
    // Arrives a touch small and grows to size; shrinks a little as it is dragged away.
    const pulled = Math.min(1, Math.abs(lift.value) / (height * 0.6))
    return {
      opacity: enter.value,
      transform: [
        { translateY: lift.value },
        { scale: (0.94 + 0.06 * enter.value) * (1 - 0.15 * pulled) },
      ],
    }
  })
  const chromeStyle = useAnimatedStyle(() => ({ opacity: chrome.value * enter.value }))

  const dismiss = useCallback(() => runOnUI(close)(), [close])
  // The page in front and its neighbours: the next one is there before a swipe reaches it.
  const mounted = images
    .map((image, at) => ({ image, at }))
    .filter(({ at }) => Math.abs(at - index) <= 1)
  const zoom: Zoom = { scale, tx, ty }

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={dismiss}
      accessibilityViewIsModal
    >
      <StatusBar style="light" />
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, backdropStyle]}
        />
        <GestureDetector gesture={gesture}>
          <Animated.View style={[StyleSheet.absoluteFill, stripStyle]}>
            {mounted.map(({ image, at }) => (
              <ViewerPage
                key={image.id}
                image={image}
                index={at}
                width={width}
                height={height}
                page={page}
                drag={drag}
                zoom={zoom}
              />
            ))}
          </Animated.View>
        </GestureDetector>
        <Animated.View
          pointerEvents={chromeShown ? 'box-none' : 'none'}
          style={[StyleSheet.absoluteFill, chromeStyle]}
        >
          <View
            pointerEvents="box-none"
            style={{ position: 'absolute', top: insets.top + 8, right: 16 }}
          >
            <ViewerButton label="Close" onPress={dismiss}>
              <XIcon size={18} color={INK} weight="bold" />
            </ViewerButton>
          </View>
          {count > 1 ? (
            <View
              pointerEvents="box-none"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: Math.max(insets.bottom, 12) + 10,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
              }}
            >
              <ViewerButton label="Previous image" disabled={index === 0} onPress={() => step(-1)}>
                <CaretLeftIcon size={16} color={INK} weight="bold" />
              </ViewerButton>
              <View
                accessibilityLiveRegion="polite"
                accessibilityLabel={`Image ${index + 1} of ${count}`}
                style={{
                  minWidth: 64,
                  alignItems: 'center',
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: 999,
                  backgroundColor: PILL,
                }}
              >
                <AppText
                  variant="text-12-medium"
                  style={{ color: INK, fontVariant: ['tabular-nums'] }}
                >
                  {index + 1} / {count}
                </AppText>
              </View>
              <ViewerButton
                label="Next image"
                disabled={index === count - 1}
                onPress={() => step(1)}
              >
                <CaretRightIcon size={16} color={INK} weight="bold" />
              </ViewerButton>
            </View>
          ) : null}
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  )
}
