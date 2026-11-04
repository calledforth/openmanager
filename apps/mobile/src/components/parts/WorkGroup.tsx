import { useRef, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'

import { countRender } from '../../session/render-probe'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { Press } from '../../ui/Press'
import { ShimmerText } from '../chat/ShimmerText'
import { AppText } from '../ui/AppText'
import { DisclosureChevron, revealBody } from './Disclosure'

/**
 * A fold of work on a fill (no outline): a chevron, what the work was, and
 * on the right how much of it or how long. A live run of tools shows its
 * rows; a settled turn's work stays folded under "Worked for 14s" until the
 * reader opens it. The reader's tap is the only thing that folds or unfolds
 * it, and only then does the body fade in.
 */
export function WorkGroup({
  label,
  meta,
  running = false,
  defaultOpen = false,
  children,
}: {
  label: string
  meta?: string
  /** The label shimmers while the work is still going. */
  running?: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  countRender('WorkGroup')
  const theme = usePhoneTheme()
  const [open, setOpen] = useState(defaultOpen)
  // The reader opened it: the body fades in. Shown from the start (or after a
  // scroll brings the row back), it is simply there.
  const revealedRef = useRef(false)
  return (
    <View style={{ borderRadius: 12, backgroundColor: theme.hover, paddingHorizontal: 12 }}>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        hitSlop={4}
        onPress={() => {
          revealedRef.current = true
          setOpen((value) => !value)
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingVertical: 8,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <DisclosureChevron open={open} color={theme.faint} />
        <View style={{ flex: 1, minWidth: 0 }}>
          {running ? (
            <ShimmerText variant="text-13-regular" numberOfLines={1}>
              {label}
            </ShimmerText>
          ) : (
            <AppText variant="text-13-regular" numberOfLines={1} style={{ color: theme.muted }}>
              {label}
            </AppText>
          )}
        </View>
        {meta ? (
          <AppText
            variant="text-12-regular"
            style={{ color: theme.faint, fontVariant: ['tabular-nums'] }}
          >
            {meta}
          </AppText>
        ) : null}
      </Press>
      {open ? (
        <Animated.View
          entering={revealedRef.current ? revealBody : undefined}
          style={{ paddingBottom: 8, gap: 6 }}
        >
          {children}
        </Animated.View>
      ) : null}
    </View>
  )
}
