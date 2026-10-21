import { useRouter } from 'expo-router'
import { NotePencilIcon, PlusIcon } from 'phosphor-react-native'
import { useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { selectDraftRows, selectHomeRows, tabCounts, type HomeTab } from '../home/rows'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { BigTitle, FadeOut, SectionLabel } from '../ui/chrome'
import { DraftRow } from '../ui/DraftRow'
import { IconButton } from '../ui/IconButton'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { SessionRow } from '../ui/SessionRow'

/**
 * The sessions home: big title with the environment under it, All · Active
 * · Drafts, rows grouped by what they are doing (Active) or by day (All).
 * The floating pill nav is drawn by the root layout over this.
 */
export default function SessionsHome() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const { environment, connected, workspaces, sessions, drafts } = useHomeSource()
  const [tab, setTab] = useState<HomeTab>('all')

  const counts = useMemo(() => tabCounts(sessions, drafts), [sessions, drafts])
  const sessionGroups = useMemo(
    () => (tab === 'drafts' ? [] : selectHomeRows({ sessions, workspaces, tab })),
    [sessions, workspaces, tab],
  )
  const draftGroups = useMemo(
    () => (tab === 'drafts' ? selectDraftRows({ drafts, workspaces }) : []),
    [drafts, workspaces, tab],
  )

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6 }}>
      <BigTitle
        title="Sessions"
        environment={
          environment
            ? {
                label: environment.label,
                detail: environment.route.kind === 'local' ? 'LAN' : 'Tunnel',
                connected,
              }
            : null
        }
        trailing={
          <IconButton label="New session" onPress={() => router.push('/search')}>
            <NotePencilIcon size={18} color={theme.fg} />
          </IconButton>
        }
      />
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
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 140 }}
          showsVerticalScrollIndicator={false}
        >
          {tab === 'drafts'
            ? draftGroups.map((group) => (
                <View key={group.key}>
                  <SectionLabel>{group.label}</SectionLabel>
                  {group.rows.map((row) => (
                    <DraftRow key={row.draft.draftId} row={row} />
                  ))}
                </View>
              ))
            : sessionGroups.map((group) => (
                <View key={group.key}>
                  <SectionLabel>{group.label}</SectionLabel>
                  {group.rows.map((row) => (
                    <SessionRow
                      key={row.session.externalId}
                      row={row}
                      onPress={() =>
                        router.push(`/session/${encodeURIComponent(row.session.externalId)}`)
                      }
                    />
                  ))}
                </View>
              ))}
          {tab !== 'drafts' && sessionGroups.length === 0 ? (
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
                Start one from the compose button, or on your computer; it shows up here.
              </AppText>
            </View>
          ) : null}
        </ScrollView>
        <FadeOut />
      </View>
    </View>
  )
}
