import { useState, type ReactNode } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * What the shared sheet leaves around its content: the gap above it under
 * the status bar, its own padding (10 top, 14 bottom), the grabber (4 plus
 * 14 under it) and its bottom inset.
 */
const SHEET_CHROME = 10 + 14 + 4 + 14 + 12

/**
 * A sheet's content that never runs off the screen: the body scrolls within
 * what the window leaves (after the safe areas, the sheet's own chrome and
 * the footer as measured, so a larger font scale is accounted for), and the
 * footer's actions stay pinned under it, always reachable.
 */
export function SheetBody({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const { height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const [footerHeight, setFooterHeight] = useState(0)
  const maxHeight = Math.max(
    120,
    height - insets.top - Math.max(insets.bottom, 8) - SHEET_CHROME - footerHeight,
  )
  return (
    <View>
      <ScrollView
        style={{ maxHeight }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      <View onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}>{footer}</View>
    </View>
  )
}
