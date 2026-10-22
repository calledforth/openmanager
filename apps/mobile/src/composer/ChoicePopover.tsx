import { CheckIcon } from 'phosphor-react-native'
import { useEffect, type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native'
import Animated, {
  Easing,
  FadeOut,
  withTiming,
  type EntryAnimationsValues,
} from 'react-native-reanimated'
import type { ComposerChoice } from '@openmanager/app-core/logic'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { SCRIM_IN, SCRIM_OUT } from '../ui/Sheet'
import type { PickAnchor } from './ui-state'

/**
 * A popover grows out of its pick: from 96% and clear to full size, 200 ms
 * eased, no overshoot; it fades out in 150 ms. Worklets, on the UI thread.
 */
export function popoverIn() {
  'worklet'
  const timing = { duration: 200, easing: Easing.out(Easing.cubic) }
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.96 }] },
    animations: {
      opacity: withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) }),
      transform: [{ scale: withTiming(1, timing) }],
    },
  }
}
export const POPOVER_OUT = FadeOut.duration(150).easing(Easing.in(Easing.quad))
// Typed for Reanimated's `entering`: it calls the worklet with the view's values.
const entering = popoverIn as unknown as (
  values: EntryAnimationsValues,
) => ReturnType<typeof popoverIn>

/** Wide enough for the hints when the provider gives any; the mockup's 164 when not. */
const widthFor = (choices: readonly ComposerChoice[]) =>
  choices.some((choice) => choice.description) ? 244 : 172

/**
 * A popover of choices standing on the pick that opened it (mode, effort):
 * glass, the current one filled and ticked, a hint beside a label where the
 * provider gives one. A tap outside or Android's Back closes it.
 */
export function ChoicePopover({
  anchor,
  label,
  choices,
  current,
  icon,
  onPick,
  onClose,
}: {
  anchor: PickAnchor
  label: string
  choices: readonly ComposerChoice[]
  current: string
  icon?: (choice: ComposerChoice) => ReactNode
  onPick: (id: string) => void
  onClose: () => void
}) {
  const theme = usePhoneTheme()
  const { width, height } = useWindowDimensions()
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose()
      return true
    })
    return () => subscription.remove()
  }, [onClose])
  const popoverWidth = widthFor(choices)
  const left = Math.max(8, Math.min(anchor.x, width - popoverWidth - 8))
  const bottom = Math.max(8, height - anchor.y + 8)
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View entering={SCRIM_IN} exiting={SCRIM_OUT} style={StyleSheet.absoluteFill}>
        <Pressable
          accessibilityLabel={`Close ${label}`}
          accessibilityRole="button"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        entering={entering}
        exiting={POPOVER_OUT}
        style={{
          position: 'absolute',
          left,
          bottom,
          width: popoverWidth,
          transformOrigin: 'bottom left',
        }}
      >
        <Glass strength="sheet" shadow="float" radius={14} contentStyle={{ padding: 6 }}>
          <View accessibilityRole="menu" accessibilityLabel={label}>
            {choices.map((choice) => {
              const on = choice.id === current
              return (
                <Press
                  key={choice.id}
                  accessibilityRole="menuitem"
                  accessibilityLabel={choice.name}
                  accessibilityHint={choice.description}
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    tap()
                    onPick(choice.id)
                    onClose()
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    paddingVertical: 9,
                    paddingHorizontal: 10,
                    borderRadius: 10,
                    backgroundColor: on ? theme.active : pressed ? theme.hover : 'transparent',
                  })}
                >
                  {icon ? icon(choice) : null}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText
                      variant="text-14-regular"
                      numberOfLines={1}
                      style={{ color: theme.fg }}
                    >
                      {choice.name}
                    </AppText>
                    {choice.description ? (
                      <AppText
                        variant="text-12-regular"
                        numberOfLines={2}
                        style={{ color: theme.faint }}
                      >
                        {choice.description}
                      </AppText>
                    ) : null}
                  </View>
                  <View style={{ width: 14 }}>
                    {on ? <CheckIcon size={14} color={theme.fg} weight="bold" /> : null}
                  </View>
                </Press>
              )
            })}
          </View>
        </Glass>
      </Animated.View>
    </View>
  )
}
