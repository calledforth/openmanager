import { GearIcon } from 'phosphor-react-native'

import { useTokens } from '../theme/useTokens'

export function SettingsIcon({ size = 18 }: { size?: number }) {
  const tokens = useTokens()
  return <GearIcon size={size} color={tokens.textMuted} />
}
