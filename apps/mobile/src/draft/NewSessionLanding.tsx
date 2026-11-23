import { CaretDownIcon, DesktopIcon, FolderPlusIcon, XIcon } from 'phosphor-react-native'
import { ScrollView, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut } from 'react-native-reanimated'
import { isNoProject, type WorkspaceEntry } from '@openmanager/app-core/logic'

import { ShimmerText } from '../components/chat/ShimmerText'
import { AppText } from '../components/ui/AppText'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { tap } from '../ui/haptics'
import { Press } from '../ui/Press'
import { NoProjectMark } from '../ui/NoProjectMark'
import { ProjectMark } from '../ui/ProjectMark'
import { recentChipsOf } from './recent-chips'

/** A notice fades in and out, short and eased, on the UI thread. */
const NOTICE_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const NOTICE_OUT = FadeOut.duration(150).easing(Easing.in(Easing.quad))

/** What a move between environments said, with a way to put it away. */
function MoveNotice({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const theme = usePhoneTheme()
  return (
    <Animated.View
      entering={NOTICE_IN}
      exiting={NOTICE_OUT}
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 8,
        paddingLeft: 12,
        paddingRight: 6,
        borderRadius: 12,
        backgroundColor: theme.hover,
      }}
    >
      <AppText variant="text-12-regular" style={{ color: theme.muted, flex: 1 }}>
        {message}
      </AppText>
      {onDismiss ? (
        <Press
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={8}
          onPress={onDismiss}
          style={({ pressed }) => ({
            width: 24,
            height: 24,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? theme.active : 'transparent',
          })}
        >
          <XIcon size={12} color={theme.faint} weight="bold" />
        </Press>
      ) : null}
    </Animated.View>
  )
}

/** The environment the page runs on, as a pill that opens the picker when there is a choice. */
function EnvironmentPill({ label, onPress }: { label: string; onPress?: () => void }) {
  const theme = usePhoneTheme()
  if (!onPress) {
    return (
      <View className="flex-row items-center" style={{ gap: 5, flexShrink: 1 }}>
        <DesktopIcon size={12} color={theme.faint} />
        <AppText
          variant="text-12-regular"
          numberOfLines={1}
          style={{ color: theme.faint, flexShrink: 1 }}
        >
          {label}
        </AppText>
      </View>
    )
  }
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={`Environment: ${label}`}
      accessibilityHint="Pick the environment this session runs on"
      onPress={() => {
        tap()
        onPress()
      }}
      hitSlop={8}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        flexShrink: 1,
        paddingVertical: 4,
        paddingLeft: 8,
        paddingRight: 7,
        borderRadius: 999,
        backgroundColor: pressed ? theme.active : theme.hover,
      })}
    >
      <DesktopIcon size={12} color={theme.muted} />
      <AppText
        variant="text-12-regular"
        numberOfLines={1}
        style={{ color: theme.muted, flexShrink: 1 }}
      >
        {label}
      </AppText>
      <CaretDownIcon size={10} color={theme.faint} weight="bold" />
    </Press>
  )
}

/**
 * No project to start in yet: the page asks for one first.
 */
export function StartWithProject({
  environmentLabel,
  onAdd,
  onStartWithoutProject,
  onPickEnvironment,
  notice = null,
  onDismissNotice,
}: {
  environmentLabel: string | null
  /** Add project; absent where the environment cannot. */
  onAdd?: () => void
  /** Start in "No project"; absent where the environment offers none. */
  onStartWithoutProject?: () => void
  /** Run it on another environment; absent with one saved. */
  onPickEnvironment?: () => void
  /** What a move between environments said. */
  notice?: string | null
  onDismissNotice?: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <View className="flex-1 items-center justify-center px-10">
      {notice ? (
        <View style={{ alignSelf: 'stretch', marginBottom: 16 }}>
          <MoveNotice message={notice} onDismiss={onDismissNotice} />
        </View>
      ) : null}
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
      {onStartWithoutProject ? (
        <Press
          accessibilityRole="button"
          accessibilityLabel="Start without a project"
          accessibilityHint="The session runs in a folder of its own"
          onPress={() => {
            tap()
            onStartWithoutProject()
          }}
          style={({ pressed }) => ({
            marginTop: 10,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 9,
            paddingHorizontal: 14,
            borderRadius: 999,
            backgroundColor: pressed ? theme.active : 'transparent',
          })}
        >
          <NoProjectMark size={15} color={theme.muted} />
          <AppText variant="text-14-medium" style={{ color: theme.muted }}>
            Start without a project
          </AppText>
        </Press>
      ) : null}
      {environmentLabel ? (
        <View style={{ marginTop: 18 }}>
          <EnvironmentPill label={environmentLabel} onPress={onPickEnvironment} />
        </View>
      ) : null}
    </View>
  )
}

/**
 * The top of a new session's page, as web's landing says it: "Let's build in"
 * the draft's project, which opens the project picker; the environment it
 * runs on, which opens the environment picker where there is a choice; why
 * the draft cannot go, if it cannot; and the recent projects, one tap away.
 */
export function NewSessionHead({
  environmentLabel,
  workspace,
  loading,
  note,
  recents = [],
  onPick,
  onPickRecent,
  onPickEnvironment,
  notice = null,
  onDismissNotice,
}: {
  environmentLabel: string | null
  /** The draft's project; absent while none is picked (or it was removed). */
  workspace: WorkspaceEntry | undefined
  /** The projects, or the draft the address names, are still on their way. */
  loading: boolean
  /** Why the draft cannot go as it stands. */
  note: string | null
  /** The environment's recent projects, newest first. */
  recents?: readonly WorkspaceEntry[]
  onPick: () => void
  onPickRecent?: (path: string) => void
  /** Pick another environment; absent with one saved. */
  onPickEnvironment?: () => void
  /** What a move between environments said. */
  notice?: string | null
  onDismissNotice?: () => void
}) {
  const theme = usePhoneTheme()
  if (loading) {
    return (
      <View style={{ paddingHorizontal: 22, paddingTop: 12, paddingBottom: 6, gap: 10 }}>
        <ShimmerText variant="text-14-regular">Opening your workspace…</ShimmerText>
        {environmentLabel ? (
          <View className="flex-row">
            <EnvironmentPill label={environmentLabel} onPress={onPickEnvironment} />
          </View>
        ) : null}
      </View>
    )
  }
  const name = workspace?.name ?? 'Pick a project'
  const chips = onPickRecent ? recentChipsOf(recents, workspace?.path) : []
  return (
    <View style={{ paddingTop: 6, paddingBottom: 6, gap: 10 }}>
      {notice ? (
        <View style={{ paddingHorizontal: 16 }}>
          <MoveNotice message={notice} onDismiss={onDismissNotice} />
        </View>
      ) : null}
      <View className="flex-row flex-wrap items-center" style={{ gap: 6, paddingHorizontal: 22 }}>
        <AppText variant="text-16-medium" style={{ color: theme.fg }}>
          {isNoProject(workspace) ? 'Let’s build with' : 'Let’s build in'}
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
          {workspace ? <ProjectMark workspaceId={workspace.path} size={14} /> : null}
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
        <View className="flex-row flex-wrap items-center" style={{ gap: 6, paddingHorizontal: 22 }}>
          {environmentLabel ? (
            <EnvironmentPill label={environmentLabel} onPress={onPickEnvironment} />
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
      {chips.length > 0 ? (
        <ScrollView
          horizontal
          accessibilityLabel="Recent projects"
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          contentContainerStyle={{ gap: 6, paddingHorizontal: 22 }}
        >
          {chips.map((chip) => (
            <Press
              key={chip.path}
              accessibilityRole="button"
              accessibilityLabel={`Build in ${chip.name}`}
              onPress={() => {
                tap()
                onPickRecent?.(chip.path)
              }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                maxWidth: 180,
                paddingVertical: 5,
                paddingLeft: 8,
                paddingRight: 10,
                borderRadius: 999,
                backgroundColor: pressed ? theme.active : theme.hover,
              })}
            >
              <ProjectMark workspaceId={chip.path} size={12} />
              <AppText
                variant="text-12-regular"
                numberOfLines={1}
                style={{ color: theme.muted, flexShrink: 1 }}
              >
                {chip.name}
              </AppText>
            </Press>
          ))}
        </ScrollView>
      ) : null}
    </View>
  )
}
