import { Settings } from 'lucide-react-native'

import { useTokens } from '../theme/useTokens'

// Real lucide gear (Phase 4 replaced the interim View-drawn glyph once
// lucide-react-native / react-native-svg landed).

export function SettingsIcon({ size = 18 }: { size?: number }) {
  const tokens = useTokens()
  return <Settings size={size} color={tokens.textMuted} strokeWidth={2} />
}
