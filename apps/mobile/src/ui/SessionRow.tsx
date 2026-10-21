import { Pressable, View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { formatRelativeTime } from '../lib/relativeTime'
import { statusLineOf, type HomeRow } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { ProjectChip } from './ProjectChip'
import { StatusMark } from './StatusMark'
import { tap } from './haptics'

/** Short ages for a list: "now", "4m", "2h", "3d". */
export function shortAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = now - at
  if (diff < 45_000) return 'now'
  const text = formatRelativeTime(at, now)
  return text.replace(' ago', '')
}

/**
 * One session: the status mark, the title, where it runs and what it is up
 * to, and how long ago. A child sits under its parent with a connector.
 * Fills, not borders: the pressed state is the hover fill, selection the
 * active fill.
 */
export function SessionRow({
  row,
  selected = false,
  onPress,
  onLongPress,
}: {
  row: HomeRow
  selected?: boolean
  onPress?: () => void
  onLongPress?: () => void
}) {
  const theme = usePhoneTheme()
  const { session, workspace, mark, depth } = row
  const title = session.title?.trim() || 'Untitled session'
  const line = session.workspaceUnavailable
    ? 'Project folder is unavailable'
    : statusLineOf(session)
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap()
        onPress?.()
      }}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingRight: 12,
        paddingLeft: depth ? 46 : 12,
        borderRadius: 12,
        backgroundColor: selected ? theme.active : pressed ? theme.hover : 'transparent',
        opacity: session.workspaceUnavailable ? 0.6 : 1,
      })}
    >
      {depth ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 23,
            top: -6,
            bottom: '50%',
            width: 10,
            borderLeftWidth: 1.5,
            borderBottomWidth: 1.5,
            borderColor: theme.rule,
            borderBottomLeftRadius: 6,
          }}
        />
      ) : null}
      <View style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}>
        <StatusMark mark={mark} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText
          variant="text-14-medium"
          numberOfLines={1}
          style={{ color: theme.fg, letterSpacing: -0.1 }}
        >
          {title}
        </AppText>
        <View className="mt-0.5 flex-row items-center gap-1.5">
          {workspace ? <ProjectChip name={workspace.name} /> : null}
          {workspace && line ? (
            <AppText variant="text-12-regular" style={{ color: theme.faint }}>
              ·
            </AppText>
          ) : null}
          {line ? (
            <AppText
              variant="text-12-regular"
              numberOfLines={1}
              style={{ color: theme.muted, flexShrink: 1 }}
            >
              {line}
            </AppText>
          ) : null}
        </View>
      </View>
      <AppText variant="text-12-regular" style={{ color: theme.faint }}>
        {shortAge(session.updatedAt)}
      </AppText>
    </Pressable>
  )
}
