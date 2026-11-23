import type { ViewStyle } from 'react-native'

import type { PhoneTheme } from '../theme/tokens'

/** The corner every island of the home takes. */
export const ISLAND_RADIUS = 20

/**
 * A soft drop under a card, per scheme: a tight contact shadow and a wide,
 * faint one below it. No ring around the card, since a card is a fill and
 * never an outline; in the dark the shadow is deeper, as there is less
 * light to lose.
 */
const ISLAND_SHADOW = {
  light: '0 1px 2px rgba(0, 0, 0, 0.05), 0 8px 20px -8px rgba(0, 0, 0, 0.14)',
  dark: '0 1px 2px rgba(0, 0, 0, 0.34), 0 10px 22px -10px rgba(0, 0, 0, 0.6)',
} as const

/**
 * An island: a card that floats on the canvas. One step above the canvas in
 * the scheme's own surface, rounded, with the soft drop. Opaque, so what
 * tints it (a status wash, the draft fill) is laid over it and the shadow
 * never shows through.
 */
export function islandStyle(theme: PhoneTheme): ViewStyle {
  return {
    borderRadius: ISLAND_RADIUS,
    backgroundColor: theme.surface2,
    boxShadow: ISLAND_SHADOW[theme.colorScheme],
  }
}
