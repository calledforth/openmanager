import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { ProjectMark } from './ProjectMark'

export { projectColor, ProjectSquare } from './ProjectMark'

/**
 * A project's name with its mark: the icon its folder declares (as web's
 * sidebar and the project picker show it) when the chip knows which project
 * it is (`workspaceId`, the project's path), else the square in the colour
 * its name fixes.
 */
export function ProjectChip({
  name,
  workspaceId = null,
  muted = true,
  size = 12,
}: {
  name: string
  workspaceId?: string | null
  muted?: boolean
  size?: number
}) {
  const theme = usePhoneTheme()
  return (
    <View className="flex-row items-center gap-1.5" style={{ flexShrink: 1 }}>
      <ProjectMark workspaceId={workspaceId} name={name} size={size} />
      <AppText
        variant="text-12-regular"
        numberOfLines={1}
        style={{ color: muted ? theme.muted : theme.fg, flexShrink: 1 }}
      >
        {name}
      </AppText>
    </View>
  )
}
