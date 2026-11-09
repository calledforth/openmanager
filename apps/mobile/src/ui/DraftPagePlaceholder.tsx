import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { useEnvironmentLabel, useEnvironmentStatus } from '../environment/PhoneEnvironmentProvider'
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
export function DraftPagePlaceholder({
  draftId,
  environmentId,
}: {
  draftId?: string
  /** The environment the address names; absent on the sample home. */
  environmentId?: string
}) {
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const { drafts, environments, workspaces: everyWorkspace } = useHomeSource()
  const status = useEnvironmentStatus(environmentId)
  const label = useEnvironmentLabel(environmentId)
  // Its own environment's draft: the same id elsewhere is another draft.
  const draft = draftId
    ? drafts.find(
        (d) =>
          d.draftId === draftId &&
          (environmentId === undefined || d.environment?.environmentId === environmentId),
      )
    : undefined
  const workspaces =
    environments.find((item) => item.environmentId === environmentId)?.workspaces ?? everyWorkspace
  const workspace = draft?.workspaceId
    ? workspaces.find((w) => w.path === draft.workspaceId)
    : undefined
  const words =
    environmentId === undefined || status === 'no_environment'
      ? 'Pair an environment from Settings to start a session from the phone.'
      : status === 'unauthorized'
        ? `${label ?? 'This environment'} no longer accepts this phone. Pair it again from Settings.`
        : `Connecting to ${label ?? 'its environment'}…`
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
            {words}
          </AppText>
        </View>
      </GlassContent>
    </Screen>
  )
}
