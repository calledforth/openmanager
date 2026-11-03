import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { GlassLayer, type GlassTarget } from './Glass'
import type { TabTargets } from './glass-target'

/** The tabs' targets, for the tab bar; none above the tabs. */
export const TabTargetsContext = createContext<TabTargets | null>(null)

/**
 * A page: one glass layer the size of the screen, on the canvas. Its
 * `GlassContent` (the header's words, the list) is what its glass blurs;
 * the header's buttons (`ScreenBar`), the dock, the jump-to-latest button,
 * its sheets and popovers sit beside the content, over it. A tab's screen
 * names its tab, so the tab bar (drawn by the tabs, beside every screen)
 * blurs the one in front.
 */
export function Screen({
  tab,
  style,
  children,
}: {
  /** The tab this screen is, by route name; none for a page above the tabs. */
  tab?: string
  style?: StyleProp<ViewStyle>
  children: ReactNode
}) {
  const theme = usePhoneTheme()
  const tabs = useContext(TabTargetsContext)
  const onTarget = useCallback(
    (target: GlassTarget | null) => {
      if (tab && tabs) tabs.set(tab, target)
    },
    [tab, tabs],
  )
  return (
    <GlassLayer
      onTarget={tab ? onTarget : undefined}
      style={[{ flex: 1, backgroundColor: theme.bg }, style]}
    >
      {children}
    </GlassLayer>
  )
}

/**
 * A header's glass buttons, over the header row the content leaves room for
 * (`top`, `height`): beside the content rather than in it, since glass in
 * the content would blur itself. First in the screen, so a screen reader
 * meets back before the page; drawn above the content all the same.
 */
export function ScreenBar({
  top,
  height,
  inset = 20,
  left,
  right,
}: {
  top: number
  height: number
  /** From the screen's sides. */
  inset?: number
  left?: ReactNode
  right?: ReactNode
}) {
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        zIndex: 1,
        top,
        left: inset,
        right: inset,
        height,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <View>{left}</View>
      <View>{right}</View>
    </View>
  )
}
