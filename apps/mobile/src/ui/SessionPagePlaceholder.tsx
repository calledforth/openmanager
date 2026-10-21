import { useLocalSearchParams, useRouter } from 'expo-router'
import { CaretLeftIcon } from 'phosphor-react-native'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { IconButton } from './IconButton'
import { ProjectChip } from './ProjectChip'

/** The session page's frame (back, title, project) until the transcript arrives. */
export function SessionPagePlaceholder() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const { externalId } = useLocalSearchParams<{ externalId: string }>()
  const { sessions, workspaces } = useHomeSource()
  const session = sessions.find((s) => s.externalId === externalId)
  const workspace = workspaces.find((w) => w.path === session?.workspacePath)
  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6 }}>
      <View className="flex-row items-center justify-between px-5" style={{ height: 48 }}>
        <IconButton label="Back" onPress={() => router.back()}>
          <CaretLeftIcon size={18} color={theme.fg} />
        </IconButton>
      </View>
      <View className="px-5 pt-0.5">
        {workspace ? <ProjectChip name={workspace.name} /> : null}
        <AppText
          variant="text-20-medium"
          style={{ color: theme.fg, marginTop: 4, letterSpacing: -0.3 }}
        >
          {session?.title ?? 'Session'}
        </AppText>
      </View>
      <View className="flex-1 items-center justify-center px-10">
        <AppText variant="text-14-regular" style={{ color: theme.muted, textAlign: 'center' }}>
          The transcript and the composer arrive with the session page work; the home, inbox and
          search are what this build is for.
        </AppText>
      </View>
    </View>
  )
}
