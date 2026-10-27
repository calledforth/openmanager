import { CaretLeftIcon } from 'phosphor-react-native'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { GlassContent } from './Glass'
import { useGoBack } from './goBack'
import { IconButton } from './IconButton'
import { ProjectChip } from './ProjectChip'
import { Screen, ScreenBar } from './Screen'

/**
 * The draft page's frame (back, title, project) with no environment to
 * write to: nothing paired yet, a refused token, or the sample home.
 */
export function DraftPagePlaceholder({ draftId }: { draftId?: string }) {
  const goBack = useGoBack()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const { drafts, workspaces } = useHomeSource()
  const draft = draftId ? drafts.find((d) => d.draftId === draftId) : undefined
  const workspace = draft?.workspaceId
    ? workspaces.find((w) => w.path === draft.workspaceId)
    : undefined
  const title = draftId ? draft?.preview || 'Draft' : 'New session'
  return (
    <Screen>
      <ScreenBar
        top={insets.top + 6}
        height={48}
        left={
          <IconButton label="Back" onPress={goBack}>
            <CaretLeftIcon size={18} color={theme.fg} />
          </IconButton>
        }
      />
      <GlassContent style={{ paddingTop: insets.top + 6 }}>
        <View style={{ height: 48 }} />
        <View className="px-5 pt-0.5">
          {workspace ? <ProjectChip name={workspace.name} /> : null}
          <AppText
            variant="text-20-medium"
            numberOfLines={2}
            style={{ color: theme.fg, marginTop: 4, letterSpacing: -0.3 }}
          >
            {title}
          </AppText>
        </View>
        <View className="flex-1 items-center justify-center px-10">
          <AppText variant="text-14-regular" style={{ color: theme.muted, textAlign: 'center' }}>
            Pair an environment from Settings to start a session from the phone.
          </AppText>
        </View>
      </GlassContent>
    </Screen>
  )
}
