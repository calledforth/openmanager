import { useRouter } from 'expo-router'
import { DesktopIcon, NotePencilIcon, PlusIcon, QrCodeIcon } from 'phosphor-react-native'
import { useCallback, useMemo, useRef, useState } from 'react'
import { LayoutAnimation, SectionList, View, type SectionListRenderItem } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useSidebarDrafts } from '@openmanager/app-core/providers/sidebar-provider'

import { AppText } from '../../components/ui/AppText'
import { DraftDiscardToast } from '../../draft/DraftDiscard'
import {
  listShapeOf,
  selectDraftRows,
  selectHomeRows,
  tabCounts,
  type HomeDraftRow,
  type HomeRow,
  type HomeTab,
} from '../../home/rows'
import { phoneConnectionView } from '../../environment/connection-ui'
import { usePhoneConnection } from '../../environment/PhoneEnvironmentProvider'
import { useHomeSource } from '../../home/source'
import { ActionButton } from '../../pairing/ActionButton'
import { ConnectionPanel } from '../../settings/ConnectionPanel'
import { useTitleEnvironment } from '../../settings/title-environment'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { BigTitle, FadeOut, SectionLabel } from '../../ui/chrome'
import { DraftRow } from '../../ui/DraftRow'
import { GlassContent } from '../../ui/Glass'
import { IconButton } from '../../ui/IconButton'
import { Screen, ScreenBar } from '../../ui/Screen'
import { SegmentedTabs } from '../../ui/SegmentedTabs'
import { SessionRow } from '../../ui/SessionRow'

type ListRow = HomeRow | HomeDraftRow
type ListSection = { key: string; label: string; data: ListRow[] }

const EMPTY: Record<HomeTab, { title: string; body: string }> = {
  all: {
    title: 'No sessions yet',
    body: 'Start one from the compose button, or on your computer; it shows up here.',
  },
  active: {
    title: 'Nothing active',
    body: 'Every session is settled. New work and anything that needs you shows up here.',
  },
  drafts: {
    title: 'No drafts',
    body: 'A message you start and leave unsent waits here.',
  },
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

const keyOf = (row: ListRow) =>
  row.kind === 'draft' ? `draft:${row.draft.draftId}` : `session:${row.session.externalId}`

/**
 * Rows coming, going or changing places (a sent draft leaving Drafts and its
 * session arriving in Active, a discard, a session moving to Needs you) ease
 * into place: one native layout animation for that commit, on the UI thread.
 * Never for a tab switch, and never for what a row shows: a streamed token
 * or a preview typed elsewhere changes no row's place.
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
 * The sessions home: big title with the environment under it, All · Active
 * · Drafts, rows grouped by what they are doing (Active) or by day (All).
 * The floating pill nav is the tabs group's tab bar, drawn over this; the
 * compose button floats over the title row.
 */
export default function SessionsHome() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const source = useHomeSource()
  const { environment, needsPairing, workspaces, sessions, drafts } = source
  const titleEnvironment = useTitleEnvironment(source)
  const connection = usePhoneConnection()
  const view = phoneConnectionView(connection)
  // Not connected and nothing to show yet: the connection's own state, with
  // its next step, says why the list is empty.
  const showConnection = source.kind === 'environment' && view.ui.kind !== 'ready'
  const [tab, setTab] = useState<HomeTab>('all')
  // Null on a host without draft cards and in the sample home.
  const sidebarDrafts = useSidebarDrafts()
  const discardDraft = source.kind === 'environment' ? sidebarDrafts?.discardDraft : undefined

  const counts = useMemo(() => tabCounts(sessions, drafts), [sessions, drafts])
  const sections = useMemo<ListSection[]>(() => {
    const groups =
      tab === 'drafts'
        ? selectDraftRows({ drafts, workspaces })
        : selectHomeRows({ sessions, workspaces, tab })
    return groups.map((group) => ({ key: group.key, label: group.label, data: group.rows }))
  }, [sessions, drafts, workspaces, tab])
  useRowsMove(tab, listShapeOf(sections, keyOf))

  const renderItem = useCallback<SectionListRenderItem<ListRow, ListSection>>(
    ({ item }) =>
      item.kind === 'draft' ? (
        <DraftRow
          row={item}
          onPress={() => router.push(`/draft/${encodeURIComponent(item.draft.draftId)}`)}
          {...(discardDraft ? { onDiscard: () => discardDraft(item.draft.draftId) } : {})}
        />
      ) : (
        <SessionRow
          row={item}
          onPress={() => router.push(`/session/${encodeURIComponent(item.session.externalId)}`)}
        />
      ),
    [discardDraft, router],
  )

  const empty = EMPTY[tab]

  return (
    <Screen tab="index">
      <ScreenBar
        top={insets.top + 6}
        height={44}
        right={
          <IconButton label="New session" onPress={() => router.push('/draft/new')}>
            <NotePencilIcon size={18} color={theme.fg} />
          </IconButton>
        }
      />
      <GlassContent style={{ paddingTop: insets.top + 6 }}>
        <BigTitle title="Sessions" environment={titleEnvironment} />
        <SegmentedTabs
          tabs={[
            { key: 'all', label: 'All' },
            { key: 'active', label: 'Active', count: counts.active },
            { key: 'drafts', label: 'Drafts', count: counts.drafts },
          ]}
          value={tab}
          onChange={setTab}
        />
        <View className="flex-1">
          <SectionList
            className="flex-1"
            sections={sections}
            keyExtractor={keyOf}
            renderItem={renderItem}
            renderSectionHeader={({ section }) => <SectionLabel>{section.label}</SectionLabel>}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 140 }}
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
      <DraftDiscardToast />
    </Screen>
  )
}
