import { CaretLeftIcon } from 'phosphor-react-native'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { useEnvironmentLabel, useEnvironmentStatus } from '../environment/PhoneEnvironmentProvider'
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
export function DraftPagePlaceholder({
  draftId,
  environmentId,
}: {
  draftId?: string
  /** The environment the address names; absent on the sample home. */
  environmentId?: string
}) {
  const goBack = useGoBack()
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
          {workspace ? <ProjectChip name={workspace.name} workspaceId={workspace.path} /> : null}
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
            {words}
          </AppText>
        </View>
      </GlassContent>
    </Screen>
  )
}
