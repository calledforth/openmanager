import { CaretDownIcon, DesktopIcon, FolderPlusIcon } from 'phosphor-react-native'
import { View } from 'react-native'
import type { WorkspaceEntry } from '@openmanager/app-core/logic'

import { ShimmerText } from '../components/chat/ShimmerText'
import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { ProjectMark } from '../ui/ProjectMark'

/**
 * No project to start in yet: the page asks for one first.
 */
export function StartWithProject({
  environmentLabel,
  onAdd,
}: {
  environmentLabel: string | null
  /** Add project; absent where the environment cannot. */
  onAdd?: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <View className="flex-1 items-center justify-center px-10">
      <AppText variant="text-16-medium" style={{ color: theme.fg, textAlign: 'center' }}>
        Start with a project
      </AppText>
      <AppText
        variant="text-13-regular"
        style={{ color: theme.muted, textAlign: 'center', marginTop: 4 }}
      >
        {onAdd
          ? environmentLabel
            ? `Add a folder on ${environmentLabel} to open a fresh session.`
            : 'Add a project to open a fresh session.'
          : 'This environment cannot add projects from here. Add one on your computer.'}
      </AppText>
      {onAdd ? (
        <Press
          accessibilityRole="button"
          accessibilityLabel="Add project"
          onPress={() => {
            tap()
            onAdd()
          }}
          style={({ pressed }) => ({
            marginTop: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 9,
            paddingHorizontal: 14,
            borderRadius: 999,
            backgroundColor: pressed ? theme.active : theme.hover,
          })}
        >
          <FolderPlusIcon size={15} color={theme.fg} />
          <AppText variant="text-14-medium" style={{ color: theme.fg }}>
            Add project
          </AppText>
        </Press>
      ) : null}
    </View>
  )
}

/**
 * The top of a new session's page, as web's landing says it: "Let's build in"
 * the draft's project, which opens the project picker, over the environment
 * it runs on and why the draft cannot go, if it cannot.
 */
export function NewSessionHead({
  environmentLabel,
  workspace,
  loading,
  note,
  onPick,
}: {
  environmentLabel: string | null
  /** The draft's project; absent while none is picked (or it was removed). */
  workspace: WorkspaceEntry | undefined
  /** The projects, or the draft the address names, are still on their way. */
  loading: boolean
  /** Why the draft cannot go as it stands. */
  note: string | null
  onPick: () => void
}) {
  const theme = usePhoneTheme()
  if (loading) {
    return (
      <View style={{ paddingHorizontal: 22, paddingTop: 12, paddingBottom: 6 }}>
        <ShimmerText variant="text-14-regular">Opening your workspace…</ShimmerText>
      </View>
    )
  }
  const name = workspace?.name ?? 'Pick a project'
  return (
    <View style={{ paddingHorizontal: 22, paddingTop: 6, paddingBottom: 6, gap: 8 }}>
      <View className="flex-row flex-wrap items-center" style={{ gap: 6 }}>
        <AppText variant="text-16-medium" style={{ color: theme.fg }}>
          Let’s build in
        </AppText>
        <Press
          accessibilityRole="button"
          accessibilityLabel={`Project: ${name}`}
          accessibilityHint="Pick the project for this session"
          onPress={() => {
            tap()
            onPick()
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            maxWidth: 240,
            paddingVertical: 5,
            paddingLeft: 9,
            paddingRight: 8,
            borderRadius: 999,
            backgroundColor: pressed ? theme.active : theme.hover,
          })}
        >
          {workspace ? (
            <ProjectMark workspaceId={workspace.path} name={workspace.name} size={14} />
          ) : null}
          <AppText
            variant="text-16-medium"
            numberOfLines={1}
            style={{ color: workspace ? theme.fg : theme.muted, flexShrink: 1 }}
          >
            {name}
          </AppText>
          <CaretDownIcon size={12} color={theme.faint} weight="bold" />
        </Press>
      </View>
      {environmentLabel || note ? (
        <View className="flex-row items-center" style={{ gap: 5 }}>
          {environmentLabel ? (
            <>
              <DesktopIcon size={12} color={theme.faint} />
              <AppText
                variant="text-12-regular"
                numberOfLines={1}
                style={{ color: theme.faint, flexShrink: 1 }}
              >
                {environmentLabel}
              </AppText>
            </>
          ) : null}
          {environmentLabel && note ? (
            <AppText variant="text-12-regular" style={{ color: theme.faint }}>
              ·
            </AppText>
          ) : null}
          {note ? (
            <AppText
              variant="text-12-regular"
              numberOfLines={2}
              style={{ color: theme.status.error, flexShrink: 1 }}
            >
              {note}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
