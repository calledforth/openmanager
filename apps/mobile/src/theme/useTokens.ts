import { useMemo } from 'react'

import { legacyBasis, type BasisTokens } from './tokens'
import { useTheme } from './ThemeProvider'

// The first build's resolved token values, for the screens that still read
// them imperatively (SVG icon colour, markdown style maps). New screens use
// `usePhoneTheme()` from ./ThemeProvider and the NativeWind classes.
export function useTokens(): BasisTokens {
  const { theme } = useTheme()
  return useMemo(() => legacyBasis(theme), [theme])
}
