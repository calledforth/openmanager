import type { RefObject } from 'react'
import { AccessibilityInfo, Platform, findNodeHandle } from 'react-native'

/**
 * Move the screen reader's focus to a mounted view (TalkBack, VoiceOver).
 * A frame later, so the view is laid out; nothing on web, where React
 * Native's node handles do not exist. Returns a cancel for an effect.
 */
export function focusAccessibility(ref: RefObject<unknown>): () => void {
  if (Platform.OS === 'web') return () => undefined
  const timer = setTimeout(() => {
    try {
      const node = ref.current ? findNodeHandle(ref.current as never) : null
      if (node) AccessibilityInfo.setAccessibilityFocus(node)
    } catch {
      // Focus is a courtesy; a view that went meanwhile has none to take.
    }
  }, 60)
  return () => clearTimeout(timer)
}

/**
 * Props for the screen under a sheet while it is open: hidden from TalkBack
 * (`no-hide-descendants`) and VoiceOver, so only the sheet can be read and
 * reached. The sheet itself is marked modal as well (`accessibilityViewIsModal`).
 */
export function coveredBySheet(open: boolean) {
  return {
    importantForAccessibility: open ? ('no-hide-descendants' as const) : ('auto' as const),
    accessibilityElementsHidden: open,
  }
}
