import { EyeIcon } from 'phosphor-react-native'
import { memo, type ReactNode } from 'react'
import { View, type LayoutChangeEvent } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { Glass } from '../ui/Glass'
import { StatusLine } from './StatusLine'
import type { StatusLineView } from './status-line'

/** The gap between the dock's parts, and around it. */
export const DOCK_GAP = 8
export const DOCK_SIDE = 12

/**
 * The bottom of the session page: the status line, then whatever answers
 * the session (the composer, or the prompt a pending request turns it
 * into), floating over the transcript, which runs under it. It sizes to
 * what it holds and says how tall it is (`onHeight`), so the transcript's
 * end and the scroll-to-latest button sit above it whatever goes in the
 * slot; the page is not laid out again for a taller composer.
 */
export const SessionDock = memo(function SessionDock({
  status,
  bottomInset,
  onHeight,
  children,
}: {
  status: StatusLineView | null
  /** The safe area below the dock (the home indicator, the gesture bar). */
  bottomInset: number
  onHeight: (height: number) => void
  /** The slot: the composer once it lands. */
  children: ReactNode
}) {
  const onLayout = (event: LayoutChangeEvent) => onHeight(event.nativeEvent.layout.height)
  return (
    <View
      pointerEvents="box-none"
      onLayout={onLayout}
      style={{
        position: 'absolute',
        left: DOCK_SIDE,
        right: DOCK_SIDE,
        bottom: 0,
        paddingBottom: bottomInset,
        gap: DOCK_GAP,
      }}
    >
      <StatusLine view={status} />
      {children}
    </View>
  )
})

/** The slot's content until the composer lands: replies happen elsewhere for now. */
export function ReadOnlyBar() {
  const theme = usePhoneTheme()
  return (
    <Glass
      strength="strong"
      shadow="rest"
      radius={26}
      contentStyle={{
        minHeight: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 18,
      }}
    >
      <EyeIcon size={16} color={theme.muted} />
      <AppText variant="text-14-regular" numberOfLines={1} style={{ color: theme.muted, flex: 1 }}>
        Read-only on the phone for now
      </AppText>
    </Glass>
  )
}
