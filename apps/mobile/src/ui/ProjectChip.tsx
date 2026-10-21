import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'

/**
 * A project's mark: the icon the environment declares once declared project
 * icons reach the phone; until then a square in a colour fixed by the name
 * (`theme.projectMarks`), so a project keeps its colour across screens and
 * devices.
 */
export function projectColor(name: string, marks: readonly string[]): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return marks[hash % marks.length]!
}

export function ProjectSquare({ name, size = 12 }: { name: string; size?: number }) {
  const theme = usePhoneTheme()
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        backgroundColor: projectColor(name, theme.projectMarks),
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
