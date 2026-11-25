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
 * One branch of a work group's tree: an L from the header into the row it
 * holds, the way a file tree hangs a file under its folder (web's `TreeBranch`).
 */
export function TreeBranch({ children }: { children: ReactNode }) {
  const theme = usePhoneTheme()
  return (
    <View style={{ paddingLeft: 18 }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 5,
          top: 0,
          width: 8,
          height: 10,
          borderLeftWidth: 1,
          borderBottomWidth: 1,
          borderBottomLeftRadius: 4,
          borderColor: theme.border,
        }}
      />
      {children}
    </View>
  )
}

/**
 * A fold of work, flat on the page (no card): what the work was, how much of
 * it or how long, and a chevron at the end of the line. A live run of tools
 * shows its rows; a settled turn's work stays folded under "Worked for 14s"
 * until the reader opens it. The reader's tap is the only thing that folds
 * or unfolds it, and only then does the body fade in.
 *
 * A thought the agent is having right now (`live`) hangs under the folded
 * header on its own branch, its words streaming beneath it, and only it
 * shimmers. Once it ends it folds into the group, kept in its place among
 * the calls.
 */
export function WorkGroup({
  label,
  meta,
  running = false,
  defaultOpen = false,
  live,
  children,
}: {
  label: string
  meta?: string
  /** The label shimmers while the work is still going. */
  running?: boolean
  defaultOpen?: boolean
  /** The thought streaming now, drawn under the header while it is folded. */
  live?: ReactNode
  children: ReactNode
}) {
  countRender('WorkGroup')
  const theme = usePhoneTheme()
  const [open, setOpen] = useState(defaultOpen)
  // The reader opened it: the body fades in. Shown from the start (or after a
  // scroll brings the row back), it is simply there.
  const revealedRef = useRef(false)
  return (
    <View>
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
          gap: 6,
          paddingVertical: 4,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          {running ? (
            <ShimmerText variant="text-14-regular" numberOfLines={1}>
              {label}
            </ShimmerText>
          ) : (
            <AppText variant="text-14-regular" numberOfLines={1} style={{ color: theme.muted }}>
              {label}
            </AppText>
          )}
        </View>
        {meta ? (
          <AppText
            variant="text-14-regular"
            numberOfLines={1}
            style={{ color: theme.faint, fontVariant: ['tabular-nums'], flexShrink: 0 }}
          >
            {`· ${meta}`}
          </AppText>
        ) : null}
        <DisclosureChevron open={open} color={theme.faint} size={11} />
      </Press>
      {open ? (
        <Animated.View
          entering={revealedRef.current ? revealBody : undefined}
          // The group's spine, which the live thought's branch hangs from.
          style={{
            marginTop: 2,
            marginBottom: 6,
            marginLeft: 4,
            paddingLeft: 12,
            borderLeftWidth: 1,
            borderColor: theme.border,
            gap: 6,
          }}
        >
          {children}
        </Animated.View>
      ) : live ? (
        <View style={{ paddingBottom: 4 }}>
          <TreeBranch>{live}</TreeBranch>
        </View>
      ) : null}
    </View>
  )
}
