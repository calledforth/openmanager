import { EyeIcon } from 'phosphor-react-native'
import { createContext, memo, useContext, useMemo, useRef, type ReactNode } from 'react'
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
  above = null,
  bottomInset,
  onHeight,
  children,
}: {
  status: StatusLineView | null
  /** Above the status line: the session's background work, when it has any. */
  above?: ReactNode
  /** The safe area below the dock (the home indicator, the gesture bar). */
  bottomInset: number
  onHeight: (height: number) => void
  /** The slot: the composer once it lands. */
  children: ReactNode
}) {
  // While the composer eases a fold, the dock's height changes every frame:
  // it says its new height once, at the start (`hold`), and nothing per frame.
  const measured = useRef(0)
  const reported = useRef(0)
  const held = useRef(false)
  const control = useMemo<DockHold>(() => {
    const report = (height: number) => {
      reported.current = height
      onHeight(height)
    }
    return {
      report,
      hold(delta) {
        held.current = true
        report(reported.current + delta)
      },
      release() {
        held.current = false
        report(measured.current)
      },
    }
  }, [onHeight])
  const onLayout = (event: LayoutChangeEvent) => {
    measured.current = event.nativeEvent.layout.height
    if (!held.current) control.report(measured.current)
  }
  return (
    <DockHoldContext.Provider value={control}>
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
        {above}
        <StatusLine view={status} />
        {children}
      </View>
    </DockHoldContext.Provider>
  )
})

/** How the slot's content keeps an easing height from being reported per frame. */
export interface DockHold {
  report(height: number): void
  /** Report the dock `delta` taller now, and hold back the heights measured until `release`. */
  hold(delta: number): void
  /** Report the dock's measured height again. */
  release(): void
}

export const DockHoldContext = createContext<DockHold | null>(null)

/** The dock's hold, for what eases its height; null outside a dock. */
export const useDockHold = () => useContext(DockHoldContext)

/**
 * Where the page's dock goes, for a composer drawn over the whole page (its
 * sheets cover the header too): the status line, the room under the dock, and
 * where to say how tall it is. The composer renders the `SessionDock` itself
 * with these.
 */
export interface DockSlot {
  status: StatusLineView | null
  above?: ReactNode
  bottomInset: number
  onHeight: (height: number) => void
  /** A layer of the composer covers the page: the page hides itself from a screen reader. */
  onCovered: (covered: boolean) => void
}

export const DockSlotContext = createContext<DockSlot | null>(null)

export function useDockSlot(): DockSlot {
  const slot = useContext(DockSlotContext)
  if (!slot) throw new Error('useDockSlot must be used inside a session page')
  return slot
}

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
