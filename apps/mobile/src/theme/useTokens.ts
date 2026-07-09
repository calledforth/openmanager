import { basisDark, basisLight, type BasisTokens } from './tokens'
import { useTheme } from './ThemeProvider'

// Resolved raw token values for imperative style objects (SVG icon color,
// markdown-display style maps, reanimated colors) where a Tailwind class won't
// reach. Component chrome should still prefer NativeWind classes.

export function useTokens(): BasisTokens {
  const { resolved } = useTheme()
  return resolved === 'dark' ? basisDark : basisLight
}
