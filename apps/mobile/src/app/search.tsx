import { useRouter } from 'expo-router'
import { MagnifyingGlassIcon, XIcon } from 'phosphor-react-native'
import { useCallback, useMemo, useState } from 'react'
import { ScrollView, TextInput, View } from 'react-native'
import Animated, { Easing, FadeIn } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { chatSearchStatus, useChatSearch } from '@openmanager/app-core/lib/chat-search'

import { AppText } from '../components/ui/AppText'
import { messageHitRowsOf, useChatSearchSources } from '../home/message-search'
import { countEnvironments, homeSessionKey, statusMarkOf, type HomeRow } from '../home/rows'
import { matchesTerms, searchTerms } from '../home/search'
import { sessionRowHref } from '../environment/landing-route'
import { useHomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { useGoBack } from '../ui/goBack'
import { MessageHitRow } from '../ui/MessageHitRow'
import { ProjectMark } from '../ui/ProjectMark'
import { SessionRow } from '../ui/SessionRow'
import { Press } from '../ui/Press'

/**
 * How the messages section and the status line come in: a light fade on
 * the UI thread when they first appear, never per keystroke or per answer.
 */
const SEARCH_FADE = FadeIn.duration(180).easing(Easing.out(Easing.quad))

/**
 * Search is a layer over whatever you were on: the field at the top,
 * results as the standard rows, grouped sessions then projects, matched at
 * once on title and project from what the phone holds. Under them, what
 * was said in the chats: each environment that can (`search.messages`) is
 * asked as typing settles (app-core's `useChatSearch`), one row per session
 * at its best message, a session already listed by its title not repeated.
 */
export default function Search() {
  const router = useRouter()
  const goBack = useGoBack()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const { workspaces, sessions, environments } = useHomeSource()
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

  const sources = useChatSearchSources()
  const search = useChatSearch(query, sources)
  const messages = useMemo(
    () =>
      messageHitRowsOf({
        hits: search.hits,
        sessions,
        listed: new Set(hits.sessions.map((row) => homeSessionKey(row.session))),
        workspaceOf: (session) => byPath.get(session.workspacePath),
      }),
    [search.hits, sessions, hits.sessions, byPath],
  )
  const showEnvironment = useMemo(() => countEnvironments(sessions) > 1, [sessions])
  const environmentName = useCallback(
    (environmentId: string) =>
      environments.find((item) => item.environmentId === environmentId)?.label,
    [environments],
  )
  const status = chatSearchStatus(query, search, sources.length, environmentName)
  const searching = needle && search.pending

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
          placeholder="Search sessions and messages"
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
        <Press
          accessibilityRole="button"
          accessibilityLabel="Close search"
          onPress={goBack}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <XIcon size={18} color={theme.muted} />
        </Press>
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
                    key={`${row.session.environment?.environmentId ?? ''}:${row.session.externalId}`}
                    row={row}
                    onPress={() => router.replace(sessionRowHref(row.session) as never)}
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
                    path={w.path}
                    name={w.name}
                    count={sessionCount(w.path)}
                    onPress={() => setQuery(w.name)}
                  />
                ))}
              </View>
            ) : null}
            {messages.length ? (
              <Animated.View entering={SEARCH_FADE}>
                <SectionLabel
                  trailing={
                    <AppText variant="text-11-regular" style={{ color: theme.muted }}>
                      {String(messages.length)}
                    </AppText>
                  }
                >
                  Messages
                </SectionLabel>
                {messages.map((message) => (
                  <MessageHitRow
                    key={message.key}
                    hit={message}
                    showEnvironment={showEnvironment}
                    onPress={() => router.replace(sessionRowHref(message.row.session) as never)}
                  />
                ))}
              </Animated.View>
            ) : null}
            {!hits.sessions.length && !hits.projects.length && !messages.length ? (
              // "Searching…" holds the place "Nothing matches" takes, fainter
              // because it is passing.
              <AppText
                variant="text-14-regular"
                style={{
                  color: searching ? theme.faint : theme.muted,
                  textAlign: 'center',
                  paddingTop: 40,
                }}
              >
                {searching ? 'Searching…' : `Nothing matches “${query.trim()}”.`}
              </AppText>
            ) : null}
            {status ? (
              <Animated.View entering={SEARCH_FADE}>
                <AppText
                  accessibilityRole="text"
                  accessibilityLiveRegion="polite"
                  variant="text-12-regular"
                  style={{ color: theme.muted, paddingHorizontal: 12, paddingTop: 14 }}
                >
                  {status}
                </AppText>
              </Animated.View>
            ) : null}
          </>
        ) : (
          <>
            <SectionLabel>Projects</SectionLabel>
            {workspaces.map((w) => (
              <ProjectRow
                key={w.path}
                path={w.path}
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
  path,
  name,
  count,
  onPress,
}: {
  path: string
  name: string
  count: number
  onPress?: () => void
}) {
  const theme = usePhoneTheme()
  return (
    <Press
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
      <ProjectMark workspaceId={path} size={24} />
      <AppText variant="text-14-medium" style={{ color: theme.fg, flex: 1 }}>
        {name}
      </AppText>
      <AppText variant="text-12-regular" style={{ color: theme.faint }}>
        {count} {count === 1 ? 'session' : 'sessions'}
      </AppText>
    </Press>
  )
}
