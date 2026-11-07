import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { useHomeSource } from '../home/source'
import { HeaderSpace, SessionHeaderBar } from '../session/SessionHeader'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { GlassContent } from './Glass'
import { Screen } from './Screen'

/**
 * The draft page's frame (the session page's header: Back, the title with
 * the project under it) with no environment to write to: nothing paired
 * yet, a refused token, or the sample home.
 */
export function DraftPagePlaceholder({ draftId }: { draftId?: string }) {
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
      <SessionHeaderBar
        topInset={insets.top}
        title={title}
        project={workspace?.name}
        projectId={workspace?.path ?? null}
      />
      <GlassContent>
        <HeaderSpace topInset={insets.top} />
        <View className="flex-1 items-center justify-center px-10">
          <AppText variant="text-14-regular" style={{ color: theme.muted, textAlign: 'center' }}>
            Pair an environment from Settings to start a session from the phone.
          </AppText>
        </View>
      </GlassContent>
    </Screen>
  )
}
