import type { ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { usePhoneTheme } from '../theme/ThemeProvider'
import { GlassLayer } from './Glass'

/**
 * A page: one glass layer the size of the screen, on the canvas. Its
 * `GlassContent` (the header's words, the list) is what its glass blurs;
 * the header's buttons (`ScreenBar`), the dock, the jump-to-latest button,
 * its sheets and popovers sit beside the content, over it.
 */
export function Screen({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const theme = usePhoneTheme()
  return <GlassLayer style={[{ flex: 1, backgroundColor: theme.bg }, style]}>{children}</GlassLayer>
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
      {/* The left cluster may run the row (a title beside Back); the right keeps its size. */}
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>{left}</View>
      <View>{right}</View>
    </View>
  )
}
