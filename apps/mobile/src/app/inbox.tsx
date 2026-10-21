import { useRouter } from 'expo-router'
import { CheckIcon, ChecksIcon } from 'phosphor-react-native'
import { useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { statusMarkOf, type HomeRow } from '../home/rows'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { BigTitle, FadeOut, SectionLabel } from '../ui/chrome'
import { IconButton } from '../ui/IconButton'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { SessionRow } from '../ui/SessionRow'

type InboxTab = 'needs' | 'done' | 'failed'

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
  const rows = useMemo(() => {
    const toRow = (session: (typeof sessions)[number]): HomeRow => ({
      kind: 'session',
      session,
      workspace: byPath.get(session.workspacePath),
      mark: statusMarkOf(session),
      depth: 0,
    })
    const all = sessions.map(toRow)
    return {
      needs: {
        permissions: all.filter((r) => r.mark === 'needs' && r.session.waitingOn !== 'plan'),
        questions: all.filter((r) => r.mark === 'question'),
        plans: all.filter((r) => r.mark === 'needs' && r.session.waitingOn === 'plan'),
      },
      done: all.filter((r) => r.mark === 'done'),
      failed: all.filter((r) => r.mark === 'error'),
    }
  }, [sessions, byPath])

  const needsCount =
    rows.needs.permissions.length + rows.needs.questions.length + rows.needs.plans.length
  const open = (row: HomeRow) =>
    router.push(`/session/${encodeURIComponent(row.session.externalId)}`)
  const section = (label: string, list: HomeRow[]) =>
    list.length ? (
      <View key={label}>
        <SectionLabel>{label}</SectionLabel>
        {list.map((row) => (
          <SessionRow key={row.session.externalId} row={row} onPress={() => open(row)} />
        ))}
      </View>
    ) : null

  const empty = tab === 'needs' ? needsCount === 0 : rows[tab].length === 0

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6 }}>
      <BigTitle
        title="Inbox"
        count={needsCount || undefined}
        environment={environment ? { label: environment.label, connected } : null}
        trailing={
          rows.done.length ? (
            <IconButton label="Mark all seen">
              <ChecksIcon size={18} color={theme.fg} />
            </IconButton>
          ) : null
        }
      />
      <SegmentedTabs
        tabs={[
          { key: 'needs', label: 'Needs you', count: needsCount || undefined },
          { key: 'done', label: 'Done', count: rows.done.length || undefined },
          { key: 'failed', label: 'Failed', count: rows.failed.length || undefined },
        ]}
        value={tab}
        onChange={setTab}
      />
      <View className="flex-1">
        {empty ? (
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
              {tab === 'needs'
                ? "Nothing is waiting on you. You'll hear from a session here when it needs you or finishes."
                : tab === 'done'
                  ? 'Nothing finished since you last looked.'
                  : 'Nothing has failed.'}
            </AppText>
          </View>
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 140 }}
            showsVerticalScrollIndicator={false}
          >
            {tab === 'needs' ? (
              <>
                {section('Permissions', rows.needs.permissions)}
                {section('Questions', rows.needs.questions)}
                {section('Plans', rows.needs.plans)}
              </>
            ) : (
              section(tab === 'done' ? 'Done · unseen' : 'Failed', rows[tab])
            )}
          </ScrollView>
        )}
        <FadeOut />
      </View>
    </View>
  )
}
