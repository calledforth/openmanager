import { PencilSimpleLineIcon } from 'phosphor-react-native'
import { View } from 'react-native'

import { AppText } from '../components/ui/AppText'
import { formatRelativeTime } from '../lib/relativeTime'
import { statusCountOf, statusLineOf, type HomeRow, type StatusMark as Mark } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import type { PhoneTheme } from '../theme/tokens'
import { ProjectChip } from './ProjectChip'
import { StatusMark } from './StatusMark'
import { tap } from './haptics'
import { Press } from './Press'

/** Short ages for a list: "now", "4m", "2h", "3d", from an ISO time or epoch ms. */
export function shortAge(when: string | number | undefined, now = Date.now()): string {
  if (when === undefined || when === '') return ''
  const at = typeof when === 'number' ? when : Date.parse(when)
  if (!Number.isFinite(at) || at <= 0) return ''
  const diff = now - at
  if (diff < 45_000) return 'now'
  const text = formatRelativeTime(at, now)
  return text.replace(' ago', '')
}

/**
 * The fill a card takes at rest, as the web sidebar's `cardFillClass`: a
 * session holding an unsent reply reads as a draft; one that finished or
 * failed since you looked carries a wash of its status; the rest sit on the
 * canvas. Null is the canvas.
 */
export function rowFill(
  theme: PhoneTheme,
  mark: Mark,
  { unsent, settled }: { unsent: boolean; settled: boolean },
): string | null {
  if (unsent && !settled) return theme.draft.fill
  if (mark === 'done') return theme.wash(theme.status.done)
  if (mark === 'error') return theme.wash(theme.status.error)
  return null
}

/**
 * One session: the status mark, the title, where it runs and what it is up
 * to (in the state's colour, as the web sidebar says it), and how long ago.
 * A child sits under its parent with a connector. Fills, not borders: the
 * pressed state is the hover fill, selection the active fill, and a card at
 * rest takes its status wash or the draft fill (`rowFill`). A session whose
 * composer holds an unsent reply carries web's pen, in the draft accent,
 * beside its age. A long press opens its actions.
 */
const INDENT = 34

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
  const unsent = Boolean(session.hasUnsentDraft)
  const line = session.workspaceUnavailable
    ? 'Project folder is unavailable'
    : statusLineOf(session)
  const count = session.workspaceUnavailable ? null : statusCountOf(session)
  const tone = mark === 'idle' ? theme.muted : theme.status[mark]
  const rest = rowFill(theme, mark, { unsent, settled: !!session.settledAt })
  // One step per generation, capped so a deep tree still leaves the title room.
  const indent = INDENT * Math.min(depth, 2)
  return (
    <Press
      accessibilityRole="button"
      accessibilityHint={unsent ? 'Has an unsent draft. Long press for actions' : 'Long press for actions'}
      onPress={() => {
        tap()
        onPress?.()
      }}
      onLongPress={
        onLongPress
          ? () => {
              tap()
              onLongPress()
            }
          : undefined
      }
      delayLongPress={320}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingRight: 12,
        paddingLeft: 12 + indent,
        borderRadius: 14,
        marginVertical: 1,
        backgroundColor: selected
          ? theme.active
          : pressed
            ? unsent && !session.settledAt
              ? theme.draft.hover
              : theme.hover
            : (rest ?? 'transparent'),
        opacity: session.workspaceUnavailable ? 0.6 : 1,
      })}
    >
      {depth ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: indent - 11,
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
          {workspace ? (
            <ProjectChip name={workspace.name} workspaceId={workspace.path} />
          ) : null}
          {workspace && line ? (
            <AppText variant="text-12-regular" style={{ color: theme.faint }}>
              ·
            </AppText>
          ) : null}
          {line ? (
            <AppText
              variant={mark === 'idle' ? 'text-12-regular' : 'text-12-medium'}
              numberOfLines={1}
              style={{ color: session.workspaceUnavailable ? theme.muted : tone, flexShrink: 1 }}
            >
              {line}
            </AppText>
          ) : null}
          {count ? (
            <AppText
              variant="text-12-regular"
              style={{ color: tone, opacity: 0.75, fontVariant: ['tabular-nums'] }}
            >
              · {count}
            </AppText>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        {unsent ? (
          <PencilSimpleLineIcon size={13} color={theme.draft.accent} weight="bold" />
        ) : null}
        <AppText variant="text-12-regular" style={{ color: theme.faint }}>
          {shortAge(session.updatedAt)}
        </AppText>
      </View>
    </Press>
  )
}
