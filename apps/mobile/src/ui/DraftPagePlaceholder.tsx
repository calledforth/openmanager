import { CaretLeftIcon } from 'phosphor-react-native'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { useGoBack } from './goBack'
import { IconButton } from './IconButton'
import { ProjectChip } from './ProjectChip'

/**
 * The draft page's frame (back, title, project) until the composer arrives:
 * a new session from the compose button, or a draft opened from its row.
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
    <View className="flex-1" style={{ paddingTop: insets.top + 6 }}>
      <View className="flex-row items-center justify-between px-5" style={{ height: 48 }}>
        <IconButton label="Back" onPress={goBack}>
          <CaretLeftIcon size={18} color={theme.fg} />
        </IconButton>
      </View>
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
          Writing and sending arrive with the composer and the draft page; until then, start a
          session on your computer and it shows up on the home.
        </AppText>
      </View>
    </View>
  )
}
