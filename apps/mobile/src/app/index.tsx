import { useRouter } from 'expo-router'
import { DesktopIcon, PlusIcon, QrCodeIcon } from 'phosphor-react-native'
import { useCallback, useMemo, useRef, useState } from 'react'
import { LayoutAnimation, SectionList, View, type SectionListRenderItem } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { DraftDiscardToast } from '../draft/DraftDiscard'
import {
  countEnvironments,
  homeSessionKey,
  listShapeOf,
  selectTabRows,
  statusMarkOf,
  tabCounts,
  type HomeListRow,
  type HomeRow,
  type HomeSession,
  type HomeTab,
} from '../home/rows'
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
import { GlassContent } from '../ui/Glass'
import { HomeDock } from '../ui/HomeDock'
import { Screen } from '../ui/Screen'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { SessionRow } from '../ui/SessionRow'

type ListRow = HomeListRow
type ListSection = { key: string; label: string | null; data: ListRow[] }

/** The words for an empty view: nothing at all, nothing active, nothing settled. */
function emptyCopy(tab: HomeTab, sessionCount: number): { title: string; body: string } {
  if (tab === 'settled') {
    return { title: 'Nothing settled', body: 'Sessions you settle wait here.' }
  }
  if (sessionCount === 0) {
    return {
      title: 'No sessions yet',
      body: 'Start one with New chat, or on your computer; it shows up here.',
    }
  }
  return {
    title: 'Nothing active',
    body: 'Every session is settled. New work and anything that needs you shows up here.',
  }
}

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

/** Ids are only unique within one environment: a row's key names its environment too. */
const keyOf = (row: ListRow) =>
  row.kind === 'draft'
    ? `draft:${row.draft.environment?.environmentId ?? ''}:${row.draft.draftId}`
    : `session:${sessionKeyOf(row.session)}`

const sessionKeyOf = (session: HomeSession) => homeSessionKey(session)

/**
 * Rows coming, going or changing places (a sent draft's card leaving and
 * its session arriving under Working, a discard, a session moving to Needs
 * you, a settle) ease into place: one native layout animation for that
 * commit, on the UI thread. Never for a view switch, and never for what a
 * row shows: a streamed token or a preview typed elsewhere changes no row's
 * place.
 */
const ROWS_MOVE = LayoutAnimation.create(200, 'easeInEaseOut', 'opacity')

function useRowsMove(tab: HomeTab, shape: string) {
  const last = useRef({ tab, shape })
  if (last.current.shape !== shape) {
    if (last.current.tab === tab) LayoutAnimation.configureNext(ROWS_MOVE)
    last.current = { tab, shape }
  }
}

/**
 * The sessions home: one title row with the two views (All, what is
 * unsettled; Settled, the long tail), then the rows. All opens with the
 * draft cards, then Pinned, Needs you, Working, Failed, Done and Recent,
 * which is what the inbox listed, in the one place. Where the rows span
 * more than one environment each says where it runs. The dock (Settings,
 * New chat, Search) floats over the end of the list.
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
  const [tab, setTab] = useState<HomeTab>('all')
  // A view opens at its top: the list is the same element for both views,
  // and would otherwise keep the place the other was scrolled to.
  const list = useRef<SectionList<ListRow, ListSection>>(null)
  const changeTab = useCallback((next: HomeTab) => {
    list.current?.getScrollResponder()?.scrollTo({ y: 0, animated: false })
    setTab(next)
  }, [])
  // Through each card's own environment; absent in the sample home.
  const discardDraft = source.kind === 'environment' ? source.discardDraft : undefined

  const counts = useMemo(() => tabCounts(sessions), [sessions])
  const showEnvironment = useMemo(
    () => countEnvironments([...sessions, ...drafts]) > 1,
    [sessions, drafts],
  )
  const sections = useMemo<ListSection[]>(
    () =>
      selectTabRows({ sessions, drafts, workspaces, environments, tab }).map((group) => ({
        key: group.key,
        label: group.label,
        data: group.rows,
      })),
    [sessions, drafts, workspaces, environments, tab],
  )
  useRowsMove(tab, listShapeOf(sections, keyOf))

  // The session a long press opened the actions for, read fresh from the
  // listing while the sheet is up, so a rename shows in it as it lands.
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

  const renderItem = useCallback<SectionListRenderItem<ListRow, ListSection>>(
    ({ item }) =>
      item.kind === 'draft' ? (
        <DraftRow
          row={item}
          showEnvironment={showEnvironment}
          onPress={() => router.push(draftRowHref(item.draft) as never)}
          {...(discardDraft ? { onDiscard: () => discardDraft(item.draft) } : {})}
        />
      ) : (
        <SessionRow
          row={item}
          showEnvironment={showEnvironment}
          onPress={() => router.push(sessionRowHref(item.session) as never)}
          onLongPress={() => setActionsId(sessionKeyOf(item.session))}
        />
      ),
    [discardDraft, router, showEnvironment],
  )

  const empty = emptyCopy(tab, sessions.length)

  return (
    <Screen>
      <GlassContent style={{ paddingTop: insets.top + 6 }}>
        <View
          style={{
            height: 44,
            paddingHorizontal: 20,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <PageTitle>Sessions</PageTitle>
          <SegmentedTabs
            className="flex-row gap-1"
            tabs={[
              { key: 'all', label: 'All', count: counts.all || undefined },
              { key: 'settled', label: 'Settled', count: counts.settled || undefined },
            ]}
            value={tab}
            onChange={changeTab}
          />
        </View>
        <View className="flex-1">
          <SectionList
            ref={list}
            className="flex-1"
            sections={sections}
            keyExtractor={keyOf}
            renderItem={renderItem}
            ListHeaderComponent={<UpdateNotice />}
            renderSectionHeader={({ section }) =>
              section.label ? <SectionLabel>{section.label}</SectionLabel> : null
            }
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{
              paddingHorizontal: 8,
              paddingTop: tab === 'settled' ? 6 : 0,
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
                    {empty.title}
                  </AppText>
                  <AppText
                    variant="text-13-regular"
                    style={{ color: theme.muted, textAlign: 'center', marginTop: 4 }}
                  >
                    {empty.body}
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
      {actionsRow ? <SessionActionsSheet row={actionsRow} onClose={closeActions} /> : null}
    </Screen>
  )
}
