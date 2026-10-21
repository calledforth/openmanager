import { useRouter } from 'expo-router'
import { CheckIcon } from 'phosphor-react-native'
import { useCallback, useMemo, useState } from 'react'
import { SectionList, View, type SectionListRenderItem } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../../components/ui/AppText'
import { statusMarkOf, type HomeRow } from '../../home/rows'
import { useHomeSource } from '../../home/source'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { BigTitle, FadeOut, SectionLabel } from '../../ui/chrome'
import { SegmentedTabs } from '../../ui/SegmentedTabs'
import { SessionRow } from '../../ui/SessionRow'

type InboxTab = 'needs' | 'done' | 'failed'
type InboxSection = { key: string; label: string; data: HomeRow[] }

const EMPTY_COPY: Record<InboxTab, string> = {
  needs:
    "Nothing is waiting on you. You'll hear from a session here when it needs you or finishes.",
  done: 'Nothing finished since you last looked.',
  failed: 'Nothing has failed.',
}

/**
 * Everything waiting on you: permissions, questions and plans first, then
 * what finished since you looked, then what failed. Answering from the row
 * arrives with the interactions issue; today a row opens its session.
 */
export default function Inbox() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const { environment, connected, workspaces, sessions } = useHomeSource()
  const [tab, setTab] = useState<InboxTab>('needs')

  const byPath = useMemo(() => new Map(workspaces.map((w) => [w.path, w])), [workspaces])
  const sections = useMemo(() => {
    const all: HomeRow[] = sessions.map((session) => ({
      kind: 'session',
      session,
      workspace: byPath.get(session.workspacePath),
      mark: statusMarkOf(session),
      depth: 0,
    }))
    const nonEmpty = (list: InboxSection[]) => list.filter((section) => section.data.length > 0)
    return {
      needs: nonEmpty([
        {
          key: 'permissions',
          label: 'Permissions',
          data: all.filter((r) => r.mark === 'needs' && r.session.waitingOn !== 'plan'),
        },
        { key: 'questions', label: 'Questions', data: all.filter((r) => r.mark === 'question') },
        {
          key: 'plans',
          label: 'Plans',
          data: all.filter((r) => r.mark === 'needs' && r.session.waitingOn === 'plan'),
        },
      ]),
      done: nonEmpty([
        { key: 'done', label: 'Done · unseen', data: all.filter((r) => r.mark === 'done') },
      ]),
      failed: nonEmpty([
        { key: 'failed', label: 'Failed', data: all.filter((r) => r.mark === 'error') },
      ]),
    } satisfies Record<InboxTab, InboxSection[]>
  }, [sessions, byPath])

  const countOf = (key: InboxTab) =>
    sections[key].reduce((total, section) => total + section.data.length, 0)
  const needsCount = countOf('needs')
  const doneCount = countOf('done')
  const failedCount = countOf('failed')

  const renderItem = useCallback<SectionListRenderItem<HomeRow, InboxSection>>(
    ({ item }) => (
      <SessionRow
        row={item}
        onPress={() => router.push(`/session/${encodeURIComponent(item.session.externalId)}`)}
      />
    ),
    [router],
  )

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6 }}>
      {/* "Mark all seen" returns once it acknowledges on the server (acknowledgeSessionDone). */}
      <BigTitle
        title="Inbox"
        count={needsCount || undefined}
        environment={environment ? { label: environment.label, connected } : null}
      />
      <SegmentedTabs
        tabs={[
          { key: 'needs', label: 'Needs you', count: needsCount || undefined },
          { key: 'done', label: 'Done', count: doneCount || undefined },
          { key: 'failed', label: 'Failed', count: failedCount || undefined },
        ]}
        value={tab}
        onChange={setTab}
      />
      <View className="flex-1">
        {sections[tab].length === 0 ? (
          <View className="flex-1 items-center justify-center px-10 pb-32">
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: theme.statusWash.done,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 10,
              }}
            >
              <CheckIcon size={28} color={theme.status.done} weight="bold" />
            </View>
            <AppText variant="text-20-medium" style={{ color: theme.fg }}>
              All clear
            </AppText>
            <AppText
              variant="text-14-regular"
              style={{ color: theme.muted, textAlign: 'center', marginTop: 4 }}
            >
              {EMPTY_COPY[tab]}
            </AppText>
          </View>
        ) : (
          <SectionList
            className="flex-1"
            sections={sections[tab]}
            keyExtractor={(row) => row.session.externalId}
            renderItem={renderItem}
            renderSectionHeader={({ section }) => <SectionLabel>{section.label}</SectionLabel>}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 140 }}
            showsVerticalScrollIndicator={false}
          />
        )}
        <FadeOut />
      </View>
    </View>
  )
}
