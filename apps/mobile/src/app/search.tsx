import { useRouter } from 'expo-router'
import { ClockIcon, MagnifyingGlassIcon } from 'phosphor-react-native'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AppText } from '../components/ui/AppText'
import { statusMarkOf, type HomeRow } from '../home/rows'
import { matchesTerms, searchTerms } from '../home/search'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { ProjectSquare } from '../ui/ProjectChip'
import { SessionRow } from '../ui/SessionRow'

/**
 * Search is a layer over whatever you were on: the field at the top,
 * results as the standard rows, grouped sessions then projects. Title and
 * project only, which is what the environment indexes.
 */
export default function Search() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const { workspaces, sessions } = useHomeSource()
  const [query, setQuery] = useState('')
  const terms = useMemo(() => searchTerms(query), [query])
  const needle = terms.length > 0

  const byPath = useMemo(() => new Map(workspaces.map((w) => [w.path, w])), [workspaces])
  const hits = useMemo(() => {
    if (!needle) return { sessions: [] as HomeRow[], projects: workspaces }
    const rows: HomeRow[] = sessions
      .filter((s) => matchesTerms(terms, s.title, byPath.get(s.workspacePath)?.name))
      .map((session) => ({
        kind: 'session' as const,
        session,
        workspace: byPath.get(session.workspacePath),
        mark: statusMarkOf(session),
        depth: 0,
      }))
    return {
      sessions: rows,
      projects: workspaces.filter((w) => matchesTerms(terms, w.name)),
    }
  }, [needle, terms, sessions, workspaces, byPath])

  const sessionCount = (path: string) => sessions.filter((s) => s.workspacePath === path).length

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6 }}>
      <View
        className="mx-5 mt-1.5 flex-row items-center gap-2.5 rounded-2xl px-3.5 py-2.5"
        style={{ backgroundColor: theme.hover }}
      >
        <MagnifyingGlassIcon size={18} color={theme.muted} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder="Search sessions and projects"
          placeholderTextColor={theme.faint}
          returnKeyType="search"
          style={{
            flex: 1,
            fontFamily: 'Geist-Regular',
            fontSize: 16,
            color: theme.fg,
            paddingVertical: 2,
          }}
        />
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <AppText variant="text-14-regular" style={{ color: theme.muted }}>
            Cancel
          </AppText>
        </Pressable>
      </View>
      <ScrollView
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: 8,
          paddingTop: 8,
          paddingBottom: insets.bottom + 40,
        }}
      >
        {needle ? (
          <>
            {hits.sessions.length ? (
              <View>
                <SectionLabel
                  trailing={
                    <AppText variant="text-11-regular" style={{ color: theme.muted }}>
                      {String(hits.sessions.length)}
                    </AppText>
                  }
                >
                  Sessions
                </SectionLabel>
                {hits.sessions.map((row) => (
                  <SessionRow
                    key={row.session.externalId}
                    row={row}
                    onPress={() =>
                      router.replace(`/session/${encodeURIComponent(row.session.externalId)}`)
                    }
                  />
                ))}
              </View>
            ) : null}
            {hits.projects.length ? (
              <View>
                <SectionLabel>Projects</SectionLabel>
                {hits.projects.map((w) => (
                  <ProjectRow
                    key={w.path}
                    name={w.name}
                    count={sessionCount(w.path)}
                    onPress={() => setQuery(w.name)}
                  />
                ))}
              </View>
            ) : null}
            {!hits.sessions.length && !hits.projects.length ? (
              <AppText
                variant="text-14-regular"
                style={{ color: theme.muted, textAlign: 'center', paddingTop: 40 }}
              >
                Nothing matches "{query.trim()}"
              </AppText>
            ) : null}
          </>
        ) : (
          <>
            <SectionLabel>Recent</SectionLabel>
            {['tool payloads', 'pricing', 'soul id'].map((term) => (
              <Pressable
                key={term}
                onPress={() => setQuery(term)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderRadius: 12,
                  backgroundColor: pressed ? theme.hover : 'transparent',
                })}
              >
                <ClockIcon size={15} color={theme.faint} />
                <AppText variant="text-14-regular" style={{ color: theme.muted }}>
                  {term}
                </AppText>
              </Pressable>
            ))}
            <SectionLabel>Projects</SectionLabel>
            {workspaces.map((w) => (
              <ProjectRow
                key={w.path}
                name={w.name}
                count={sessionCount(w.path)}
                onPress={() => setQuery(w.name)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  )
}

function ProjectRow({
  name,
  count,
  onPress,
}: {
  name: string
  count: number
  onPress?: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        backgroundColor: pressed ? theme.hover : 'transparent',
      })}
    >
      <ProjectSquare name={name} size={24} />
      <AppText variant="text-14-medium" style={{ color: theme.fg, flex: 1 }}>
        {name}
      </AppText>
      <AppText variant="text-12-regular" style={{ color: theme.faint }}>
        {count} {count === 1 ? 'session' : 'sessions'}
      </AppText>
    </Pressable>
  )
}
