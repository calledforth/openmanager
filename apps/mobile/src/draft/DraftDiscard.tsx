import { ArrowUUpLeftIcon, TrashIcon, XIcon } from 'phosphor-react-native'
import { useEffect, useRef } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useSidebarDrafts } from '@openmanager/app-core/providers/sidebar-provider'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { focusAccessibility } from '../ui/a11y-focus'
import { Glass } from '../ui/Glass'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'

/** The notice fades in and out: short, eased, on the UI thread. */
const NOTICE_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const NOTICE_OUT = FadeOut.duration(150).easing(Easing.in(Easing.quad))

/** The height the floating pill nav takes from the bottom edge, with its gap. */
export function pillNavClearance(bottomInset: number) {
  return Math.max(bottomInset, 16) + 12 + 56 + 10
}

/**
 * "Draft discarded" with Undo, floating over the home just above the pill
 * nav while the discard waits out its window (the shared
 * `EnvironmentSidebarDraftsProvider` keeps the clock and makes the delete).
 * A finger on Undo holds the window open; ✕ lets the discard go now. With a
 * screen reader on, the window is held until one of the two is chosen, and
 * focus goes to Undo, as web's keyboard discard does.
 */
export function DraftDiscardToast() {
  const drafts = useSidebarDrafts()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const undoRef = useRef<View>(null)
  const pending = drafts?.pendingDiscard ?? null
  const key = pending?.key ?? null
  const hold = drafts?.holdDiscard

  useEffect(() => {
    if (key === null || !hold) return
    let cancelled = false
    let cancelFocus: (() => void) | undefined
    AccessibilityInfo.announceForAccessibility('Draft discarded. Undo is available.')
    void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      if (cancelled || !on) return
      hold(true, key)
      cancelFocus = focusAccessibility(undoRef)
    })
    return () => {
      cancelled = true
      cancelFocus?.()
    }
  }, [hold, key])

  if (!drafts || !pending) return null
  return (
    <Animated.View
      key={pending.key}
      entering={NOTICE_IN}
      exiting={NOTICE_OUT}
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 16, right: 16, bottom: pillNavClearance(insets.bottom) }}
    >
      <Glass
        strength="strong"
        radius={18}
        contentStyle={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingLeft: 14,
          paddingRight: 6,
          paddingVertical: 6,
        }}
      >
        <TrashIcon size={16} color={theme.muted} />
        <AppText
          variant="text-14-regular"
          numberOfLines={1}
          style={{ color: theme.fg, flex: 1, minWidth: 0 }}
        >
          Draft discarded
        </AppText>
        <Press
          ref={undoRef}
          accessibilityRole="button"
          accessibilityLabel="Undo discard"
          onPressIn={() => drafts.holdDiscard(true, pending.key)}
          onPressOut={() => drafts.holdDiscard(false, pending.key)}
          onPress={() => {
            tap()
            drafts.undoDiscard(pending.key)
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            height: 34,
            paddingHorizontal: 12,
            borderRadius: 999,
            backgroundColor: pressed ? theme.active : theme.hover,
          })}
        >
          <ArrowUUpLeftIcon size={14} color={theme.fg} weight="bold" />
          <AppText variant="text-14-medium" style={{ color: theme.fg }}>
            Undo
          </AppText>
        </Press>
        <Press
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={4}
          onPress={() => drafts.confirmDiscard(pending.key)}
          style={({ pressed }) => ({
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? theme.hover : 'transparent',
          })}
        >
          <XIcon size={15} color={theme.muted} />
        </Press>
      </Glass>
    </Animated.View>
  )
}
