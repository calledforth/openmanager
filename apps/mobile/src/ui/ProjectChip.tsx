import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'

/**
 * A project's mark: the icon the environment declares once CAL-201 icons
 * reach the phone; until then a square in a colour fixed by the name, so a
 * project keeps its colour across screens and devices.
 */
const PALETTE = [
  '#4f8ff7',
  '#e0a04f',
  '#9b6bd6',
  '#4a9d7a',
  '#c0565a',
  '#3fa7b8',
  '#b58a3c',
  '#7a7fd1',
]

export function projectColor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]!
}

export function ProjectSquare({ name, size = 12 }: { name: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        backgroundColor: projectColor(name),
      }}
    />
  )
}

export function ProjectChip({ name, muted = true }: { name: string; muted?: boolean }) {
  const theme = usePhoneTheme()
  return (
    <View className="flex-row items-center gap-1.5">
      <ProjectSquare name={name} />
      <AppText
        variant="text-12-regular"
        numberOfLines={1}
        style={{ color: muted ? theme.muted : theme.fg }}
      >
        {name}
      </AppText>
    </View>
  )
}
