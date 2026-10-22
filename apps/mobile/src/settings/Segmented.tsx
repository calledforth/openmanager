import { useState } from 'react'
import { View, type LayoutChangeEvent } from 'react-native'
import Animated, { Easing, useAnimatedStyle, withTiming } from 'react-native-reanimated'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'

const THUMB_SLIDE = { duration: 200, easing: Easing.out(Easing.cubic) }

/**
 * The mockup's segmented track (`.seg`): a hover-filled track with the
 * chosen segment on a raised fill (glass-strong plus the resting float
 * shadow). The thumb slides to a new choice on the UI thread, 200 ms eased,
 * no spring; until the track has been measured it sits without moving.
 */
export function Segmented<Key extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ key: Key; label: string }>
  value: Key
  onChange: (key: Key) => void
  /** What the group is, for a screen reader. */
  label: string
}) {
  const theme = usePhoneTheme()
  const [width, setWidth] = useState(0)
  const index = Math.max(
    0,
    options.findIndex((option) => option.key === value),
  )
  const segment = width > 0 ? (width - 6) / options.length : 0
  const thumb = useAnimatedStyle(
    () => ({
      transform: [{ translateX: withTiming(index * segment, THUMB_SLIDE) }],
    }),
    [index, segment],
  )
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={{ flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: theme.hover }}
    >
      {segment > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              top: 3,
              bottom: 3,
              left: 3,
              width: segment,
              borderRadius: 9,
              backgroundColor: theme.glassStrong,
              boxShadow: theme.shadow.rest,
            },
            thumb,
          ]}
        />
      ) : null}
      {options.map((option) => {
        const on = option.key === value
        return (
          <Press
            key={option.key}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={option.label}
            onPress={() => {
              if (on) return
              tap()
              onChange(option.key)
            }}
            style={{
              flex: 1,
              alignItems: 'center',
              paddingVertical: 7,
              borderRadius: 9,
              // Before the track is measured, the chosen one is filled in place.
              backgroundColor: on && segment === 0 ? theme.glassStrong : 'transparent',
            }}
          >
            <AppText
              variant="text-13-medium"
              style={{ color: on ? theme.fg : theme.muted, fontSize: 13.5 }}
            >
              {option.label}
            </AppText>
          </Press>
        )
      })}
    </View>
  )
}
