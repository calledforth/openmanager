import {
  CaretDownIcon,
  CaretRightIcon,
  GitBranchIcon,
  GitForkIcon,
  PencilSimpleLineIcon,
  PushPinIcon,
  RobotIcon,
} from 'phosphor-react-native'
import { memo } from 'react'
import { StyleSheet, View } from 'react-native'
import { withAlpha } from '@openmanager/app-core/lib/theme-tokens'

import { AppText } from '../components/ui/AppText'
import {
  isPinnedSession,
  statusCountOf,
  statusLineOf,
  type HomeCard,
  type HomeRow,
  type HomeShelfHead,
  type HomeShelfRow,
  type StatusMark as Mark,
} from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import type { PhoneTheme } from '../theme/tokens'
import { EnvironmentTag } from './EnvironmentTag'
import { tap } from './haptics'
import { ISLAND_RADIUS, islandStyle } from './island'
import { Press } from './Press'
import { ProjectChip } from './ProjectChip'
import { ProjectMark } from './ProjectMark'
import { ProviderMark } from './ProviderMark'
import { shortAge } from './SessionRow'
import { StatusMark } from './StatusMark'

const untitled = (title: string | undefined) => title?.trim() || 'Untitled session'

/**
 * What tints a card at rest, as the web sidebar's card does: a session
 * holding an unsent reply reads as a draft; one that finished or failed
 * since you looked carries a wash of its status; one that waits on you a
 * fainter one (web's dither there). Null is the plain island.
 */
export function cardTint(
  theme: PhoneTheme,
  mark: Mark,
  { unsent }: { unsent: boolean },
): string | null {
  if (unsent) return theme.draft.fill
  if (mark === 'done' || mark === 'error') return theme.wash(theme.status[mark])
  if (mark === 'needs' || mark === 'question') {
    return withAlpha(theme.status[mark], theme.colorScheme === 'dark' ? 0.09 : 0.07)
  }
  return null
}

/**
 * The mark a row shows for its state. Kept going only by its subagents, it
 * rests: their count on the card already says so (as web's).
 */
function shownMark(row: HomeRow): Mark {
  return row.mark === 'background' && row.session.inBackgroundForSubagents ? 'idle' : row.mark
}

/** The same row to look at: the session and project it was made from, at the same depth. */
const sameRow = (a: HomeRow, b: HomeRow) =>
  a.session === b.session && a.workspace === b.workspace && a.depth === b.depth && a.mark === b.mark

/**
 * A row's actions for a screen reader, which has no long press: the same
 * sheet, as one of the row's actions.
 */
function actionsFor(onActions: (() => void) | undefined) {
  return onActions
    ? {
        accessibilityActions: [{ name: 'actions', label: 'Session actions' }],
        onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
          if (event.nativeEvent.actionName === 'actions') onActions()
        },
      }
    : {}
}

/** What a row is doing, or how long ago it last did anything, in words. */
function spokenState(row: HomeRow, at: string | number | null | undefined = row.session.updatedAt) {
  const line = shownMark(row) === 'idle' ? null : statusLineOf(row.session)
  if (line) return line
  const age = shortAge(at ?? undefined)
  return age ? (age === 'now' ? 'just now' : `${age} ago`) : null
}

function longPress(onLongPress: (() => void) | undefined) {
  return onLongPress
    ? () => {
        tap()
        onLongPress()
      }
    : undefined
}

/**
 * One active session as an island: its project and what it is doing (or how
 * long ago it last did anything) on the first line, its title, then its
 * tool, its subagents, an unsent reply's pen, its branch, the pin, and,
 * where the home spans more than one, the environment it runs on. Its child
 * sessions ride inside it. A fill with a soft shadow, never an outline; a
 * press deepens it. A long press opens its actions.
 */
export const SessionCard = memo(function SessionCard({
  card,
  showEnvironment = false,
  onOpen,
  onActions,
}: {
  card: HomeCard
  showEnvironment?: boolean
  onOpen: (row: HomeRow) => void
  onActions?: (row: HomeRow) => void
}) {
  const theme = usePhoneTheme()
  const { session, workspace } = card.root
  const mark = shownMark(card.root)
  const unsent = Boolean(session.hasUnsentDraft)
  const pinned = isPinnedSession(session)
  const line = statusLineOf(session)
  const count = statusCountOf(session)
  const tone = mark === 'idle' ? theme.muted : theme.status[mark]
  const tint = cardTint(theme, mark, { unsent })
  const environment = showEnvironment ? session.environment : undefined
  const git = workspace?.git
  const subagents = session.subagentCount ?? 0
  const subagentsLive = session.subagentsLive ?? 0
  const openActions = onActions && (() => onActions(card.root))
  return (
    <View
      style={[
        islandStyle(theme),
        { marginVertical: 5, opacity: session.workspaceUnavailable ? 0.6 : 1 },
      ]}
    >
      {tint ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { borderRadius: ISLAND_RADIUS, backgroundColor: tint }]}
        />
      ) : null}
      <Press
        accessibilityRole="button"
        accessibilityHint={[
          pinned ? 'Pinned.' : null,
          unsent ? 'Has an unsent draft.' : null,
          subagents
            ? `${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}${subagentsLive ? `, ${subagentsLive} running` : ''}.`
            : null,
          onActions ? 'Long press for actions' : null,
        ]
          .filter(Boolean)
          .join(' ')}
        onPress={() => {
          tap()
          onOpen(card.root)
        }}
        onLongPress={longPress(openActions)}
        {...actionsFor(openActions)}
        delayLongPress={320}
        style={({ pressed }) => ({
          gap: 5,
          paddingHorizontal: 16,
          paddingTop: 13,
          paddingBottom: card.children.length ? 9 : 13,
          borderRadius: ISLAND_RADIUS,
          backgroundColor: pressed ? theme.hover : 'transparent',
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 18 }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row' }}>
            {workspace ? (
              <ProjectChip
                name={workspace.name}
                workspaceId={workspace.path}
                scratch={workspace.scratch === true}
              />
            ) : null}
          </View>
          {session.workspaceUnavailable ? (
            <AppText variant="text-12-regular" numberOfLines={1} style={{ color: theme.muted }}>
              Folder unavailable
            </AppText>
          ) : mark !== 'idle' && line ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <StatusMark mark={mark} size={13} />
              <AppText variant="text-12-medium" numberOfLines={1} style={{ color: tone }}>
                {line}
              </AppText>
              {count ? (
                <AppText
                  variant="text-12-regular"
                  style={{ color: tone, opacity: 0.75, fontVariant: ['tabular-nums'] }}
                >
                  · {count}
                </AppText>
              ) : null}
            </View>
          ) : (
            <AppText
              variant="text-12-regular"
              style={{ color: theme.faint, fontVariant: ['tabular-nums'] }}
            >
              {shortAge(session.updatedAt)}
            </AppText>
          )}
        </View>
        <AppText
          variant="text-14-medium"
          numberOfLines={2}
          style={{ color: theme.fg, fontSize: 15, lineHeight: 21, letterSpacing: -0.15 }}
        >
          {untitled(session.title)}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 16 }}>
          <ProviderMark providerId={session.providerId} size={12} />
          {subagents ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <RobotIcon size={12} color={subagentsLive ? theme.status.working : theme.faint} />
              <AppText
                variant="text-12-regular"
                style={{
                  color: subagentsLive ? theme.status.working : theme.faint,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {subagents}
              </AppText>
            </View>
          ) : null}
          {unsent ? (
            <PencilSimpleLineIcon size={12} color={theme.draft.accent} weight="bold" />
          ) : null}
          {git ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 3,
                flexShrink: 2,
                minWidth: 0,
              }}
            >
              {git.worktree ? (
                <GitForkIcon size={12} color={theme.faint} />
              ) : (
                <GitBranchIcon size={12} color={theme.faint} />
              )}
              <AppText
                variant="text-12-regular"
                numberOfLines={1}
                style={{ color: theme.faint, flexShrink: 1 }}
              >
                {git.branch ?? 'detached'}
              </AppText>
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          {environment ? <EnvironmentTag environment={environment} /> : null}
          {pinned ? <PushPinIcon size={12} color={theme.muted} weight="fill" /> : null}
        </View>
      </Press>
      {card.children.length ? (
        <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          {card.children.map((child) => (
            <ChildRow
              key={child.session.externalId}
              row={child}
              onPress={() => onOpen(child)}
              onLongPress={onActions && (() => onActions(child))}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}, sameCard)

/**
 * The home builds its cards anew with every listing; a card is the same to
 * look at while its sessions and their projects are the same objects (each
 * environment's provider keeps an entry the same object while nothing it
 * shows changed) and its handlers are.
 */
function sameCard(
  a: { card: HomeCard; showEnvironment?: boolean; onOpen: unknown; onActions?: unknown },
  b: { card: HomeCard; showEnvironment?: boolean; onOpen: unknown; onActions?: unknown },
) {
  return (
    a.showEnvironment === b.showEnvironment &&
    a.onOpen === b.onOpen &&
    a.onActions === b.onActions &&
    sameRow(a.card.root, b.card.root) &&
    a.card.children.length === b.card.children.length &&
    a.card.children.every((child, index) => sameRow(child, b.card.children[index]!))
  )
}

/** A child session inside its parent's card: its state, its title, its age. */
function ChildRow({
  row,
  onPress,
  onLongPress,
}: {
  row: HomeRow
  onPress: () => void
  onLongPress?: () => void
}) {
  const theme = usePhoneTheme()
  const mark = shownMark(row)
  return (
    <Press
      accessibilityRole="button"
      accessibilityHint={onLongPress ? 'Long press for actions' : undefined}
      onPress={() => {
        tap()
        onPress()
      }}
      onLongPress={longPress(onLongPress)}
      {...actionsFor(onLongPress)}
      delayLongPress={320}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
        minHeight: 36,
        paddingVertical: 6,
        paddingRight: 8,
        // One step per generation, capped so a deep tree still leaves the title room.
        paddingLeft: 8 + 14 * (Math.min(row.depth, 3) - 1),
        borderRadius: 12,
        backgroundColor: pressed ? theme.hover : 'transparent',
      })}
    >
      <View style={{ width: 16, alignItems: 'center' }}>
        <StatusMark mark={mark} size={12} />
      </View>
      <AppText
        variant="text-13-regular"
        numberOfLines={1}
        style={{ color: theme.muted, flex: 1, minWidth: 0 }}
      >
        {untitled(row.session.title)}
      </AppText>
      <AppText
        variant="text-12-regular"
        style={{ color: theme.faint, fontVariant: ['tabular-nums'] }}
      >
        {shortAge(row.session.updatedAt)}
      </AppText>
    </Press>
  )
}

/**
 * A shelf's heading (Cooking, Settled): its name, how many sessions are on
 * it, and, while Cooking is folded, that something on it is still working.
 * A tap folds or unfolds it.
 */
export function ShelfHeader({
  label,
  head,
  onToggle,
}: {
  label: string
  head: HomeShelfHead
  onToggle: () => void
}) {
  const theme = usePhoneTheme()
  const Caret = head.open ? CaretDownIcon : CaretRightIcon
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${head.count}${head.live && !head.open ? `, ${head.live === 'working' ? 'working' : 'working in the background'}` : ''}`}
      accessibilityState={{ expanded: head.open }}
      onPress={() => {
        tap()
        onToggle()
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        minHeight: 40,
        marginTop: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: pressed ? theme.hover : 'transparent',
      })}
    >
      <AppText variant="text-13-medium" style={{ color: theme.muted }}>
        {label}
      </AppText>
      <AppText
        variant="text-13-regular"
        style={{ color: theme.faint, fontVariant: ['tabular-nums'] }}
      >
        {head.count}
      </AppText>
      {head.live && !head.open ? <StatusMark mark={head.live} size={12} /> : null}
      <View style={{ flex: 1 }} />
      <Caret size={13} color={theme.faint} weight="bold" />
    </Press>
  )
}

/**
 * A one-line row of Cooking or Settled, as web's shelf row: the project it
 * is in, what it was, and either what it is doing or when it was last
 * touched (put away, for a settled one). Flat on the canvas: what is put
 * away does not float. A long press opens its actions, where it is brought
 * back.
 */
export const ShelfRow = memo(
  function ShelfRow({
    item,
    onOpen,
    onActions,
  }: {
    item: HomeShelfRow
    onOpen: (row: HomeRow) => void
    onActions?: (row: HomeRow) => void
  }) {
    const theme = usePhoneTheme()
    const { row, shelf } = item
    const { session, workspace, depth } = row
    const mark = shownMark(row)
    const unsent = Boolean(session.hasUnsentDraft)
    const putAwayAt =
      shelf === 'settled' ? (session.settledAt ?? session.updatedAt) : session.updatedAt
    const state = spokenState(row, putAwayAt)
    const onPress = () => onOpen(row)
    const onLongPress = onActions && (() => onActions(row))
    return (
      <Press
        accessibilityRole="button"
        accessibilityLabel={`${untitled(session.title)}${workspace ? ` in ${workspace.name}` : ''}${session.environment ? ` on ${session.environment.label}` : ''}${state ? `, ${state}` : ''}${unsent ? ', has an unsent draft' : ''}`}
        accessibilityHint={onLongPress ? 'Long press for actions' : undefined}
        {...actionsFor(onLongPress)}
        onPress={() => {
          tap()
          onPress()
        }}
        onLongPress={longPress(onLongPress)}
        delayLongPress={320}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 42,
          paddingVertical: 8,
          paddingRight: 10,
          paddingLeft: 10 + 16 * Math.min(depth, 3),
          borderRadius: 12,
          backgroundColor: pressed ? theme.hover : 'transparent',
          opacity: session.workspaceUnavailable ? 0.6 : 1,
        })}
      >
        <View style={{ width: 16, alignItems: 'center' }}>
          {depth > 0 ? (
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: theme.faint }} />
          ) : (
            <ProjectMark
              workspaceId={workspace?.path ?? null}
              size={14}
              color={theme.muted}
              scratch={workspace?.scratch === true}
            />
          )}
        </View>
        <AppText
          variant="text-14-regular"
          numberOfLines={1}
          style={{ color: theme.muted, flexShrink: 1, minWidth: 0 }}
        >
          {untitled(session.title)}
        </AppText>
        {unsent ? (
          <PencilSimpleLineIcon size={12} color={theme.draft.accent} weight="bold" />
        ) : null}
        <View style={{ flex: 1 }} />
        {mark !== 'idle' ? (
          <StatusMark mark={mark} size={12} />
        ) : (
          <AppText
            variant="text-12-regular"
            style={{ color: theme.faint, fontVariant: ['tabular-nums'] }}
          >
            {shortAge(putAwayAt)}
          </AppText>
        )}
      </Press>
    )
  },
  (a, b) =>
    a.onOpen === b.onOpen &&
    a.onActions === b.onActions &&
    a.item.shelf === b.item.shelf &&
    sameRow(a.item.row, b.item.row),
)

/** The end of a long Settled shelf: shows the next page. */
export function ShelfMore({ hidden, onPress }: { hidden: number; onPress: () => void }) {
  const theme = usePhoneTheme()
  return (
    <Press
      accessibilityRole="button"
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        minHeight: 42,
        justifyContent: 'center',
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: pressed ? theme.hover : 'transparent',
      })}
    >
      <AppText variant="text-13-medium" style={{ color: theme.muted }}>
        Show more
        <AppText variant="text-13-regular" style={{ color: theme.faint }}>
          {`  ${hidden} left`}
        </AppText>
      </AppText>
    </Press>
  )
}
