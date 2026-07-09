import { TouchableOpacity, View } from 'react-native'

import type { SessionOverview } from '../data/useSessionsOverview'
import { formatRelativeTime } from '../lib/relativeTime'
import { StatusDot } from './StatusDot'
import { AppText } from './ui/AppText'

// A single session row on the home screen. Flat surface, 1px borderMuted,
// radius 6, per plan §4. Status dot sits left of a 1-line title; `waiting`
// additionally surfaces a "needs approval" pill in destructive-muted styling.

export function SessionCard({
  session,
  workspaceName,
  onPress,
  onLongPress,
}: {
  session: SessionOverview
  workspaceName: string
  onPress: () => void
  onLongPress: () => void
}) {
  const title = session.title?.trim() ? session.title : 'Untitled session'
  const isWaiting = session.status === 'waiting'

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      onLongPress={onLongPress}
      className="rounded border border-borderMuted bg-surface px-3.5 py-3"
    >
      <View className="flex-row items-center gap-2">
        <StatusDot active={session.isActive} />
        <AppText variant="text-13-medium" numberOfLines={1} className="flex-1 text-textStrong">
          {title}
        </AppText>
        {isWaiting && (
          <View className="rounded border border-destructive px-1.5 py-0.5">
            <AppText variant="text-10-medium" className="text-destructive">
              needs approval
            </AppText>
          </View>
        )}
      </View>

      <View className="mt-1.5 flex-row items-center gap-2 pl-[15px]">
        <AppText
          variant="text-11-regular"
          numberOfLines={1}
          className="flex-1 text-textMuted"
        >
          {workspaceName}
        </AppText>
        <AppText variant="text-11-regular" className="text-textFaint">
          {formatRelativeTime(session.updatedAt)}
        </AppText>
      </View>
    </TouchableOpacity>
  )
}
