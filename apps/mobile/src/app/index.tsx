import { useRouter } from 'expo-router'
import { DesktopIcon, PlusIcon, QrCodeIcon } from 'phosphor-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutAnimation, SectionList, View, type SectionListRenderItem } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut as FadeAway } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { DraftDiscardToast, homeDockClearance } from '../draft/DraftDiscard'
import {
  countEnvironments,
  homeSessionKey,
  homeSummary,
  listShapeOf,
  selectDraftRows,
  selectHomeBoard,
  selectHomeSections,
  SETTLED_PAGE_SIZE,
  statusMarkOf,
  type HomeListRow,
  type HomeRow,
  type HomeSection,
  type HomeSession,
  type HomeShelf,
} from '../home/rows'
import { setShelfOpen, useShelvesOpen } from '../home/shelves'
import { SessionActionsSheet } from '../session/SessionActionsSheet'
import { phoneConnectionView } from '../environment/connection-ui'
import { draftRowHref, sessionRowHref } from '../environment/landing-route'
import { usePhoneConnection } from '../environment/PhoneEnvironmentProvider'
import { useHomeSource } from '../home/source'
import { ActionButton } from '../pairing/ActionButton'
import { ConnectionPanel } from '../settings/ConnectionPanel'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { UpdateNotice } from '../updates/UpdateRow'
import { FadeOut, PageTitle, SectionLabel } from '../ui/chrome'
import { DraftRow } from '../ui/DraftRow'
import { Glass, GlassContent } from '../ui/Glass'
import { HomeDock } from '../ui/HomeDock'
import { Screen } from '../ui/Screen'
import { SessionCard, ShelfHeader, ShelfMore, ShelfRow } from '../ui/SessionCard'
import { StatusMark } from '../ui/StatusMark'

type ListRow = HomeListRow
type ListSection = Omit<HomeSection, 'rows'> & { data: ListRow[] }

/**
 * The home with nothing paired: the one thing to do is pair with the
 * computer the sessions live on.
 */
function PairFirst({ again, onPair }: { again: string | null; onPair: () => void }) {
  const theme = usePhoneTheme()
  return (
    <View className="items-center px-10 pt-20">
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 22,
          backgroundColor: theme.hover,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
        }}
      >
        <DesktopIcon size={32} color={theme.muted} />
      </View>
      <AppText variant="text-16-medium" style={{ color: theme.fg }}>
        {again ? `Pair again with ${again}` : 'No computer paired yet'}
      </AppText>
      <AppText
        variant="text-13-regular"
        style={{ color: theme.muted, textAlign: 'center', marginTop: 4, marginBottom: 20 }}
      >
        {again
          ? 'This phone no longer has access to it. On the computer, open Settings, then Devices, and pair this phone again.'
          : 'Open OpenManager on your computer, go to Settings, then Devices, and pair this phone. Your sessions stay on that computer; the phone talks to it.'}
      </AppText>
      <View style={{ alignSelf: 'stretch' }}>
        <ActionButton
          label="Pair with your computer"
          icon={<QrCodeIcon size={18} color={theme.actionFg} />}
          onPress={onPair}
        />
      </View>
    </View>
  )
}

const sessionKeyOf = (session: HomeSession) => homeSessionKey(session)

/** Ids are only unique within one environment: a row's key names its environment too. */
const keyOf = (row: ListRow) => {
  switch (row.kind) {
    case 'draft':
      return `draft:${row.draft.environment?.environmentId ?? ''}:${row.draft.draftId}`
    case 'card':
      return `session:${sessionKeyOf(row.root.session)}`
    case 'shelf':
      return `shelf:${sessionKeyOf(row.row.session)}`
    default:
      return 'more'
  }
}

/**
 * Rows coming, going or changing places (a sent draft's card leaving and
 * its session arriving, a discard, a session sent cooking or settled, a
 * shelf folding) ease into place: one native layout animation for that
 * commit, on the UI thread. Never for what a row shows: a streamed token or
 * a preview typed elsewhere changes no row's place.
 */
const ROWS_MOVE = LayoutAnimation.create(200, 'easeInEaseOut', 'opacity')

function useRowsMove(shape: string) {
  const last = useRef(shape)
  if (last.current !== shape) {
    LayoutAnimation.configureNext(ROWS_MOVE)
    last.current = shape
  }
}

/**
 * What the title says beside it: how many sessions wait on you, and how
 * many are at work. Two glyphs and two numbers, nothing when there is
 * neither; the list under it is in the order things happened, so this is
 * where what needs you is counted.
 */
function HomeSummary({ needs, working }: { needs: number; working: number }) {
  const theme = usePhoneTheme()
  if (!needs && !working) return null
  const said = [
    needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : null,
    working ? `${working} working` : null,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <View
      accessible
      accessibilityLabel={said}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}
    >
      {needs ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <StatusMark mark="needs" size={13} />
          <AppText
            variant="text-13-medium"
            style={{ color: theme.muted, fontVariant: ['tabular-nums'] }}
          >
            {needs}
          </AppText>
        </View>
      ) : null}
      {working ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <StatusMark mark="working" size={13} />
          <AppText
            variant="text-13-medium"
            style={{ color: theme.muted, fontVariant: ['tabular-nums'] }}
          >
            {working}
          </AppText>
        </View>
      ) : null}
    </View>
  )
}

const NOTICE_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const NOTICE_OUT = FadeAway.duration(160).easing(Easing.in(Easing.quad))
/** How long a refusal stays said. */
const NOTICE_MS = 5000

/**
 * A command the environment refused, said over the dock for a moment: the
 * row is already back where the environment keeps it, and this is why.
 */
function ActionNotice({ text }: { text: string }) {
  const theme = usePhoneTheme()
  const insets = useSafeAreaInsets()
  return (
    <Animated.View
      pointerEvents="none"
      entering={NOTICE_IN}
      exiting={NOTICE_OUT}
      style={{
        position: 'absolute',
        left: 20,
        right: 20,
        bottom: homeDockClearance(insets.bottom),
        alignItems: 'center',
      }}
    >
      <Glass
        strength="strong"
        shadow="float"
        radius={18}
        contentStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}
      >
        <AppText
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          variant="text-13-regular"
          numberOfLines={3}
          style={{ color: theme.fg, textAlign: 'center' }}
        >
          {text}
        </AppText>
      </Glass>
    </Animated.View>
  )
}

/**
 * The sessions home, as the web sidebar's board: one list. The draft cards
 * come first, under "Drafts"; then every active session as an island, under
 * no heading, pinned ones on top and the rest by their last activity; then
 * the two shelves, Cooking (sent off to work out of sight) and Settled (put
 * away), each folding under its heading. Where the rows span more than one
 * environment each card says where it runs. The dock (Settings, New chat,
 * Search) floats over the end of the list.
 */
export default function SessionsHome() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const source = useHomeSource()
  const { environment, environments, needsPairing, workspaces, sessions, drafts } = source
  const connection = usePhoneConnection()
  const view = phoneConnectionView(connection)
  // Not connected and nothing to show yet: the connection's own state, with
  // its next step, says why the list is empty.
  const showConnection = source.kind === 'environment' && view.ui.kind !== 'ready'
  // Through each card's own environment; absent in the sample home.
  const discardDraft = source.kind === 'environment' ? source.discardDraft : undefined

  const open = useShelvesOpen()
  const [settledShown, setSettledShown] = useState(SETTLED_PAGE_SIZE)
  const summary = useMemo(() => homeSummary(sessions), [sessions])
  const showEnvironment = useMemo(
    () => countEnvironments([...sessions, ...drafts]) > 1,
    [sessions, drafts],
  )
  const board = useMemo(
    () => selectHomeBoard({ sessions, workspaces, environments }),
    [sessions, workspaces, environments],
  )
  const draftRows = useMemo(
    () => selectDraftRows({ drafts, workspaces, environments }),
    [drafts, workspaces, environments],
  )
  const sections = useMemo<ListSection[]>(
    () =>
      selectHomeSections({ board, drafts: draftRows, open, settledShown }).map(
        ({ rows, ...section }) => ({ ...section, data: rows }),
      ),
    [board, draftRows, open, settledShown],
  )
  useRowsMove(listShapeOf(sections, keyOf))
  // Nothing active, but something put away: the shelves say so under a quiet line.
  const caughtUp = sections.length > 0 && board.active.length === 0 && draftRows.length === 0

  // The session a long press opened the actions for, read fresh from the
  // listing while the sheet is up, so it names the session as it is.
  const [actionsId, setActionsId] = useState<string | null>(null)
  const actionsRow = useMemo<HomeRow | null>(() => {
    const session = actionsId ? sessions.find((s) => sessionKeyOf(s) === actionsId) : undefined
    if (!session) return null
    // Its project from its own environment's list: two can hold the same path.
    const projects =
      environments.find((item) => item.environmentId === session.environment?.environmentId)
        ?.workspaces ?? workspaces
    return {
      kind: 'session',
      session,
      workspace: projects.find((w) => w.path === session.workspacePath),
      mark: statusMarkOf(session),
      depth: 0,
    }
  }, [actionsId, environments, sessions, workspaces])
  const closeActions = useCallback(() => setActionsId(null), [])

  // A refused command, said for a moment; a newer one replaces it.
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null)
  const noticeId = useRef(0)
  const sayFailed = useCallback((text: string) => {
    noticeId.current += 1
    setNotice({ id: noticeId.current, text })
  }, [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const openRow = useCallback(
    (row: HomeRow) => router.push(sessionRowHref(row.session) as never),
    [router],
  )
  const openActions = useCallback((row: HomeRow) => setActionsId(sessionKeyOf(row.session)), [])
  const toggleShelf = useCallback((shelf: HomeShelf, wasOpen: boolean) => {
    // Folded and opened again, Settled starts from its first page.
    if (shelf === 'settled' && wasOpen) setSettledShown(SETTLED_PAGE_SIZE)
    setShelfOpen(shelf, !wasOpen)
  }, [])
  const showMore = useCallback(() => setSettledShown((shown) => shown + SETTLED_PAGE_SIZE), [])

  const renderItem = useCallback<SectionListRenderItem<ListRow, ListSection>>(
    ({ item }) => {
      switch (item.kind) {
        case 'draft':
          return (
            <DraftRow
              row={item}
              showEnvironment={showEnvironment}
              onPress={() => router.push(draftRowHref(item.draft) as never)}
              {...(discardDraft ? { onDiscard: () => discardDraft(item.draft) } : {})}
            />
          )
        case 'card':
          return (
            <SessionCard
              card={item}
              showEnvironment={showEnvironment}
              onOpen={openRow}
              onActions={openActions}
            />
          )
        case 'shelf':
          return (
            <ShelfRow
              item={item}
              onPress={() => openRow(item.row)}
              onLongPress={() => openActions(item.row)}
            />
          )
        default:
          return <ShelfMore hidden={item.hidden} onPress={showMore} />
      }
    },
    [discardDraft, openActions, openRow, router, showEnvironment, showMore],
  )

  return (
    <Screen>
      <GlassContent style={{ paddingTop: insets.top + 8 }}>
        <View
          style={{
            height: 48,
            paddingLeft: 24,
            paddingRight: 24,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <PageTitle style={{ fontSize: 26, letterSpacing: -0.5 }}>Sessions</PageTitle>
          <HomeSummary needs={summary.needs} working={summary.working} />
        </View>
        <View className="flex-1">
          <SectionList
            className="flex-1"
            sections={sections}
            keyExtractor={keyOf}
            renderItem={renderItem}
            ListHeaderComponent={
              <>
                <UpdateNotice />
                {caughtUp ? (
                  <AppText
                    variant="text-13-regular"
                    style={{ color: theme.faint, paddingHorizontal: 10, paddingVertical: 14 }}
                  >
                    All caught up.
                  </AppText>
                ) : null}
              </>
            }
            renderSectionHeader={({ section }) =>
              section.shelf ? (
                <ShelfHeader
                  label={section.label ?? ''}
                  head={section.shelf}
                  onToggle={() => toggleShelf(section.shelf!.shelf, section.shelf!.open)}
                />
              ) : section.label ? (
                <SectionLabel>{section.label}</SectionLabel>
              ) : null
            }
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{
              paddingHorizontal: 12,
              paddingTop: 2,
              paddingBottom: insets.bottom + 140,
            }}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              needsPairing ? (
                <PairFirst
                  again={environment?.label ?? null}
                  onPair={() =>
                    router.push(
                      environment
                        ? { pathname: '/pair', params: { again: environment.environmentId } }
                        : '/pair',
                    )
                  }
                />
              ) : showConnection ? (
                <View className="px-2 pt-6">
                  <ConnectionPanel view={view} />
                </View>
              ) : (
                <View className="items-center px-10 pt-24">
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 18,
                      backgroundColor: theme.hover,
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 12,
                    }}
                  >
                    <PlusIcon size={26} color={theme.muted} />
                  </View>
                  <AppText variant="text-16-medium" style={{ color: theme.fg }}>
                    No sessions yet
                  </AppText>
                  <AppText
                    variant="text-13-regular"
                    style={{ color: theme.muted, textAlign: 'center', marginTop: 4 }}
                  >
                    Start one with New chat, or on your computer; it shows up here.
                  </AppText>
                </View>
              )
            }
          />
          <FadeOut />
        </View>
      </GlassContent>
      <HomeDock />
      <DraftDiscardToast />
      {notice ? <ActionNotice key={notice.id} text={notice.text} /> : null}
      {actionsRow ? (
        <SessionActionsSheet
          row={actionsRow}
          showEnvironment={showEnvironment}
          onClose={closeActions}
          onFailed={sayFailed}
        />
      ) : null}
    </Screen>
  )
}
