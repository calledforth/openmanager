import { useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { FlatList, ScrollView, TouchableOpacity, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { SessionCard } from '../components/SessionCard'
import { SettingsIcon } from '../components/SettingsIcon'
import { AppText } from '../components/ui/AppText'
import { confirmDestructive, showAlert, showDestructiveActionSheet } from '../lib/dialogs'
import { useSessionActions } from '../data/actions'
import { useMobileClientId } from '../data/client-id'
import { useSessionsOverview, type SessionOverview } from '../data/useSessionsOverview'

const ALL_FILTER = '__all__'

export default function HomeScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const clientId = useMobileClientId()
  const { sessions, workspaces, isLoading } = useSessionsOverview()
  const { deleteSession } = useSessionActions(clientId)

  const [filter, setFilter] = useState<string>(ALL_FILTER)

  const workspaceNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const workspace of workspaces) map.set(workspace.path, workspace.name)
    return map
  }, [workspaces])

  const visibleSessions = useMemo(() => {
    const filtered =
      filter === ALL_FILTER
        ? sessions
        : sessions.filter((session) => session.workspacePath === filter)

    // Active sessions surface to the top; recency (updatedAt desc) within each group.
    return [...filtered].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }, [sessions, filter])

  const onDeleteSession = useCallback(
    (session: SessionOverview) => {
      confirmDestructive({
        title: 'Delete this session?',
        message: 'This removes the session from the desktop app. This cannot be undone.',
        confirmLabel: 'Delete',
        onConfirm: () => {
          deleteSession({
            workspacePath: session.workspacePath,
            sessionExternalId: session.externalId,
          }).catch(() => {
            showAlert('Could not delete session', 'Please try again in a moment.')
          })
        },
      })
    },
    [deleteSession],
  )

  const onLongPressSession = useCallback(
    (session: SessionOverview) => {
      const title = session.title?.trim() ? session.title : 'Untitled session'
      // Long-press is awkward on web: showDestructiveActionSheet skips the
      // two-step sheet there and confirms deletion directly, while keeping the
      // native two-step action-sheet flow on device.
      showDestructiveActionSheet({
        title,
        actionLabel: 'Delete session',
        onSelect: () => onDeleteSession(session),
      })
    },
    [onDeleteSession],
  )

  const onOpenSession = useCallback(
    (session: SessionOverview) => {
      router.push({
        pathname: '/session/[externalId]',
        params: { externalId: session.externalId, workspacePath: session.workspacePath },
      })
    },
    [router],
  )

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
        <AppText variant="text-16-medium" className="text-textStrong">
          OpenManager
        </AppText>
        <TouchableOpacity
          activeOpacity={0.7}
          hitSlop={12}
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <SettingsIcon />
        </TouchableOpacity>
      </View>

      <View className="pb-2">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 6 }}
        >
          <FilterChip
            label="All"
            active={filter === ALL_FILTER}
            onPress={() => setFilter(ALL_FILTER)}
          />
          {workspaces.map((workspace) => (
            <FilterChip
              key={workspace.path}
              label={workspace.name}
              active={filter === workspace.path}
              onPress={() => setFilter(workspace.path)}
            />
          ))}
        </ScrollView>
      </View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center px-8">
          <AppText variant="text-13-regular" className="text-textMuted">
            Loading sessions…
          </AppText>
        </View>
      ) : visibleSessions.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <AppText variant="text-13-regular" className="text-center text-textMuted">
            No sessions yet — start one from the desktop app.
          </AppText>
        </View>
      ) : (
        <FlatList
          data={visibleSessions}
          keyExtractor={(session) => session.externalId}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 4,
            paddingBottom: insets.bottom + 16,
            gap: 8,
          }}
          renderItem={({ item }) => (
            <SessionCard
              session={item}
              workspaceName={workspaceNames.get(item.workspacePath) ?? item.workspacePath}
              onPress={() => onOpenSession(item)}
              onLongPress={() => onLongPressSession(item)}
            />
          )}
        />
      )}
    </View>
  )
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string
  active: boolean
  onPress: () => void
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      className={
        active
          ? 'rounded border border-border bg-tabActiveBg px-3 py-1.5'
          : 'rounded border border-border bg-surfaceElevated px-3 py-1.5'
      }
    >
      <AppText variant="text-11-medium" className={active ? 'text-textStrong' : 'text-textMuted'}>
        {label}
      </AppText>
    </TouchableOpacity>
  )
}
